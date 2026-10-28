// figma-export tests: node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installFigma, buildPage, node } = require('./mock');

const calls = installFigma();
const fx = require('../code.js');

const text = (bytes) => Buffer.from(bytes).toString('utf8');
const findFile = (files, p) => files.find((f) => f.path === p);
const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };
const byName = (tree, name) => { let r = null; walk(tree, (n) => { if (!r && n.name === name) r = n; }); return r; };

test('utf8 matches Buffer for Cyrillic and emoji', () => {
  const s = 'Главная — ok 😀';
  assert.deepEqual(Buffer.from(fx.utf8(s)), Buffer.from(s, 'utf8'));
});

test('crc32 of the reference string', () => {
  assert.equal(fx.crc32(fx.utf8('123456789')), 0xcbf43926);
});

test('slug transliterates and cleans up', () => {
  assert.equal(fx.slug('Главная страница!'), 'glavnaya-stranitsa');
  assert.equal(fx.slug('State=Hover, Size=L'), 'state-hover-size-l');
  assert.equal(fx.slug('***', 'frame'), 'frame');
});

test('zip is readable by Python: Cyrillic names, content, CRC', () => {
  const files = [
    { path: 'manifest.json', data: fx.utf8('{"a":1}') },
    { path: '01-home/sections/01-hero.png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]) },
    { path: 'заметка.txt', data: fx.utf8('привет') },
  ];
  const zip = fx.makeZip(files, new Date(2026, 9, 7, 12, 30, 10));
  const tmp = path.join(os.tmpdir(), 'figma-export-test.zip');
  fs.writeFileSync(tmp, zip);
  const py = [
    'import sys, zipfile, json',
    'z = zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'print(json.dumps({i.filename: z.read(i).hex() for i in z.infolist()}, ensure_ascii=False))',
  ].join('\n');
  const env = Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' });
  let r = null;
  for (const bin of ['python', 'py', 'python3']) {
    r = spawnSync(bin, ['-c', py, tmp], { encoding: 'utf8', env });
    if (!r.error && r.status !== 9009) break;
  }
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  for (const f of files) assert.equal(got[f.path], Buffer.from(f.data).toString('hex'), f.path);
});

test('tree: layout, variables, radius, shadow, CSS', async () => {
  const { page } = buildPage(calls);
  const { tree } = await fx.serializeFrame(page, { css: true, assets: true, hidden: false, variants: true });
  const hero = byName(tree, 'Hero');
  assert.equal(tree.layout.mode, 'VERTICAL');
  assert.equal(hero.layout.mode, 'HORIZONTAL');
  assert.equal(hero.layout.gap, 'auto');
  assert.deepEqual(hero.layout.pad, [80, 120, 80, 120]);
  assert.equal(hero.layout.alignCross, 'CENTER');
  assert.equal(hero.vars.itemSpacing, 'Spacing/Gap');
  assert.deepEqual(hero.fills[0], { color: '#0f172a', var: 'Colors/Primary' });
  assert.deepEqual(hero.radius, [16, 16, 0, 0]);
  assert.deepEqual(hero.size, { h: 'FILL', v: 'FIXED' });
  assert.equal(hero.clip, true);
  assert.equal(hero.effects[0].type, 'shadow');
  assert.equal(hero.effects[0].color, 'rgba(0, 0, 0, 0.25)');
  assert.equal(hero.css.display, 'flex');
  assert.equal(hero.w, 1440);
  const photo = byName(tree, 'Photo');
  assert.equal(photo.x, 920);
  assert.equal(photo.fy, 80);
});

test('text: style segments, link, text style', async () => {
  const { page } = buildPage(calls);
  const { tree } = await fx.serializeFrame(page, { css: true, assets: true, hidden: false, variants: true });
  const t = byName(tree, 'Title').text;
  assert.equal(t.chars, 'Engineering workflows');
  assert.equal(t.segments.length, 2);
  assert.equal(t.segments[0].text, 'Engineering ');
  assert.equal(t.segments[0].font, 'Inter');
  assert.equal(t.segments[0].style, 'Bold');
  assert.equal(t.segments[0].weight, 700);
  assert.equal(t.segments[0].size, 56);
  assert.equal(t.segments[0].lineHeight, 64);
  assert.equal(t.segments[0].letterSpacing, '-2%');
  assert.equal(t.segments[0].color, '#ffffff');
  assert.equal(t.segments[0].textStyle, 'Heading/H1');
  assert.equal(t.segments[1].decoration, 'UNDERLINE');
  assert.equal(t.segments[1].link, 'https://example.com/');
});

test('icon is an SVG without children, photo is the source file', async () => {
  const { page } = buildPage(calls);
  const { tree, files } = await fx.serializeFrame(page, { css: true, assets: true, hidden: false, variants: true });
  const icon = byName(tree, 'Arrow');
  assert.equal(icon.asset, 'assets/icon-arrow.svg');
  assert.equal(icon.children, undefined);
  assert.ok(findFile(files, 'assets/icon-arrow.svg'));
  const photo = byName(tree, 'Photo');
  assert.equal(photo.fills[0].type, 'image');
  assert.equal(photo.fills[0].file, 'assets/img-imghash123.jpg');
  assert.deepEqual(Array.from(findFile(files, 'assets/img-imghash123.jpg').data.slice(0, 2)), [0xff, 0xd8]);
});

test('component instance: set name, variant, properties', async () => {
  const { page } = buildPage(calls);
  const { tree } = await fx.serializeFrame(page, { css: true, assets: true, hidden: false, variants: true });
  const b = byName(tree, 'Button');
  assert.deepEqual(b.comp, { main: 'Button', variant: 'State=Default', props: { State: 'Default', Label: 'Learn more' } });
});

test('hidden layers: skipped, or flagged when the option is on', async () => {
  let r = await fx.serializeFrame(buildPage(calls).page, { css: true, assets: true, hidden: false, variants: true });
  assert.equal(byName(r.tree, 'Hidden note'), null);
  r = await fx.serializeFrame(buildPage(calls).page, { css: true, assets: true, hidden: true, variants: true });
  assert.equal(byName(r.tree, 'Hidden note').hidden, true);
});

test('without CSS and assets: no css and no files', async () => {
  const { tree, files } = await fx.serializeFrame(buildPage(calls).page, { css: false, assets: false, hidden: false, variants: false });
  walk(tree, (n) => assert.equal(n.css, undefined, n.name));
  assert.equal(files.filter((f) => f.path.indexOf('assets/') === 0).length, 0);
});

test('sections: a single wrapper is unwrapped', () => {
  const kids = [1, 2, 3].map((i) => node('FRAME', { name: 'S' + i }, []));
  const wrap = node('FRAME', { name: 'Wrapper' }, kids);
  const root = node('FRAME', { name: 'Root' }, [wrap]);
  assert.deepEqual(fx.sectionNodes(root).map((n) => n.name), ['S1', 'S2', 'S3']);
});

test('full archive: contents, scales, components, tokens, outline', async () => {
  calls.exportAsync.length = 0;
  const p = buildPage(calls);
  const res = await fx.buildExport([p.page], { sectionScale: 2, css: true, assets: true, hidden: false, variants: true }, () => {});
  const paths = res.files.map((f) => f.path);
  const dir = '01-home/';
  for (const want of ['manifest.json', 'tree.json', 'outline.txt', 'tokens.json', 'components.json', 'preview.png',
    'sections/01-hero.png', 'sections/02-footer.png', 'assets/icon-arrow.svg', 'assets/img-imghash123.jpg', 'assets/footer.png',
    'components/button/state-default.png', 'components/button/state-hover.png']) {
    const full = want === 'manifest.json' ? want : dir + want;
    assert.ok(paths.includes(full), 'missing file ' + full + '\n' + paths.join('\n'));
  }
  assert.equal(new Set(paths).size, paths.length, 'duplicate paths');
  assert.match(res.zipName, /^acme-redesign-home-\d{8}-\d{4}\.zip$/);

  const pageCall = calls.exportAsync.find((c) => c.id === p.page.id);
  assert.deepEqual(pageCall.settings.constraint, { type: 'SCALE', value: 1 });
  const heroCall = calls.exportAsync.find((c) => c.id === p.hero.id);
  assert.deepEqual(heroCall.settings.constraint, { type: 'SCALE', value: 2 });

  const comps = JSON.parse(text(findFile(res.files, dir + 'components.json').data));
  const btn = comps.find((c) => c.name === 'Button');
  assert.equal(btn.kind, 'set');
  assert.equal(btn.used, 1);
  assert.equal(btn.default, 'State=Default');
  assert.deepEqual(btn.props.State.options, ['Default', 'Hover']);
  assert.equal(btn.props.Label.type, 'TEXT');
  const hover = btn.variants.find((v) => v.name === 'State=Hover');
  assert.deepEqual(hover.diff.fills, [['#000000'], ['#333333']]);
  assert.equal(hover.png, 'components/button/state-hover.png');

  const tokens = JSON.parse(text(findFile(res.files, dir + 'tokens.json').data));
  const primary = tokens.colors.find((c) => c.value === '#0f172a');
  assert.deepEqual(primary.vars, ['Colors/Primary']);
  const v = tokens.variables.find((x) => x.name === 'Colors/Primary');
  assert.deepEqual(v.values, { Light: '#0f172a' });
  assert.equal(v.css, 'var(--primary)');
  assert.equal(v.collection, 'Tokens');
  assert.deepEqual(tokens.fonts.Inter.sort(), ['Bold', 'Medium', 'Regular']);
  assert.ok(tokens.styles.find((s) => s.name === 'Heading/H1'));
  assert.ok(tokens.typography.find((t) => t.font === 'Inter' && t.style === 'Bold' && t.size === 56));

  const outline = text(findFile(res.files, dir + 'outline.txt').data);
  assert.match(outline, /FRAME "Hero" 1440x800 @0,0/);
  assert.match(outline, /-> assets\/icon-arrow\.svg/);
  assert.match(outline, /<Button: State=Default>/);

  const manifest = JSON.parse(text(findFile(res.files, 'manifest.json').data));
  assert.equal(manifest.file, 'Acme Redesign');
  assert.equal(manifest.frames[0].folder, '01-home');
  assert.equal(manifest.frames[0].sections.length, 2);
  assert.equal(manifest.frames[0].sections[0].file, 'sections/01-hero.png');

  const tree = JSON.parse(text(findFile(res.files, dir + 'tree.json').data));
  assert.equal(tree.name, 'Home');
  assert.deepEqual(byName(tree, 'Footer').exports, ['assets/footer.png']);
});
