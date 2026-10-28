// Fake figma global and layers for tests in Node
'use strict';

const mixed = Symbol('mixed');
let seq = 0;

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const styles = {
  'S:h1': { name: 'Heading/H1', type: 'TEXT', description: 'Page heading' },
};

const variables = {
  'V:primary': {
    name: 'Colors/Primary', resolvedType: 'COLOR', variableCollectionId: 'C:1',
    valuesByMode: { m1: { r: 15 / 255, g: 23 / 255, b: 42 / 255, a: 1 } },
    codeSyntax: { WEB: 'var(--primary)' },
  },
  'V:gap': {
    name: 'Spacing/Gap', resolvedType: 'FLOAT', variableCollectionId: 'C:1',
    valuesByMode: { m1: 24 }, codeSyntax: {},
  },
  'V:brand': {
    name: 'Colors/Brand', resolvedType: 'COLOR', variableCollectionId: 'C:1',
    valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'V:blue600' } }, codeSyntax: {},
  },
  'V:blue600': {
    name: 'Blue/600', resolvedType: 'COLOR', variableCollectionId: 'C:1',
    valuesByMode: { m1: { r: 37 / 255, g: 99 / 255, b: 235 / 255, a: 1 } }, codeSyntax: {},
  },
};

// Layers returned by figma.getNodeByIdAsync
const nodesById = {};

const collections = {
  'C:1': { name: 'Tokens', modes: [{ modeId: 'm1', name: 'Light' }], defaultModeId: 'm1' },
};

function installFigma() {
  const calls = { exportAsync: [] };
  global.figma = {
    mixed,
    root: { name: 'Acme Redesign' },
    currentPage: { name: 'Desktop' },
    getStyleByIdAsync: async (id) => styles[id] || null,
    variables: {
      getVariableByIdAsync: async (id) => variables[id] || null,
      getVariableCollectionByIdAsync: async (id) => collections[id] || null,
    },
    getImageByHash: (h) => (h === 'imghash1234567890' ? { getBytesAsync: async () => JPEG } : null),
    getNodeByIdAsync: async (id) => nodesById[id] || null,
  };
  return calls;
}

// props.ax/ay: absolute layer coordinates
function node(type, props, children, calls) {
  props = props || {};
  const n = Object.assign({
    id: 'n' + (++seq), type, name: type.toLowerCase(), visible: true,
    width: 100, height: 100, opacity: 1, blendMode: 'PASS_THROUGH', rotation: 0,
    fills: [], strokes: [], effects: [], exportSettings: [],
  }, props);
  n.absoluteBoundingBox = { x: props.ax || 0, y: props.ay || 0, width: n.width, height: n.height };
  if (children) {
    n.children = children;
    children.forEach((c) => { c.parent = n; });
  }
  n.exportAsync = async (s) => {
    if (calls) calls.exportAsync.push({ id: n.id, name: n.name, settings: s });
    const body = s && s.format === 'SVG' ? '<svg data-id="' + n.name + '"></svg>' : (s ? s.format : 'PNG') + ':' + n.id;
    return Uint8Array.from(Buffer.from(body, 'utf8'));
  };
  n.getCSSAsync = async () => n.css || { width: n.width + 'px', height: n.height + 'px' };
  return n;
}

function solid(r, g, b, extra) {
  return Object.assign({ type: 'SOLID', visible: true, opacity: 1, blendMode: 'NORMAL', color: { r, g, b } }, extra || {});
}

