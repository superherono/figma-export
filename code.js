// figma-export: exports the selected frames to a zip — layer tree, CSS, tokens, PNG, assets.
// Syntax no newer than ES2017: older versions of the Figma sandbox do not understand ?. and ??.
'use strict';

var VERSION = '1.1.0';
var DEFAULTS = { sectionScale: 2, hidden: false, assets: true, css: true, variants: true };
var config = { mainTimeout: 10000 };
var ICON_MAX = 256;          // larger means an illustration
var SHAPE_ICON_MAX = 48;     // a group of shapes without vectors is an icon only if it is this small
var MAX_SECTIONS = 40;
var MAX_VARIANTS = 40;
var MAX_PNG_SIDE = 8000;
var VECTOR_TYPES = { VECTOR: 1, BOOLEAN_OPERATION: 1, STAR: 1, POLYGON: 1 };
var SHAPE_TYPES = { LINE: 1, ELLIPSE: 1, RECTANGLE: 1 };
var TEXT_TYPES = { TEXT: 1, TEXT_PATH: 1 };
var SEGMENT_FIELDS = ['fontSize', 'fontName', 'fontWeight', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing', 'fills', 'hyperlink'];
var SEGMENT_FIELDS_MID = SEGMENT_FIELDS.concat(['textStyleId', 'fillStyleId', 'listOptions']);
var SEGMENT_FIELDS_FULL = SEGMENT_FIELDS_MID.concat(['boundVariables']);
var SKIP_VAR_KEYS = { fills: 1, strokes: 1, effects: 1, layoutGrids: 1, textRangeFills: 1, componentProperties: 1 };

// ---------- helpers ----------

function get(node, key) { try { return node[key]; } catch (e) { return undefined; } }
function has(node, key) { try { return key in node; } catch (e) { return false; } }
function isMixed(v) { return typeof v === 'symbol' || v === figma.mixed; }
function round(n) { return Math.round(n * 100) / 100; }
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function msg(e) { return e && e.message ? e.message : String(e); }
function visibleNode(n) { return n.visible !== false; }

function stamp(d) {
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
}
function localTime(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// Truncate without splitting a surrogate pair (emoji)
function cut(s, n) {
  if (s.length <= n) return s;
  var c = s.charCodeAt(n - 1);
  if (c >= 0xd800 && c < 0xdc00) n--;
  return s.slice(0, n) + '…';
}

function withTimeout(promise, ms) {
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    promise.then(
      function (v) { clearTimeout(t); resolve(v); },
      function (e) { clearTimeout(t); reject(e); }
    );
  });
}

function hex2(v) { var s = Math.round(v * 255).toString(16); return s.length < 2 ? '0' + s : s; }
function colorStr(c, opacity) {
  var a = (c.a === undefined ? 1 : c.a) * (opacity === undefined ? 1 : opacity);
  a = Math.round(a * 1000) / 1000;
  if (a >= 1) return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
  return 'rgba(' + Math.round(c.r * 255) + ', ' + Math.round(c.g * 255) + ', ' + Math.round(c.b * 255) + ', ' + a + ')';
}

// Cyrillic layer names are transliterated to Latin for file and folder names
var RU = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
var LAT = ['a', 'b', 'v', 'g', 'd', 'e', 'e', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'h', 'ts', 'ch', 'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya'];

function slug(s, fallback) {
  var low = String(s || '').toLowerCase(), out = '';
  for (var i = 0; i < low.length; i++) {
    var k = RU.indexOf(low[i]);
    out += k >= 0 ? LAT[k] : low[i];
  }
  out = out.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (out.length > 40) out = out.slice(0, 40).replace(/-+$/, '');
  return out || fallback || 'item';
}

function uniquer() {
  var used = {};
  return function (base) {
    var name = base, n = 2;
    while (used[name]) name = base + '-' + n++;
    used[name] = true;
    return name;
  };
}

// ---------- bytes: UTF-8, CRC32, zip without compression ----------

// The Figma sandbox has no TextEncoder
function utf8(str) {
  var out = new Uint8Array(str.length * 3), p = 0;
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out[p++] = c;
    else if (c < 0x800) { out[p++] = 0xc0 | (c >> 6); out[p++] = 0x80 | (c & 63); }
    else if (c < 0x10000) { out[p++] = 0xe0 | (c >> 12); out[p++] = 0x80 | ((c >> 6) & 63); out[p++] = 0x80 | (c & 63); }
    else { out[p++] = 0xf0 | (c >> 18); out[p++] = 0x80 | ((c >> 12) & 63); out[p++] = 0x80 | ((c >> 6) & 63); out[p++] = 0x80 | (c & 63); }
  }
  return out.slice(0, p);
}

var CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  var crc = -1;
  for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// files: [{path, data: Uint8Array}]; names in UTF-8 (flag 0x0800)
function makeZip(files, date) {
  date = date || new Date();
  var time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  var day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  var entries = [], size = 0;
  files.forEach(function (f) {
    var name = utf8(f.path);
    entries.push({ name: name, data: f.data, crc: crc32(f.data), offset: size });
    size += 30 + name.length + f.data.length;
  });
  var cdStart = size;
  entries.forEach(function (e) { size += 46 + e.name.length; });
  var out = new Uint8Array(size + 22), view = new DataView(out.buffer), p = 0;
  function u16(v) { view.setUint16(p, v, true); p += 2; }
  function u32(v) { view.setUint32(p, v, true); p += 4; }
  entries.forEach(function (e) {
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0);
    out.set(e.name, p); p += e.name.length;
    out.set(e.data, p); p += e.data.length;
  });
  entries.forEach(function (e) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(time); u16(day);
    u32(e.crc); u32(e.data.length); u32(e.data.length); u16(e.name.length); u16(0); u16(0);
    u16(0); u16(0); u32(0); u32(e.offset);
    out.set(e.name, p); p += e.name.length;
  });
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(size - cdStart); u32(cdStart); u16(0);
  return out;
}

// ---------- export context ----------

function newCache() { return { vars: {}, refs: {}, styles: {}, pages: {} }; }
function newTokens() { return { colors: {}, typography: {}, effects: {}, radii: {}, spacing: {}, fonts: {} }; }

function newCtx(settings, cache, report) {
  return {
    opt: { css: settings.css, assets: settings.assets, hidden: settings.hidden, register: true, iconChildren: false },
    settings: settings, cache: cache, report: report || function () {},
    files: [], names: uniquer(), byContent: {}, images: {},
    tokens: newTokens(), usedVars: {}, usedStyles: {}, components: {},
    warn: {}, count: 0
  };
}

