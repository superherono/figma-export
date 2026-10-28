// Regression tests for review findings: node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { installFigma, node, solid, nodesById } = require('./mock');

const calls = installFigma();
const fx = require('../code.js');

const FULL = { css: true, assets: true, hidden: false, variants: true, sectionScale: 2 };
const text = (bytes) => Buffer.from(bytes).toString('utf8');
const walk = (n, fn) => { fn(n); (n.children || []).forEach((c) => walk(c, fn)); };
const byName = (tree, name) => { let r = null; walk(tree, (n) => { if (!r && n.name === name) r = n; }); return r; };
const page = (children, extra) => {
  const p = node('FRAME', Object.assign({ name: 'Page', width: 1440, height: 2000 }, extra || {}), children, calls);
  p.parent = { type: 'PAGE', name: 'Desktop' };
  return p;
};
const vector = (name, fill, extra) => node('VECTOR', Object.assign({ name, width: 20, height: 20, fills: [solid.apply(null, fill || [0, 0, 0])] }, extra || {}), null, calls);
const iconGroup = (name, fill) => node('GROUP', { name, width: 24, height: 24 }, [vector('Path', fill)], calls);
const zipFile = (res, p) => res.files.find((f) => f.path === p);

test('a large group of vectors is one SVG illustration', async () => {
  const ill = node('GROUP', { name: 'Hero art', width: 600, height: 400 }, [vector('P1'), vector('P2'), vector('P3')], calls);
  const { tree, files } = await fx.serializeFrame(page([ill]), FULL);
  const n = byName(tree, 'Hero art');
  assert.equal(n.icon, true);
  assert.equal(n.asset, 'assets/illustration-hero-art.svg');
  assert.equal(n.children, undefined);
  assert.equal(files.filter((f) => f.path.endsWith('.svg')).length, 1);
});

test('a row of icons in auto-layout is traversed, each icon exported separately', async () => {
  const row = node('FRAME', { name: 'Socials', width: 184, height: 24, layoutMode: 'HORIZONTAL', itemSpacing: 8 },
    [iconGroup('Tg'), iconGroup('Vk', [0, 0, 1]), iconGroup('Yt', [1, 0, 0])], calls);
  const { tree } = await fx.serializeFrame(page([row]), FULL);
  const n = byName(tree, 'Socials');
  assert.equal(n.icon, undefined);
  assert.equal(n.layout.gap, 8);
  assert.equal(n.children.length, 3);
  assert.ok(n.children.every((c) => c.icon && c.asset));
});

test('a hamburger made of rectangles is an icon; an icon with a photo is not', async () => {
  const rect = (y) => node('RECTANGLE', { name: 'Line', width: 24, height: 2, ay: y, fills: [solid(0, 0, 0)] }, null, calls);
  const burger = node('GROUP', { name: 'Burger', width: 24, height: 18 }, [rect(0), rect(8), rect(16)], calls);
  const avatar = node('FRAME', { name: 'Avatar', width: 48, height: 48,
    fills: [{ type: 'IMAGE', visible: true, scaleMode: 'FILL', imageHash: 'imghash1234567890' }] }, [vector('Badge')], calls);
  const { tree } = await fx.serializeFrame(page([burger, avatar]), FULL);
  assert.equal(byName(tree, 'Burger').icon, true);
  assert.equal(byName(tree, 'Avatar').icon, undefined);
  assert.equal(byName(tree, 'Avatar').children.length, 1);
});

test('colors inside an icon: on the node and in tokens', async () => {
  const res = await fx.buildExport([page([iconGroup('Arrow', [37 / 255, 99 / 255, 235 / 255])])], FULL);
  const tree = JSON.parse(text(zipFile(res, '01-page/tree.json').data));
  assert.deepEqual(byName(tree, 'Arrow').colors, ['#2563eb']);
  const tokens = JSON.parse(text(zipFile(res, '01-page/tokens.json').data));
  assert.ok(tokens.colors.find((c) => c.value === '#2563eb'));
});

test('variant diffs see the color inside an icon', async () => {
  const variant = (name, fill) => node('COMPONENT', { name, width: 40, height: 40 },
    [node('GROUP', { name: 'Glyph', width: 24, height: 24 }, [vector('Path', fill)], calls)], calls);
  const vDef = variant('State=Default', [0, 0, 0]);
  const vHov = variant('State=Hover', [37 / 255, 99 / 255, 235 / 255]);
  const set = node('COMPONENT_SET', { name: 'IconBtn', width: 40, height: 90 }, [vDef, vHov], calls);
  set.defaultVariant = vDef;
  const inst = node('INSTANCE', { name: 'IconBtn', width: 40, height: 40 },
    [node('GROUP', { name: 'Glyph', width: 24, height: 24 }, [vector('Path')], calls)], calls);
  inst.getMainComponentAsync = async () => vDef;
  const res = await fx.buildExport([page([inst])], FULL);
  const comps = JSON.parse(text(zipFile(res, '01-page/components.json').data));
  const hover = comps.find((c) => c.name === 'IconBtn').variants.find((v) => v.name === 'State=Hover');
  assert.deepEqual(hover.diff['Glyph/Path/fills'], [['#000000'], ['#2563eb']]);
});