// Test design: a page with Hero (auto-layout) and Footer (Export settings)
function buildPage(calls) {
  const vec = node('VECTOR', { name: 'Path', width: 20, height: 20, ax: 1322, ay: 400, fills: [solid(0, 0, 0)] }, null, calls);
  const icon = node('GROUP', { name: 'Arrow', width: 24, height: 24, ax: 1320, ay: 398 }, [vec], calls);

  const title = node('TEXT', {
    name: 'Title', width: 600, height: 128, ax: 120, ay: 80,
    characters: 'Engineering workflows',
    textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', textAutoResize: 'HEIGHT',
    fontSize: 56, fontName: mixed, textStyleId: mixed, fills: [solid(1, 1, 1)],
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'HUG',
  }, null, calls);
  title.getStyledTextSegments = (fields) => {
    if (fields.indexOf('boundVariables') >= 0) throw new Error('unsupported field');
    return [
      { characters: 'Engineering ', start: 0, end: 12, fontSize: 56, fontName: { family: 'Inter', style: 'Bold' }, fontWeight: 700,
        textDecoration: 'NONE', textCase: 'ORIGINAL', lineHeight: { unit: 'PIXELS', value: 64 }, letterSpacing: { unit: 'PERCENT', value: -2 },
        fills: [solid(1, 1, 1)], hyperlink: null, textStyleId: 'S:h1', fillStyleId: '' },
      { characters: 'workflows', start: 12, end: 21, fontSize: 56, fontName: { family: 'Inter', style: 'Regular' }, fontWeight: 400,
        textDecoration: 'UNDERLINE', textCase: 'ORIGINAL', lineHeight: { unit: 'PIXELS', value: 64 }, letterSpacing: { unit: 'PERCENT', value: -2 },
        fills: [solid(1, 1, 1)], hyperlink: { type: 'URL', value: 'https://example.com/' }, textStyleId: 'S:h1', fillStyleId: '' },
    ];
  };

  const photo = node('RECTANGLE', {
    name: 'Photo', width: 400, height: 300, ax: 920, ay: 80, cornerRadius: 12,
    fills: [{ type: 'IMAGE', visible: true, opacity: 1, blendMode: 'NORMAL', scaleMode: 'FILL', imageHash: 'imghash1234567890' }],
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
  }, null, calls);

  const label = (text) => node('TEXT', {
    name: 'Label', characters: text, width: 80, height: 20, fills: [solid(1, 1, 1)],
    textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT', fontSize: 16,
    fontName: { family: 'Inter', style: 'Medium' },
  }, null, calls);
  const plainSegments = (n) => () => [{ characters: n.characters, start: 0, end: n.characters.length, fontSize: 16,
    fontName: { family: 'Inter', style: 'Medium' }, fontWeight: 500, textDecoration: 'NONE', textCase: 'ORIGINAL',
    lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 }, fills: [solid(1, 1, 1)], hyperlink: null }];

  const defLabel = label('Learn more');
  defLabel.getStyledTextSegments = plainSegments(defLabel);
  const hovLabel = label('Learn more');
  hovLabel.getStyledTextSegments = plainSegments(hovLabel);
  const vDefault = node('COMPONENT', { name: 'State=Default', width: 160, height: 48, fills: [solid(0, 0, 0)], layoutMode: 'HORIZONTAL', itemSpacing: 8,
    paddingTop: 12, paddingRight: 24, paddingBottom: 12, paddingLeft: 24, primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER' }, [defLabel], calls);
  const vHover = node('COMPONENT', { name: 'State=Hover', width: 160, height: 48, ay: 60, fills: [solid(0.2, 0.2, 0.2)], layoutMode: 'HORIZONTAL', itemSpacing: 8,
    paddingTop: 12, paddingRight: 24, paddingBottom: 12, paddingLeft: 24, primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER' }, [hovLabel], calls);
  const set = node('COMPONENT_SET', { name: 'Button', width: 160, height: 108 }, [vDefault, vHover], calls);
  set.defaultVariant = vDefault;
  set.componentPropertyDefinitions = {
    State: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Hover'] },
    'Label#1:0': { type: 'TEXT', defaultValue: 'Learn more' },
  };

  const instLabel = label('Learn more');
  instLabel.getStyledTextSegments = plainSegments(instLabel);
  const button = node('INSTANCE', { name: 'Button', width: 160, height: 48, ax: 120, ay: 400, fills: [solid(0, 0, 0)],
    componentProperties: { State: { type: 'VARIANT', value: 'Default' }, 'Label#1:0': { type: 'TEXT', value: 'Learn more' } } }, [instLabel], calls);
  button.getMainComponentAsync = async () => vDefault;

  const hiddenNote = node('TEXT', { name: 'Hidden note', visible: false, characters: 'hidden', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14 }, null, calls);
  hiddenNote.getStyledTextSegments = () => [{ characters: 'hidden', start: 0, end: 6, fontSize: 14, fontName: { family: 'Inter', style: 'Regular' },
    fontWeight: 400, textDecoration: 'NONE', textCase: 'ORIGINAL', lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PIXELS', value: 0 }, fills: [], hyperlink: null }];

  const hero = node('FRAME', {
    name: 'Hero', width: 1440, height: 800, ax: 0, ay: 0,
    layoutMode: 'HORIZONTAL', layoutWrap: 'NO_WRAP', itemSpacing: 24,
    paddingTop: 80, paddingRight: 120, paddingBottom: 80, paddingLeft: 120,
    primaryAxisAlignItems: 'SPACE_BETWEEN', counterAxisAlignItems: 'CENTER',
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED',
    cornerRadius: mixed, topLeftRadius: 16, topRightRadius: 16, bottomRightRadius: 0, bottomLeftRadius: 0,
    clipsContent: true,
    fills: [solid(15 / 255, 23 / 255, 42 / 255, { boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'V:primary' } } })],
    boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V:gap' } },
    effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12, spread: 0, blendMode: 'NORMAL' }],
    css: { display: 'flex', padding: '80px 120px', background: 'var(--primary, #0F172A)' },
  }, [title, icon, photo, button, hiddenNote], calls);

  const footer = node('FRAME', {
    name: 'Footer', width: 1440, height: 400, ax: 0, ay: 1600,
    layoutSizingHorizontal: 'FILL', layoutSizingVertical: 'FIXED',
    fills: [solid(0.95, 0.95, 0.95)],
    exportSettings: [{ format: 'PNG', suffix: '', constraint: { type: 'SCALE', value: 1 } }],
  }, [], calls);

  const page = node('FRAME', {
    name: 'Home', width: 1440, height: 2000, ax: 0, ay: 0,
    layoutMode: 'VERTICAL', itemSpacing: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
    primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN',
    layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'HUG',
    fills: [solid(1, 1, 1)],
  }, [hero, footer], calls);
  page.parent = { type: 'PAGE', name: 'Desktop' };

  return { page, hero, title, icon, photo, button, hiddenNote, footer, set, vDefault, vHover };
}

module.exports = { installFigma, buildPage, node, solid, mixed, nodesById };