// Component variants: no CSS or files, hidden layers and icon internals included, tokens kept separately
function variantCtx(ctx) {
  return Object.assign({}, ctx, {
    opt: { css: false, assets: false, hidden: true, register: false, iconChildren: true },
    tokens: newTokens(), components: {}, count: 0, report: function () {}
  });
}

// Failures of one kind are collapsed into one line: text, count, first layer names
function warn(ctx, kind, text, name) {
  var w = ctx.warn[kind] || (ctx.warn[kind] = { text: text, count: 0, names: [] });
  w.count++;
  if (name && w.names.indexOf(name) < 0) w.names.push(name);
}

function warningList(ctx) {
  return Object.keys(ctx.warn).map(function (k) {
    var w = ctx.warn[k], s = w.text;
    if (w.count > 1) s += ' (' + w.count + ')';
    if (w.names.length) s += ': ' + w.names.slice(0, 5).join(', ') + (w.names.length > 5 ? ', …' : '');
    return s;
  });
}

// dedupe — identical assets are stored once
function addFile(ctx, wanted, data, dedupe) {
  var key = crc32(data) + ':' + data.length;
  if (dedupe && ctx.byContent[key]) return ctx.byContent[key];
  var dot = wanted.lastIndexOf('.');
  var path = ctx.names(wanted.slice(0, dot)) + wanted.slice(dot);
  if (dedupe) ctx.byContent[key] = path;
  ctx.files.push({ path: path, data: data });
  return path;
}

function tally(map, key, extra) {
  var t = map[key] || (map[key] = { count: 0 });
  t.count++;
  if (extra) {
    for (var k in extra) {
      if (!extra[k]) continue;
      t[k] = t[k] || [];
      if (t[k].indexOf(extra[k]) < 0) t[k].push(extra[k]);
    }
  }
  return t;
}

// ---------- variables and styles ----------

async function variableInfo(id, ctx, depth) {
  var cache = ctx.cache.vars;
  if (cache[id] !== undefined) return cache[id];
  cache[id] = null;
  var v = null, col = null;
  try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { warn(ctx, 'var', 'Variables unavailable: ' + msg(e)); }
  if (!v) return null;
  try { col = await figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId); } catch (e) { col = null; }
  var info = { name: v.name, collection: col ? col.name : null, type: v.resolvedType, values: {} };
  if (v.codeSyntax && v.codeSyntax.WEB) info.css = v.codeSyntax.WEB;
  cache[id] = info;
  var refs = ctx.cache.refs[id] = [];
  var modes = col && col.modes ? col.modes : [];
  for (var modeId in v.valuesByMode) {
    var modeName = modeId, val = v.valuesByMode[modeId];
    for (var i = 0; i < modes.length; i++) if (modes[i].modeId === modeId) modeName = modes[i].name;
    if (val && val.type === 'VARIABLE_ALIAS') refs.push(val.id);
    info.values[modeName] = await valueStr(val, ctx, depth + 1);
  }
  return info;
}

async function valueStr(val, ctx, depth) {
  if (val && val.type === 'VARIABLE_ALIAS') {
    if (depth > 5) return '-> ?';
    var target = await variableInfo(val.id, ctx, depth);
    return '-> ' + (target ? target.name : val.id);
  }
  if (val && typeof val === 'object' && 'r' in val) return colorStr(val);
  return val;
}

// A variable and everything it references go into the used list
function markVar(id, ctx) {
  if (ctx.usedVars[id] || !ctx.cache.vars[id]) return;
  ctx.usedVars[id] = true;
  (ctx.cache.refs[id] || []).forEach(function (r) { markVar(r, ctx); });
}

async function varName(alias, ctx) {
  if (!alias || !alias.id) return null;
  var info = await variableInfo(alias.id, ctx, 0);
  if (!info) return null;
  markVar(alias.id, ctx);
  return info.name;
}

async function varsOfMap(bv, ctx) {
  if (!bv || typeof bv !== 'object') return undefined;
  var out = {}, any = false;
  for (var k in bv) {
    if (SKIP_VAR_KEYS[k]) continue;
    var a = bv[k];
    if (Array.isArray(a)) a = a[0];
    var name = await varName(a, ctx);
    if (name) { out[k] = name; any = true; }
  }
  return any ? out : undefined;
}

async function styleName(id, ctx) {
  if (!id || typeof id !== 'string') return null;
  var cache = ctx.cache.styles;
  if (cache[id] === undefined) {
    cache[id] = null;
    try {
      var s = await figma.getStyleByIdAsync(id);
      if (s) cache[id] = { name: s.name, type: s.type, description: s.description || '' };
    } catch (e) { warn(ctx, 'style', 'Styles unavailable: ' + msg(e)); }
  }
  if (!cache[id]) return null;
  ctx.usedStyles[id] = true;
  return cache[id].name;
}

// ---------- layer properties ----------

function boxOf(node) {
  var b = get(node, 'absoluteBoundingBox');
  if (b) return b;
  var t = get(node, 'absoluteTransform');
  if (t) return { x: t[0][2], y: t[1][2], width: get(node, 'width') || 0, height: get(node, 'height') || 0 };
  return null;
}

function trackStr(t) {
  if (t.type === 'FIXED') return round(t.value);
  if (t.type === 'FLEX') return (t.value || 1) + 'fr';
  return String(t.type).toLowerCase();
}

function layoutOf(node) {
  var mode = get(node, 'layoutMode');
  if (!mode || mode === 'NONE') return undefined;
  var l = { mode: mode };
  if (mode === 'GRID') {
    l.rows = get(node, 'gridRowCount');
    l.cols = get(node, 'gridColumnCount');
    l.rowGap = get(node, 'gridRowGap');
    l.colGap = get(node, 'gridColumnGap');
    var rs = get(node, 'gridRowSizes'), cs = get(node, 'gridColumnSizes');
    if (rs) l.rowSizes = rs.map(trackStr);
    if (cs) l.colSizes = cs.map(trackStr);
  } else {
    var main = get(node, 'primaryAxisAlignItems');
    if (get(node, 'layoutWrap') === 'WRAP') l.wrap = true;
    l.gap = String(main).indexOf('SPACE_') === 0 ? 'auto' : round(get(node, 'itemSpacing') || 0);
    if (l.wrap) {
      var cg = get(node, 'counterAxisSpacing');
      l.gapCross = typeof cg === 'number' ? round(cg) : l.gap;
      l.alignContent = get(node, 'counterAxisAlignContent');
    }
    l.alignMain = main;
    l.alignCross = get(node, 'counterAxisAlignItems');
  }
  l.pad = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(function (k) { return round(get(node, k) || 0); });
  if (get(node, 'itemReverseZIndex')) l.reverseZ = true;
  if (get(node, 'strokesIncludedInLayout')) l.strokesIncluded = true;
  return l;
}