test('alias variable: its target is listed too', async () => {
  const box = node('FRAME', { name: 'Box', width: 100, height: 100,
    fills: [solid(37 / 255, 99 / 255, 235 / 255, { boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:brand' } } })] }, [], calls);
  const res = await fx.buildExport([page([box])], FULL);
  const tokens = JSON.parse(text(zipFile(res, '01-page/tokens.json').data));
  const names = tokens.variables.map((v) => v.name);
  assert.ok(names.includes('Colors/Brand'));
  assert.ok(names.includes('Blue/600'));
  assert.deepEqual(tokens.variables.find((v) => v.name === 'Colors/Brand').values, { Light: '-> Blue/600' });
});

test('instance properties: same-name keys are kept, INSTANCE_SWAP gives the component name', async () => {
  const arrow = node('COMPONENT', { name: 'Type=Arrow' }, null, calls);
  node('COMPONENT_SET', { name: 'Icons' }, [arrow], calls);
  nodesById['99:1'] = arrow;
  const main = node('COMPONENT', { name: 'Card' }, null, calls);
  const inst = node('INSTANCE', { name: 'Card', width: 300, height: 200, componentProperties: {
    'Show icon#1:0': { type: 'BOOLEAN', value: true },
    'Show icon#2:0': { type: 'BOOLEAN', value: false },
    'Icon#3:0': { type: 'INSTANCE_SWAP', value: '99:1' },
    'Title#4:0': { type: 'TEXT', value: 'Title text' },
  } }, [], calls);
  inst.getMainComponentAsync = async () => main;
  const { tree } = await fx.serializeFrame(page([inst]), FULL);
  assert.deepEqual(byName(tree, 'Card').comp.props, {
    'Show icon#1:0': true, 'Show icon#2:0': false, Icon: 'Icons / Type=Arrow', Title: 'Title text',
  });
});

test('library components without a set: one entry and a warning', async () => {
  const mk = (variant) => {
    const main = node('COMPONENT', { name: variant, remote: true }, null, calls);
    const inst = node('INSTANCE', { name: 'Lib Button', width: 120, height: 40 }, [], calls);
    inst.getMainComponentAsync = async () => main;
    return inst;
  };
  const res = await fx.buildExport([page([mk('State=Default'), mk('State=Hover')])], FULL);
  const comps = JSON.parse(text(zipFile(res, '01-page/components.json').data));
  assert.equal(comps.length, 1);
  assert.deepEqual([comps[0].name, comps[0].used, comps[0].remote], ['Lib Button', 2, true]);
  assert.ok(res.frames[0].warnings.some((w) => /[Ll]ibrary/.test(w) && /Lib Button/.test(w)), res.frames[0].warnings.join('\n'));
});

test('set on another page: the page is loaded before reading variants', async () => {
  let loaded = 0;
  const vDef = node('COMPONENT', { name: 'Size=M', width: 80, height: 32 }, [], calls);
  const set = node('COMPONENT_SET', { name: 'Tag' }, [vDef], calls);
  set.defaultVariant = vDef;
  set.parent = { type: 'PAGE', id: 'p:2', name: 'Components', loadAsync: async () => { loaded++; } };
  const inst = node('INSTANCE', { name: 'Tag', width: 80, height: 32 }, [], calls);
  inst.getMainComponentAsync = async () => vDef;
  await fx.serializeFrame(page([inst]), FULL);
  assert.equal(loaded, 1);
});

test('children of a hidden layer: no CSS and no files', async () => {
  const inner = node('RECTANGLE', { name: 'Inner', width: 50, height: 50,
    exportSettings: [{ format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 1 } }] }, null, calls);
  const box = node('FRAME', { name: 'Hidden box', visible: false, width: 100, height: 100 }, [inner], calls);
  const { tree, files } = await fx.serializeFrame(page([box]), Object.assign({}, FULL, { hidden: true }));
  const n = byName(tree, 'Inner');
  assert.equal(n.css, undefined);
  assert.equal(n.exports, undefined);
  assert.equal(files.length, 0);
});

test('outline does not cut emoji', async () => {
  const t = node('TEXT', { name: 'Long', characters: 'a'.repeat(59) + '😀 tail', width: 600, height: 20 }, null, calls);
  t.getStyledTextSegments = () => [{ characters: t.characters, fontSize: 16, fontName: { family: 'Inter', style: 'Regular' }, fills: [] }];
  const { tree } = await fx.serializeFrame(page([t]), FULL);
  const bytes = fx.utf8(fx.outline(tree));
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
});

test('more than 40 sections: section list but no PNGs', async () => {
  const kids = Array.from({ length: 41 }, (_, i) => node('RECTANGLE', { name: 'R' + i, width: 1440, height: 10, ay: i * 10 }, null, calls));
  const res = await fx.buildExport([page(kids)], FULL);
  const s = res.frames[0].sections;
  assert.equal(s.length, 41);
  assert.equal(s[0].file, null);
  assert.equal(s[0].name, 'R0');
  assert.ok(res.frames[0].warnings.some((w) => /41/.test(w)));
  assert.ok(!res.files.some((f) => f.path.includes('/sections/')));
});

test('warnings: layer names and failure count', async () => {
  const bad = (name) => {
    const g = iconGroup(name);
    g.exportAsync = async () => { throw new Error('boom'); };
    return g;
  };
  const r = await fx.serializeFrame(page([bad('Icon A'), bad('Icon B')]), FULL);
  const w = fx.warningList(r.ctx).find((x) => /SVG/.test(x));
  assert.ok(w && /\(2\)/.test(w) && /Icon A/.test(w) && /Icon B/.test(w), w);
});

test('one failing layer does not abort the export', async () => {
  const broken = node('FRAME', { name: 'Broken', width: 100, height: 100 }, [], calls);
  Object.defineProperty(broken, 'children', { get() { throw new Error('nope'); } });
  const ok = node('FRAME', { name: 'Ok', width: 100, height: 100 }, [], calls);
  const r = await fx.serializeFrame(page([broken, ok]), FULL);
  assert.ok(byName(r.tree, 'Broken').error);
  assert.ok(byName(r.tree, 'Ok'));
  assert.ok(fx.warningList(r.ctx).some((w) => /Broken/.test(w)));
});

test('layout grids, Grid, grid gaps in tokens', async () => {
  const grid = node('FRAME', { name: 'Grid', width: 1200, height: 400, layoutMode: 'GRID', gridRowCount: 2, gridColumnCount: 3,
    gridRowGap: 16, gridColumnGap: 24, gridRowSizes: [{ type: 'HUG' }, { type: 'HUG' }], gridColumnSizes: [{ type: 'FLEX', value: 1 }] }, [], calls);
  const p = page([grid], { layoutGrids: [{ pattern: 'COLUMNS', alignment: 'CENTER', count: 12, gutterSize: 24, sectionSize: 80, offset: 0, visible: true }] });
  const res = await fx.buildExport([p], FULL);
  const tree = JSON.parse(text(zipFile(res, '01-page/tree.json').data));
  assert.deepEqual(tree.grids, [{ pattern: 'COLUMNS', align: 'CENTER', count: 12, gutter: 24, width: 80, offset: 0 }]);
  const g = byName(tree, 'Grid').layout;
  assert.deepEqual([g.rowSizes, g.colSizes], [['hug', 'hug'], ['1fr']]);
  const tokens = JSON.parse(text(zipFile(res, '01-page/tokens.json').data));
  const sp = tokens.spacing.map((s) => s.value);
  assert.ok(sp.includes(16) && sp.includes(24), JSON.stringify(sp));
});

test('photo: crop, scale, filters; effect variables', async () => {
  const photo = node('RECTANGLE', { name: 'Crop', width: 200, height: 200, fills: [{ type: 'IMAGE', visible: true, scaleMode: 'CROP',
    imageHash: 'imghash1234567890', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.1]], rotation: 90,
    filters: { exposure: 0.2, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0 } }],
    effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 1 }, offset: { x: 0, y: 2 }, radius: 4, spread: 0,
      boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:primary' } } }] }, null, calls);
  const plain = node('RECTANGLE', { name: 'Plain', width: 200, height: 200, fills: [{ type: 'IMAGE', visible: true, scaleMode: 'FILL',
    imageHash: 'imghash1234567890', imageTransform: [[1, 0, 0], [0, 1, 0]] }] }, null, calls);
  const { tree } = await fx.serializeFrame(page([photo, plain]), FULL);
  assert.equal(byName(tree, 'Plain').fills[0].transform, undefined);
  const n = byName(tree, 'Crop');
  assert.deepEqual(n.fills[0].transform, [[0.5, 0, 0.25], [0, 0.5, 0.1]]);
  assert.equal(n.fills[0].rotation, 90);
  assert.deepEqual(n.fills[0].filters, { exposure: 0.2 });
  assert.deepEqual(n.effects[0].vars, { color: 'Colors/Primary' });
});

test('getMainComponentAsync hangs: the export continues with a warning', async () => {
  fx.config.mainTimeout = 30;
  const inst = node('INSTANCE', { name: 'Stuck', width: 100, height: 40 }, [], calls);
  inst.getMainComponentAsync = () => new Promise(() => {});
  const r = await fx.serializeFrame(page([inst]), FULL);
  fx.config.mainTimeout = 10000;
  assert.equal(byName(r.tree, 'Stuck').comp.main, undefined);
  assert.ok(fx.warningList(r.ctx).some((w) => /Stuck/.test(w)));
});

test('text on a path (TEXT_PATH) is exported', async () => {
  const tp = node('TEXT_PATH', { name: 'Curve', characters: 'circular', width: 100, height: 100 }, null, calls);
  tp.getStyledTextSegments = () => [{ characters: 'circular', fontSize: 12, fontName: { family: 'Inter', style: 'Regular' }, fills: [] }];
  const { tree } = await fx.serializeFrame(page([tp]), FULL);
  assert.equal(byName(tree, 'Curve').text.chars, 'circular');
});