// Layout grids (columns, rows): container width and gutter
function gridsOf(node) {
  var list = get(node, 'layoutGrids');
  if (!list || isMixed(list) || !list.length) return undefined;
  var out = list.filter(visibleNode).map(function (g) {
    if (g.pattern === 'GRID') return { pattern: 'GRID', size: round(g.sectionSize) };
    var r = { pattern: g.pattern, align: g.alignment, count: g.count === Infinity ? 'auto' : g.count, gutter: round(g.gutterSize || 0) };
    if (g.alignment !== 'STRETCH' && typeof g.sectionSize === 'number') r.width = round(g.sectionSize);
    if (typeof g.offset === 'number') r.offset = round(g.offset);
    return r;
  });
  return out.length ? out : undefined;
}

// How the layer behaves inside its parent
function selfLayout(node, o) {
  var parent = node.parent;
  var pMode = parent ? get(parent, 'layoutMode') : null;
  var inAuto = !!pMode && pMode !== 'NONE';
  if (inAuto || o.layout) {
    var h = get(node, 'layoutSizingHorizontal'), v = get(node, 'layoutSizingVertical');
    if (h && v) o.size = { h: h, v: v };
  }
  if (inAuto && get(node, 'layoutPositioning') === 'ABSOLUTE') o.absolute = true;
  if (inAuto && pMode === 'GRID') {
    o.grid = {
      row: get(node, 'gridRowAnchorIndex'), col: get(node, 'gridColumnAnchorIndex'),
      rowSpan: get(node, 'gridRowSpan'), colSpan: get(node, 'gridColumnSpan'),
      alignH: get(node, 'gridChildHorizontalAlign'), alignV: get(node, 'gridChildVerticalAlign')
    };
  }
  if ((!inAuto || o.absolute) && parent && parent.type !== 'PAGE') {
    var c = get(node, 'constraints');
    if (c) o.constraints = c.horizontal + '/' + c.vertical;
  }
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) {
    var v = get(node, k);
    if (typeof v === 'number') o[k] = round(v);
  });
}

function shapeStyle(node, o) {
  if (has(node, 'cornerRadius')) {
    var r = get(node, 'cornerRadius');
    if (isMixed(r)) {
      o.radius = ['topLeftRadius', 'topRightRadius', 'bottomRightRadius', 'bottomLeftRadius']
        .map(function (k) { return round(get(node, k) || 0); });
    } else if (r) o.radius = round(r);
  }
  if (get(node, 'clipsContent') === true) o.clip = true;
  var op = get(node, 'opacity');
  if (typeof op === 'number' && op < 1) o.opacity = round(op);
  var bm = get(node, 'blendMode');
  if (bm && bm !== 'PASS_THROUGH' && bm !== 'NORMAL') o.blend = bm;
  var rot = get(node, 'rotation');
  if (rot) o.rotation = round(rot);
  if (get(node, 'isMask')) o.mask = true;
}

function imageExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  return 'bin';
}

async function imageFile(hash, ctx) {
  if (!hash || !ctx.opt.assets) return null;
  if (ctx.images[hash] !== undefined) return ctx.images[hash];
  ctx.images[hash] = null;
  try {
    var img = figma.getImageByHash(hash);
    if (img) {
      var bytes = await img.getBytesAsync();
      ctx.images[hash] = addFile(ctx, 'assets/img-' + hash.slice(0, 10) + '.' + imageExt(bytes), bytes, true);
    }
  } catch (e) { warn(ctx, 'img', 'Could not export image: ' + msg(e)); }
  return ctx.images[hash];
}

async function imagePaint(p, ctx) {
  var r = { type: 'image', scale: p.scaleMode };
  var file = await imageFile(p.imageHash, ctx);
  if (file) r.file = file;
  else if (p.imageHash) r.hash = p.imageHash;
  var t = p.imageTransform;
  var identity = t && t[0][0] === 1 && t[0][1] === 0 && t[0][2] === 0 && t[1][0] === 0 && t[1][1] === 1 && t[1][2] === 0;
  if (t && !identity) r.transform = t.map(function (row) { return row.map(round); });
  if (p.scaleMode === 'TILE' && p.scalingFactor) r.tile = round(p.scalingFactor);
  if (p.rotation) r.rotation = p.rotation;
  if (p.filters) {
    var f = {}, any = false;
    for (var k in p.filters) if (p.filters[k]) { f[k] = round(p.filters[k]); any = true; }
    if (any) r.filters = f;
  }
  if (typeof p.opacity === 'number' && p.opacity < 1) r.opacity = round(p.opacity);
  return r;
}

async function paints(list, ctx, style) {
  if (!list || isMixed(list) || !list.length) return undefined;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var p = list[i], r;
    if (p.visible === false) continue;
    if (p.type === 'SOLID') {
      var c = colorStr(p.color, p.opacity);
      var v = await varName(p.boundVariables && p.boundVariables.color, ctx);
      tally(ctx.tokens.colors, c, { vars: v, styles: style });
      r = v ? { color: c, var: v } : c;
    } else if (p.type.indexOf('GRADIENT_') === 0) {
      r = { type: p.type.slice(9).toLowerCase(), stops: [] };
      for (var j = 0; j < p.gradientStops.length; j++) {
        var st = p.gradientStops[j];
        var sv = await varName(st.boundVariables && st.boundVariables.color, ctx);
        r.stops.push(sv ? [colorStr(st.color), round(st.position), sv] : [colorStr(st.color), round(st.position)]);
      }
      if (p.gradientTransform) r.transform = p.gradientTransform.map(function (row) { return row.map(round); });
      if (typeof p.opacity === 'number' && p.opacity < 1) r.opacity = round(p.opacity);
    } else if (p.type === 'IMAGE') {
      r = await imagePaint(p, ctx);
    } else {
      r = { type: String(p.type).toLowerCase() };
    }
    if (p.blendMode && p.blendMode !== 'NORMAL' && p.blendMode !== 'PASS_THROUGH') {
      if (typeof r === 'string') r = { color: r };
      r.blend = p.blendMode;
    }
    out.push(r);
  }
  return out.length ? out : undefined;
}

async function strokeOf(node, ctx, style) {
  var list = get(node, 'strokes');
  if (!list || isMixed(list) || !list.length) return undefined;
  var p = await paints(list, ctx, style);
  if (!p) return undefined;
  var s = { paints: p, align: get(node, 'strokeAlign') };
  var w = get(node, 'strokeWeight');
  s.weight = isMixed(w)
    ? ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'].map(function (k) { return round(get(node, k) || 0); })
    : round(w || 0);
  var dash = get(node, 'dashPattern');
  if (dash && dash.length) s.dash = dash;
  return s;
}

async function effectsOf(node, ctx, style) {
  var list = get(node, 'effects');
  if (!list || isMixed(list) || !list.length) return undefined;
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var e = list[i], r;
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      r = { type: e.type === 'DROP_SHADOW' ? 'shadow' : 'inner-shadow', x: round(e.offset.x), y: round(e.offset.y),
        blur: round(e.radius), spread: round(e.spread || 0), color: colorStr(e.color) };
      tally(ctx.tokens.effects, (r.type === 'inner-shadow' ? 'inset ' : '') + r.x + 'px ' + r.y + 'px ' + r.blur + 'px ' + r.spread + 'px ' + r.color, { styles: style });
    } else if (e.type === 'LAYER_BLUR') r = { type: 'blur', radius: round(e.radius) };
    else if (e.type === 'BACKGROUND_BLUR') r = { type: 'backdrop-blur', radius: round(e.radius) };
    else r = { type: String(e.type).toLowerCase() };
    var vars = await varsOfMap(e.boundVariables, ctx);
    if (vars) r.vars = vars;
    out.push(r);
  }
  return out.length ? out : undefined;
}

// ---------- text ----------

function lineHeightStr(lh) {
  if (!lh || isMixed(lh)) return undefined;
  if (lh.unit === 'AUTO') return 'auto';
  if (lh.unit === 'PERCENT') return round(lh.value) + '%';
  return round(lh.value);
}

function letterSpacingStr(ls) {
  if (!ls || isMixed(ls)) return undefined;
  if (ls.unit === 'PERCENT') return round(ls.value) + '%';
  return round(ls.value);
}

// Older API versions lack some fields: try from the full field set down to the basic one
function styledSegments(node) {
  var sets = [SEGMENT_FIELDS_FULL, SEGMENT_FIELDS_MID, SEGMENT_FIELDS];
  for (var i = 0; i < sets.length; i++) {
    try { return node.getStyledTextSegments(sets[i]); } catch (e) { /* try the next set */ }
  }
  return null;
}

async function textOf(node, ctx) {
  var t = { chars: get(node, 'characters'), align: get(node, 'textAlignHorizontal'),
    valign: get(node, 'textAlignVertical'), autoResize: get(node, 'textAutoResize') };
  if (get(node, 'textTruncation') === 'ENDING') t.maxLines = get(node, 'maxLines') || null;
  var ps = get(node, 'paragraphSpacing');
  if (typeof ps === 'number' && ps) t.paragraphSpacing = round(ps);
  var pi = get(node, 'paragraphIndent');
  if (typeof pi === 'number' && pi) t.paragraphIndent = round(pi);
  var segs = styledSegments(node);
  if (!segs) {
    warn(ctx, 'segments', 'Text styles could not be read', node.name);
    segs = [];
  }
  t.segments = [];
  for (var i = 0; i < segs.length; i++) {
    var seg = segs[i], s = {};
    if (segs.length > 1) s.text = seg.characters;
    if (seg.fontName && !isMixed(seg.fontName)) { s.font = seg.fontName.family; s.style = seg.fontName.style; }
    if (seg.fontWeight) s.weight = seg.fontWeight;
    if (typeof seg.fontSize === 'number') s.size = round(seg.fontSize);
    s.lineHeight = lineHeightStr(seg.lineHeight);
    s.letterSpacing = letterSpacingStr(seg.letterSpacing);
    var fills = await paints(seg.fills, ctx, await styleName(seg.fillStyleId, ctx));
    if (fills) s.color = fills.length === 1 ? fills[0] : fills;
    if (seg.textCase && seg.textCase !== 'ORIGINAL') s.case = seg.textCase;
    if (seg.textDecoration && seg.textDecoration !== 'NONE') s.decoration = seg.textDecoration;
    if (seg.hyperlink) s.link = seg.hyperlink.type === 'URL' ? seg.hyperlink.value : 'node:' + seg.hyperlink.value;
    if (seg.listOptions && seg.listOptions.type && seg.listOptions.type !== 'NONE') s.list = seg.listOptions.type;
    var ts = await styleName(seg.textStyleId, ctx);
    if (ts) s.textStyle = ts;
    var sv = await varsOfMap(seg.boundVariables, ctx);
    if (sv) s.vars = sv;
    if (s.font) {
      (ctx.tokens.fonts[s.font] = ctx.tokens.fonts[s.font] || {})[s.style] = true;
      var tk = tally(ctx.tokens.typography, [s.font, s.style, s.size, s.lineHeight, s.letterSpacing].join('|'), { styles: ts });
      tk.font = s.font; tk.style = s.style; tk.weight = s.weight; tk.size = s.size;
      tk.lineHeight = s.lineHeight; tk.letterSpacing = s.letterSpacing;
    }
    t.segments.push(s);
  }
  return t;
}

// ---------- components ----------

// Swap target (INSTANCE_SWAP): "Set / Variant" or the component name
async function swapName(id) {
  try {
    var n = await figma.getNodeByIdAsync(id);
    if (n) {
      var parent = get(n, 'parent');
      return parent && parent.type === 'COMPONENT_SET' ? parent.name + ' / ' + n.name : n.name;
    }
  } catch (e) { /* keep the id */ }
  return id;
}

// Property key "Name#12:0" → "Name"; the full key is kept when names collide
function propKeys(obj) {
  var base = {}, out = {};
  Object.keys(obj).forEach(function (k) { var b = k.split('#')[0]; base[b] = (base[b] || 0) + 1; });
  Object.keys(obj).forEach(function (k) { var b = k.split('#')[0]; out[k] = base[b] > 1 ? k : b; });
  return out;
}

async function instanceProps(props) {
  var names = propKeys(props), out = {}, any = false;
  for (var k in props) {
    var p = props[k];
    out[names[k]] = p.type === 'INSTANCE_SWAP' ? await swapName(p.value) : p.value;
    any = true;
  }
  return any ? out : undefined;
}

async function propDefs(defs) {
  if (!defs) return undefined;
  var names = propKeys(defs), out = {};
  for (var k in defs) {
    var d = defs[k], p = { type: d.type, default: d.type === 'INSTANCE_SWAP' ? await swapName(d.defaultValue) : d.defaultValue };
    if (d.variantOptions) p.options = d.variantOptions;
    out[names[k]] = p;
  }
  return out;
}

// A component set may live on another page: load that page before reading
async function loadPageOf(n, ctx) {
  var p = n;
  for (var i = 0; i < 100 && p; i++) {
    p = get(p, 'parent');
    if (p && p.type === 'PAGE') {
      if (!ctx.cache.pages[p.id] && typeof p.loadAsync === 'function') {
        ctx.cache.pages[p.id] = true;
        try { await p.loadAsync(); } catch (e) { /* read whatever is loaded */ }
      }
      return;
    }
  }
}

function registerComponent(ctx, main, set, name, byName) {
  var key = set ? set.id : byName ? 'name:' + name : main.id;
  var r = ctx.components[key];
  if (!r) r = ctx.components[key] = { name: name, kind: set ? 'set' : 'component', used: 0, node: set || main, remote: !!get(main, 'remote') };
  r.used++;
}

async function componentOf(node, ctx) {
  var c = {}, main = null;
  if (typeof node.getMainComponentAsync === 'function') {
    try {
      main = await withTimeout(node.getMainComponentAsync(), config.mainTimeout);
    } catch (e) {
      if (msg(e) === 'timeout') warn(ctx, 'main-timeout', 'Figma did not return the main component of an instance', node.name);
    }
  }
  if (main) {
    await loadPageOf(main, ctx);
    var parent = get(main, 'parent');
    var set = parent && parent.type === 'COMPONENT_SET' ? parent : null;
    var byName = false;
    if (set) { c.main = set.name; c.variant = main.name; }
    else if (main.name.indexOf('=') > 0) {
      // A variant without an accessible set is usually a library component
      c.main = node.name; c.variant = main.name; byName = true;
      if (ctx.opt.register) warn(ctx, 'remote', 'Library components without an accessible component set: variants not exported', c.main);
    } else c.main = main.name;
    if (get(main, 'remote')) c.remote = true;
    if (ctx.opt.register) registerComponent(ctx, main, set, c.main, byName);
  }
  var props = get(node, 'componentProperties');
  if (props) {
    var pr = await instanceProps(props);
    if (pr) c.props = pr;
  }
  return c;
}

// Paths like Label/Icon/fills; same-name siblings become Label#2
function flatten(n, prefix, out) {
  for (var k in n) {
    if (k === 'children' || k === 'id' || k === 'name' || k === 'fx' || k === 'fy' || k === 'css') continue;
    if (prefix === '' && (k === 'x' || k === 'y')) continue;
    out[prefix + k] = JSON.stringify(n[k]);
  }
  if (n.children) {
    var seen = {};
    n.children.forEach(function (c) {
      seen[c.name] = (seen[c.name] || 0) + 1;
      flatten(c, prefix + c.name + (seen[c.name] > 1 ? '#' + seen[c.name] : '') + '/', out);
    });
  }
  return out;
}

function diffTrees(a, b) {
  var fa = flatten(a, '', {}), fb = flatten(b, '', {}), out = {}, k;
  for (k in fb) if (fa[k] !== fb[k]) out[k] = [fa[k] === undefined ? null : JSON.parse(fa[k]), JSON.parse(fb[k])];
  for (k in fa) if (!(k in fb)) out[k] = [JSON.parse(fa[k]), null];
  return out;
}

async function serializeVariant(v, vctx) {
  var box = boxOf(v) || { x: 0, y: 0 };
  return serializeNode(v, vctx, box, box, { root: true });
}

async function componentsOut(ctx, withVariants) {
  var out = [];
  for (var key in ctx.components) {
    var c = ctx.components[key];
    var r = { name: c.name, kind: c.kind, used: c.used };
    if (c.remote) r.remote = true;
    var desc = get(c.node, 'description');
    if (desc) r.description = desc;
    if (c.kind === 'set') {
      try {
        await describeSet(c, r, ctx, withVariants);
      } catch (e) { warn(ctx, 'set', 'Component variants not exported', c.name + ': ' + msg(e)); }
    }
    out.push(r);
  }
  out.sort(function (a, b) { return b.used - a.used; });
  return out;
}

async function describeSet(c, r, ctx, withVariants) {
  var set = c.node;
  var props = await propDefs(get(set, 'componentPropertyDefinitions'));
  if (props) r.props = props;
  var variants = (get(set, 'children') || []).filter(function (n) { return n.type === 'COMPONENT'; });
  var def = get(set, 'defaultVariant') || variants[0];
  if (def) r.default = def.name;
  if (!variants.length) { warn(ctx, 'novariants', 'Component set has no variants', c.name); return; }
  if (!withVariants) return;
  if (variants.length > MAX_VARIANTS) {
    r.variantNames = variants.map(function (n) { return n.name; });
    warn(ctx, 'many', 'Too many variants: only names exported', c.name + ' (' + variants.length + ')');
    return;
  }
  ctx.report('Component "' + c.name + '": variants');
  var vctx = variantCtx(ctx);
  var defTree = def ? await serializeVariant(def, vctx) : null;
  var dir = 'components/' + slug(c.name, 'component') + '/';
  r.variants = [];
  for (var i = 0; i < variants.length; i++) {
    var v = variants[i], item = { name: v.name };
    item.png = await png(ctx, v, dir + slug(v.name, 'variant') + '.png', 2);
    if (defTree && v.id !== def.id) item.diff = diffTrees(defTree, await serializeVariant(v, vctx));
    r.variants.push(item);
  }
}

// ---------- icons and files ----------

function hasImageFill(n) {
  var f = get(n, 'fills');
  if (!f || isMixed(f)) return false;
  for (var i = 0; i < f.length; i++) if (f[i].type === 'IMAGE' || f[i].type === 'VIDEO') return true;
  return false;
}

function scanIcon(node, st) {
  for (var i = 0; i < node.children.length && st.ok; i++) {
    var c = node.children[i];
    if (c.visible === false) continue;
    if (TEXT_TYPES[c.type] || hasImageFill(c)) { st.ok = false; return; }
    if (VECTOR_TYPES[c.type]) { st.vector = true; continue; }
    if (has(c, 'children')) { scanIcon(c, st); continue; }
    if (SHAPE_TYPES[c.type]) { st.shapes++; continue; }
    st.ok = false;
    return;
  }
}

// null: a regular layer; 'icon' / 'illustration': exported as one SVG, children are not traversed.
// Only shapes without text or photos: at least one vector, or a small group of shapes.
// An auto-layout container of several icons is not an icon: traverse it and export each icon.
function iconKind(node) {
  var big = node.width > ICON_MAX || node.height > ICON_MAX;
  if (VECTOR_TYPES[node.type]) return big ? 'illustration' : 'icon';
  if (TEXT_TYPES[node.type] || !has(node, 'children') || !node.children.length || hasImageFill(node)) return null;
  var mode = get(node, 'layoutMode');
  if (mode && mode !== 'NONE') {
    var parts = node.children.filter(function (c) { return c.visible !== false && (VECTOR_TYPES[c.type] || has(c, 'children')); });
    if (parts.length > 1) return null;
  }
  var st = { vector: false, shapes: 0, ok: true };
  scanIcon(node, st);
  if (!st.ok) return null;
  if (st.vector) return big ? 'illustration' : 'icon';
  if (st.shapes >= 2 && node.width <= SHAPE_ICON_MAX && node.height <= SHAPE_ICON_MAX) return 'icon';
  return null;
}

// Colors inside an icon that is not traversed
async function iconColors(node, ctx) {
  var seen = {}, out = [];
  async function rec(n) {
    if (n.visible === false) return;
    var lists = [get(n, 'fills'), get(n, 'strokes')];
    for (var i = 0; i < lists.length; i++) {
      var p = await paints(lists[i], ctx);
      (p || []).forEach(function (x) {
        var k = JSON.stringify(x);
        if (!seen[k]) { seen[k] = true; out.push(x); }
      });
    }
    if (has(n, 'children')) for (var j = 0; j < n.children.length; j++) await rec(n.children[j]);
  }
  if (has(node, 'children')) for (var i = 0; i < node.children.length; i++) await rec(node.children[i]);
  return out.length ? out : undefined;
}

async function exportIcon(node, ctx, kind) {
  try {
    var data = await node.exportAsync({ format: 'SVG', svgOutlineText: true, svgIdAttribute: false, svgSimplifyStroke: true });
    var base = slug(node.name, kind);
    if (base.indexOf(kind) !== 0) base = kind + '-' + base;
    return addFile(ctx, 'assets/' + base + '.svg', data, true);
  } catch (e) {
    warn(ctx, 'svg', 'Could not export SVG', node.name);
    return null;
  }
}

async function exportBySettings(node, list, ctx) {
  var out = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    try {
      var data = await node.exportAsync(s);
      var ext = s.format === 'JPG' ? 'jpg' : String(s.format).toLowerCase();
      var scale = s.constraint && s.constraint.type === 'SCALE' && s.constraint.value !== 1 ? '@' + s.constraint.value + 'x' : '';
      out.push(addFile(ctx, 'assets/' + slug(node.name) + (s.suffix ? '-' + slug(s.suffix) : '') + scale + '.' + ext, data, true));
    } catch (e) { warn(ctx, 'exp', 'Export settings files not exported', node.name); }
  }
  return out.length ? out : undefined;
}

async function png(ctx, node, path, scale) {
  try {
    var data = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: round(scale) } });
    return addFile(ctx, path, data, false);
  } catch (e) {
    warn(ctx, 'png', 'PNG not exported', path);
    return null;
  }
}

// ---------- tree traversal ----------

// flags.root: the export root (never an icon); flags.hiddenUp: an ancestor is hidden
async function serializeNode(node, ctx, rootBox, parentBox, flags) {
  try {
    return await serializeNodeInner(node, ctx, rootBox, parentBox, flags || {});
  } catch (e) {
    var name = get(node, 'name');
    warn(ctx, 'node', 'Layer not exported due to an error', name + ': ' + msg(e));
    return { id: get(node, 'id'), name: name, type: get(node, 'type'), error: msg(e) };
  }
}

async function serializeNodeInner(node, ctx, rootBox, parentBox, flags) {
  ctx.count++;
  if (ctx.count % 25 === 0) ctx.report('Layers: ' + ctx.count);
  var o = { id: node.id, name: node.name, type: node.type };
  if (node.visible === false) o.hidden = true;
  var visible = node.visible !== false && !flags.hiddenUp;
  var box = boxOf(node);
  if (box) {
    o.x = round(box.x - parentBox.x); o.y = round(box.y - parentBox.y);
    o.fx = round(box.x - rootBox.x); o.fy = round(box.y - rootBox.y);
  }
  if (has(node, 'width')) { o.w = round(node.width); o.h = round(node.height); }

  var layout = layoutOf(node);
  if (layout) {
    o.layout = layout;
    [layout.gap, layout.gapCross, layout.rowGap, layout.colGap].concat(layout.pad).forEach(function (v) {
      if (typeof v === 'number' && v) tally(ctx.tokens.spacing, String(v));
    });
  }
  var grids = gridsOf(node);
  if (grids) o.grids = grids;
  selfLayout(node, o);
  shapeStyle(node, o);
  if (o.radius !== undefined) tally(ctx.tokens.radii, String(o.radius));

  var styles = {}, anyStyle = false;
  var styleIds = { fill: 'fillStyleId', stroke: 'strokeStyleId', effect: 'effectStyleId', text: 'textStyleId', grid: 'gridStyleId' };
  for (var sk in styleIds) {
    var sn = await styleName(get(node, styleIds[sk]), ctx);
    if (sn) { styles[sk] = sn; anyStyle = true; }
  }

  if (!TEXT_TYPES[node.type]) {
    var fills = await paints(get(node, 'fills'), ctx, styles.fill);
    if (fills) o.fills = fills;
  }
  var stroke = await strokeOf(node, ctx, styles.stroke);
  if (stroke) o.stroke = stroke;
  var effects = await effectsOf(node, ctx, styles.effect);
  if (effects) o.effects = effects;
  if (anyStyle) o.styles = styles;
  var vars = await varsOfMap(get(node, 'boundVariables'), ctx);
  if (vars) o.vars = vars;

  if (TEXT_TYPES[node.type]) o.text = await textOf(node, ctx);
  if (node.type === 'INSTANCE') o.comp = await componentOf(node, ctx);

  var kind = flags.root ? null : iconKind(node);
  if (kind) {
    o.icon = true;
    if (kind === 'illustration') o.illustration = true;
  }
  if (visible && ctx.opt.assets) {
    var es = get(node, 'exportSettings');
    if (es && es.length) o.exports = await exportBySettings(node, es, ctx);
    if (kind && !o.exports) {
      var svg = await exportIcon(node, ctx, kind);
      if (svg) o.asset = svg;
    }
  }
  if (kind && !ctx.opt.iconChildren) {
    var colors = await iconColors(node, ctx);
    if (colors) o.colors = colors;
  }

  if (visible && ctx.opt.css) {
    try {
      var css = await node.getCSSAsync();
      if (css && Object.keys(css).length) o.css = css;
    } catch (e) { warn(ctx, 'css', 'CSS unavailable: ' + msg(e), node.name); }
  }

  if ((!kind || ctx.opt.iconChildren) && has(node, 'children')) {
    var kids = [];
    for (var i = 0; i < node.children.length; i++) {
      var ch = node.children[i];
      if (ch.visible === false && !ctx.opt.hidden) continue;
      kids.push(await serializeNode(ch, ctx, rootBox, box || parentBox, { hiddenUp: !visible }));
    }
    if (kids.length) o.children = kids;
  }
  return o;
}

// Sections are the frame's visible children; a single wrapper is unwrapped
function sectionNodes(root) {
  var cur = root;
  while (has(cur, 'children')) {
    var kids = cur.children.filter(visibleNode);
    if (kids.length === 1 && has(kids[0], 'children') && kids[0].children.filter(visibleNode).length >= 2) {
      cur = kids[0];
      continue;
    }
    return kids;
  }
  return [];
}

async function serializeFrame(root, settings, cache, report) {
  settings = Object.assign({}, DEFAULTS, settings || {});
  var ctx = newCtx(settings, cache || newCache(), report);
  var rootBox = boxOf(root) || { x: 0, y: 0 };
  var tree = await serializeNode(root, ctx, rootBox, rootBox, { root: true });
  return { tree: tree, files: ctx.files, ctx: ctx };
}

// ---------- summaries ----------

function tokenList(map, keyName) {
  return Object.keys(map).map(function (k) {
    var o = {};
    o[keyName] = isNaN(Number(k)) ? k : Number(k);
    return Object.assign(o, map[k]);
  }).sort(function (a, b) { return b.count - a.count; });
}

function tokensOut(ctx) {
  var t = ctx.tokens, fonts = {};
  Object.keys(t.fonts).sort().forEach(function (f) { fonts[f] = Object.keys(t.fonts[f]).sort(); });
  var byName = function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; };
  return {
    colors: tokenList(t.colors, 'value').map(function (c) { c.value = String(c.value); return c; }),
    typography: Object.keys(t.typography).map(function (k) { return t.typography[k]; }).sort(function (a, b) { return b.count - a.count; }),
    fonts: fonts,
    effects: tokenList(t.effects, 'value'),
    radii: tokenList(t.radii, 'value'),
    spacing: tokenList(t.spacing, 'value'),
    variables: Object.keys(ctx.usedVars).map(function (id) { return ctx.cache.vars[id]; }).filter(Boolean).sort(byName),
    styles: Object.keys(ctx.usedStyles).map(function (id) { return ctx.cache.styles[id]; }).filter(Boolean).sort(byName)
  };
}

function padStr(p) {
  if (p[0] === p[1] && p[1] === p[2] && p[2] === p[3]) return String(p[0]);
  if (p[0] === p[2] && p[1] === p[3]) return p[0] + '/' + p[1];
  return p.join('/');
}

function layoutSummary(l) {
  var s = l.mode === 'HORIZONTAL' ? 'row' : l.mode === 'VERTICAL' ? 'col' : 'grid ' + l.rows + 'x' + l.cols;
  if (l.wrap) s += ' wrap';
  if (l.mode !== 'GRID') s += ' gap ' + l.gap + ' align ' + String(l.alignMain).toLowerCase() + '/' + String(l.alignCross).toLowerCase();
  else s += ' gap ' + l.rowGap + '/' + l.colGap;
  if (l.pad.some(function (v) { return v; })) s += ' pad ' + padStr(l.pad);
  return s;
}

function paintSummary(p) {
  if (typeof p === 'string') return p;
  if (p.var) return p.color + '{' + p.var + '}';
  if (p.color) return p.color;
  if (p.type === 'image') return 'image' + (p.file ? ' ' + p.file : '');
  return p.type + (p.stops ? '-gradient' : '');
}

function textSummary(t) {
  var s0 = t.segments[0] || {}, out = '';
  if (s0.font) out += s0.font + ' ' + s0.style + ' ' + s0.size + '/' + s0.lineHeight;
  if (s0.color) out += ' ' + paintSummary(s0.color);
  var chars = String(t.chars || '').replace(/\s*\n\s*/g, ' / ');
  out += ' "' + cut(chars, 60) + '"';
  if (t.segments.length > 1) out += ' +' + (t.segments.length - 1) + ' styles';
  return out;
}

function outlineLine(n) {
  var s = n.type + ' "' + n.name + '"';
  if (n.error) return s + ' ERROR: ' + n.error;
  if (n.w !== undefined) s += ' ' + n.w + 'x' + n.h;
  if (n.x !== undefined) s += ' @' + n.x + ',' + n.y;
  if (n.layout) s += ' [' + layoutSummary(n.layout) + ']';
  if (n.size) s += ' ' + n.size.h.toLowerCase() + '/' + n.size.v.toLowerCase();
  if (n.absolute) s += ' absolute';
  if (n.fills) s += ' bg ' + n.fills.map(paintSummary).join('+');
  if (n.stroke) s += ' border ' + (Array.isArray(n.stroke.weight) ? n.stroke.weight.join('/') : n.stroke.weight) + ' ' + paintSummary(n.stroke.paints[0]);
  if (n.radius !== undefined) s += ' r' + (Array.isArray(n.radius) ? n.radius.join('/') : n.radius);
  if (n.effects) s += ' fx ' + n.effects.map(function (e) { return e.type; }).join('+');
  if (n.opacity !== undefined) s += ' op ' + n.opacity;
  if (n.text) s += ' ' + textSummary(n.text);
  if (n.comp && n.comp.main) s += ' <' + n.comp.main + (n.comp.variant ? ': ' + n.comp.variant : '') + '>';
  if (n.colors) s += ' colors ' + n.colors.map(paintSummary).join('+');
  if (n.asset) s += ' -> ' + n.asset;
  if (n.exports) s += ' -> ' + n.exports.join(', ');
  if (n.hidden) s += ' (hidden)';
  return s;
}

function outline(tree) {
  var lines = [];
  (function rec(n, depth) {
    lines.push(new Array(depth + 1).join('  ') + outlineLine(n));
    (n.children || []).forEach(function (c) { rec(c, depth + 1); });
  })(tree, 0);
  return lines.join('\n') + '\n';
}

function json(v, indent) { return utf8(JSON.stringify(v, null, indent)); }

// ---------- export ----------

async function exportFrame(root, index, settings, cache, report) {
  var folder = pad2(index + 1) + '-' + slug(root.name, 'frame');
  report('"' + root.name + '": layers');
  var r = await serializeFrame(root, settings, cache, report);
  var ctx = r.ctx;

  report('"' + root.name + '": preview');
  var side = Math.max(root.width, root.height) || 1;
  await png(ctx, root, 'preview.png', Math.min(1, MAX_PNG_SIDE / side));

  var sections = [];
  var list = sectionNodes(root);
  var rootBox = boxOf(root) || { x: 0, y: 0 };
  var tooMany = list.length > MAX_SECTIONS;
  if (tooMany) warn(ctx, 'sections', list.length + ' sections, more than ' + MAX_SECTIONS + ': section PNGs not exported');
  for (var i = 0; i < list.length; i++) {
    var n = list[i], file = null;
    if (!tooMany) {
      var nSide = Math.max(n.width, n.height) || 1;
      report('"' + root.name + '": sections ' + (i + 1) + '/' + list.length);
      file = await png(ctx, n, 'sections/' + pad2(i + 1) + '-' + slug(n.name, 'section') + '.png', Math.min(settings.sectionScale, MAX_PNG_SIDE / nSide));
    }
    var b = boxOf(n);
    sections.push({ file: file, name: n.name, id: n.id, y: b ? round(b.y - rootBox.y) : null, h: round(n.height) });
  }

  var comps = await componentsOut(ctx, settings.variants);

  ctx.files.unshift(
    { path: 'outline.txt', data: utf8(outline(r.tree)) },
    { path: 'tree.json', data: json(r.tree, 1) },
    { path: 'tokens.json', data: json(tokensOut(ctx), 2) },
    { path: 'components.json', data: json(comps, 2) }
  );

  return {
    folder: folder,
    files: ctx.files,
    summary: {
      folder: folder, name: root.name, id: root.id, w: round(root.width), h: round(root.height),
      layers: ctx.count, sections: sections, components: comps.length, files: ctx.files.length, warnings: warningList(ctx)
    }
  };
}

async function buildExport(nodes, settings, report) {
  settings = Object.assign({}, DEFAULTS, settings || {});
  report = report || function () {};
  var cache = newCache(), started = new Date(), files = [], frames = [];
  for (var i = 0; i < nodes.length; i++) {
    var r = await exportFrame(nodes[i], i, settings, cache, report);
    r.files.forEach(function (f) { files.push({ path: r.folder + '/' + f.path, data: f.data }); });
    frames.push(r.summary);
  }
  var manifest = {
    tool: 'figma-export', version: VERSION, file: figma.root.name, page: figma.currentPage.name,
    exportedAt: localTime(started), settings: settings, frames: frames
  };
  files.unshift({ path: 'manifest.json', data: json(manifest, 2) });
  var zipName = slug(figma.root.name, 'figma') + '-' + slug(nodes[0].name, 'frame') +
    (nodes.length > 1 ? '-and-' + (nodes.length - 1) : '') + '-' + stamp(started) + '.zip';
  return { zipName: zipName, files: files, frames: frames };
}

// ---------- plugin ----------

function sortByPosition(nodes) {
  return nodes.sort(function (a, b) {
    var ba = boxOf(a) || { x: 0, y: 0 }, bb = boxOf(b) || { x: 0, y: 0 };
    return Math.round(ba.y - bb.y) || Math.round(ba.x - bb.x);
  });
}

function selectionInfo() {
  return figma.currentPage.selection.map(function (n) {
    return { name: n.name, type: n.type, w: Math.round(get(n, 'width') || 0), h: Math.round(get(n, 'height') || 0) };
  });
}

async function runExport(settings, post) {
  var nodes = sortByPosition(figma.currentPage.selection.slice());
  if (!nodes.length) { post({ type: 'error', text: 'Nothing selected' }); return; }
  try { await figma.clientStorage.setAsync('settings', settings); } catch (e) { /* not critical */ }
  var t0 = Date.now();
  var res = await buildExport(nodes, settings, function (text) { post({ type: 'progress', text: text }); });
  post({ type: 'progress', text: 'Packing the archive…' });
  var zip = makeZip(res.files);
  var warnings = [], layers = 0;
  res.frames.forEach(function (f) { layers += f.layers; warnings = warnings.concat(f.warnings); });
  post({ type: 'done', name: res.zipName, zip: zip, files: res.files.length, layers: layers,
    seconds: Math.round((Date.now() - t0) / 1000), warnings: warnings });
}

function main() {
  figma.showUI(__html__, { width: 360, height: 500, themeColors: true });
  var post = function (m) { figma.ui.postMessage(m); };
  var sendSelection = function () { post({ type: 'selection', items: selectionInfo() }); };
  sendSelection();
  figma.on('selectionchange', sendSelection);
  figma.clientStorage.getAsync('settings').then(
    function (s) { post({ type: 'settings', settings: Object.assign({}, DEFAULTS, s || {}) }); },
    function () { post({ type: 'settings', settings: DEFAULTS }); }
  );
  var busy = false;
  figma.ui.onmessage = function (m) {
    if (m.type !== 'export' || busy) return;
    busy = true;
    var finish = function () { busy = false; };
    runExport(Object.assign({}, DEFAULTS, m.settings || {}), post)
      .catch(function (e) { post({ type: 'error', text: msg(e) }); })
      .then(finish, finish);
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    config: config, utf8: utf8, crc32: crc32, makeZip: makeZip, slug: slug,
    serializeFrame: serializeFrame, sectionNodes: sectionNodes, buildExport: buildExport,
    outline: outline, diffTrees: diffTrees, warningList: warningList
  };
} else if (typeof figma !== 'undefined') {
  main();
}
