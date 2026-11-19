# Archive format

This document is the contract between figma-export and the tools that read its archives. Everything marked **stable** keeps its name, type and meaning for the whole major version of the format. Everything marked **informational** is there for people and agents to read and may change in any release.

Current format: **1.0** (plugin 1.2.0).

## Versioning

`manifest.json` → `formatVersion`, a string `"MAJOR.MINOR"`.

- **Minor** (`1.0` → `1.1`): new optional fields or files. Existing ones do not change.
- **Major** (`1.x` → `2.0`): a stable field or file is removed, renamed, or changes its type or meaning.
- `version` in the same file is the plugin version. It is not the format version.

Archives made by plugin 1.1.0 have no `formatVersion`. Apart from that field, their structure is format 1.0.

## Rules for readers

1. Check `tool === "figma-export"` and the major part of `formatVersion`. Treat a missing `formatVersion` as `"1.0"`.
2. Ignore fields and files you do not know: minor versions add them.
3. Most fields are written only when they carry information. A missing field means "not set" or the default: no `fills` means no fills, no `opacity` means 1.
4. Take file paths from the JSON. Do not build them from layer names: names are slugified, numbered, de-duplicated and may change between versions.
5. Paths inside a frame's files (`tree.json`, `components.json`, `manifest.json` → `frames[].sections[].file`) are relative to that frame's folder.
6. Read `outline.txt` as text, not as data: its line syntax is informational.

## Files

```
<name>.zip                         informational: the zip name
  manifest.json                    stable
  <NN>-<frame>/                    stable: one folder per frame, folder name is in manifest.json → frames[].folder
    outline.txt                    stable file, informational content
    tree.json                      stable
    tokens.json                    stable
    components.json                stable
    preview.png                    stable, unless the PNG export failed (a warning is added)
    sections/<NN>-<name>.png       optional: paths are in manifest.json → frames[].sections[].file
    assets/...                     optional: paths are in tree.json
    components/<set>/<variant>.png optional: paths are in components.json
```

The zip is a standard archive with UTF-8 file names (entries are currently stored without compression).

Frames are numbered in canvas order: top to bottom, then left to right.

Optional parts depend on `settings` in `manifest.json`:

| Setting | When `false` |
|---|---|
| `assets` | no `assets/` folder; image fills carry `hash` instead of `file`; icons have no `asset` |
| `css` | no `css` field in `tree.json` |
| `variants` | `components.json` has no `variants` (properties and the default variant are still there) |
| `hidden` | hidden layers are left out of `tree.json` (when `true`, they are included with `hidden: true`) |

## manifest.json

| Field | Type | Meaning |
|---|---|---|
| `tool` | `"figma-export"` | producer |
| `version` | string | plugin version, semver |
| `formatVersion` | string | format version, `"MAJOR.MINOR"` |
| `file` | string | Figma file name |
| `page` | string | page the frames were on |
| `exportedAt` | string | local time `YYYY-MM-DD HH:MM`, no time zone (informational) |
| `settings` | object | `sectionScale` (1 or 2), `assets`, `css`, `variants`, `hidden` (booleans) |
| `frames` | array | one entry per exported frame, see below |

`frames[]`:

| Field | Type | Meaning |
|---|---|---|
| `folder` | string | the frame's folder in the zip |
| `name`, `id` | string | Figma layer name and node id |
| `w`, `h` | number | frame size, px |
| `layers` | number | layers written to `tree.json` |
| `sections` | array | `{file, name, id, y, h}`: the frame's visible children (a single wrapper is unwrapped); `file` is the PNG path or `null` (more than 40 sections, or the export failed); `y` is the offset from the frame top or `null` |
| `components` | number | entries in `components.json` |
| `files` | number | files in the frame folder |
| `warnings` | string[] | what could not be exported. The presence of warnings is stable. The text is informational: show it, do not parse it |

## tree.json

One object per layer, nested through `children`. All sizes and positions are px, rounded to 0.01.

| Field | Type | Meaning |
|---|---|---|
| `id`, `name`, `type` | string | Figma node id, layer name, node type (`FRAME`, `GROUP`, `TEXT`, `INSTANCE`, `RECTANGLE`, `VECTOR`, …) |
| `hidden` | `true` | the layer is hidden in Figma |
| `x`, `y` | number | position relative to the parent's bounding box |
| `fx`, `fy` | number | position relative to the exported frame |
| `w`, `h` | number | size |
| `layout` | object | the layer's own auto-layout, see below |
| `grids` | array | layout grids: `{pattern: "GRID", size}` or `{pattern: "COLUMNS" \| "ROWS", align, count (number or "auto"), gutter, width?, offset?}` |
| `size` | object | `{h, v}`, each `"FIXED"`, `"HUG"` or `"FILL"`; written when the layer or its parent uses auto-layout |
| `absolute` | `true` | absolutely positioned inside an auto-layout parent |
| `grid` | object | cell in a Grid parent: `row`, `col`, `rowSpan`, `colSpan`, `alignH`, `alignV` |
| `constraints` | string | `"<horizontal>/<vertical>"`, e.g. `"MIN/MIN"`, `"STRETCH/CENTER"`; written outside auto-layout and for `absolute` layers |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | number | size limits |
| `radius` | number or `[tl, tr, br, bl]` | corner radius |
| `clip` | `true` | clips content |
| `opacity` | number | layer opacity, written when below 1 |
| `blend` | string | blend mode other than normal |
| `rotation` | number | degrees |
| `mask` | `true` | the layer is a mask |
| `styles` | object | names of applied styles: `fill`, `stroke`, `effect`, `text`, `grid` |
| `fills` | Paint[] | fills (for text, colors are in `text.segments[].color`) |
| `stroke` | object | `{paints: Paint[], align, weight (number or [t, r, b, l]), dash?}` |
| `effects` | Effect[] | shadows and blurs |
| `vars` | object | other bound variables: `{<Figma property>: <variable name>}`, e.g. `{"itemSpacing": "Spacing/Gap"}` |
| `text` | object | text content and styles, see below |
| `comp` | object | instance data, see below |
| `icon` | `true` | exported as one SVG; `children` are not written |
| `illustration` | `true` | an icon larger than 256 px |
| `asset` | string | path of the icon's SVG |
| `colors` | Paint[] | colors inside an icon |
| `exports` | string[] | paths of files from the layer's Export settings (such a layer gets no separate icon SVG) |
| `css` | object | CSS from Figma (`getCSSAsync`), property → value. Informational: Figma decides its content |
| `children` | array | child layers |
| `error` | string | the layer could not be read; only `id`, `name`, `type` are present. The rest of the frame is exported |

**`layout`** (auto-layout of the layer itself):

- all modes: `mode` (`"HORIZONTAL"`, `"VERTICAL"` or `"GRID"`), `pad` `[top, right, bottom, left]`, `reverseZ?`, `strokesIncluded?`;
- `HORIZONTAL` / `VERTICAL`: `gap` (number, or `"auto"` for space-between/around/evenly), `alignMain` and `alignCross` (Figma values: `MIN`, `CENTER`, `MAX`, `SPACE_BETWEEN`, `BASELINE`, …), and with wrapping `wrap: true`, `gapCross`, `alignContent`;
- `GRID`: `rows`, `cols`, `rowGap`, `colGap`, `rowSizes?`, `colSizes?` (each track a number in px, `"<n>fr"`, or a lowercase Figma track type such as `"hug"`).

**Paint**, one of:

- a string: a solid color, `"#rrggbb"` or `"rgba(r, g, b, a)"` (paint opacity is folded into the alpha);
- `{color, var?, blend?}`: a solid color bound to a variable or with a blend mode;
- `{type: "linear" | "radial" | "angular" | "diamond", stops: [[color, position, variable?], …], transform?, opacity?, blend?}`;
- `{type: "image", scale: "FILL" | "FIT" | "CROP" | "TILE", file?, hash?, transform?, tile?, rotation?, filters?, opacity?, blend?}`: `file` is the path of the original image; `hash` is written instead when the image was not exported;
- `{type: "<other>"}`, e.g. `"video"`.

**Effect**, one of:

- `{type: "shadow" | "inner-shadow", x, y, blur, spread, color, vars?}`;
- `{type: "blur" | "backdrop-blur", radius, vars?}`;
- `{type: "<other>", vars?}`.

**`text`**: `chars`, `align` (`LEFT`, `CENTER`, `RIGHT`, `JUSTIFIED`), `valign` (`TOP`, `CENTER`, `BOTTOM`), `autoResize`, `maxLines?` (for truncated text), `paragraphSpacing?`, `paragraphIndent?`, `segments`. A segment is a run of characters with one style:

| Field | Meaning |
|---|---|
| `text` | the run's characters; written only when there is more than one segment |
| `font`, `style`, `weight`, `size` | font family, style name (`"Bold"`), numeric weight, size |
| `lineHeight` | number (px), `"<n>%"` or `"auto"` |
| `letterSpacing` | number (px) or `"<n>%"` |
| `color` | Paint, or Paint[] when there are several |
| `case`, `decoration`, `list` | Figma values, written when not default |
| `link` | URL, or `"node:<id>"` for a link to a layer |
| `textStyle` | text style name |
| `vars` | bound variables of the run |

**`comp`** (instances):

| Field | Meaning |
|---|---|
| `main` | component set name, or component name. For a library variant whose set is not accessible: the instance name |
| `variant` | variant name, e.g. `"State=Hover, Size=L"` |
| `remote` | `true` for a library component |
| `props` | property values: `{<name>: <value>}`. Instance swap gives `"<Set> / <Variant>"` or the component name. When two properties share a name, both keep the full Figma key `"Name#12:0"` |

### Which layers become one SVG

A layer is exported as one SVG, and its children are not written, only if it consists of shapes without text or images:

- with vectors: `icon` up to 256 px, `icon` + `illustration` if larger;
- without vectors (rectangles, lines, ellipses): only a group of two or more shapes no larger than 48 px, such as a hamburger or a close icon.

An auto-layout container of several icons is not an icon: it is traversed and each icon gets its own file. The exported frame itself is never an icon.

## tokens.json

Values used in the frame, with usage counts. Lists are sorted by `count`, most used first. Component variants do not add to the counts.

| Field | Item |
|---|---|
| `colors` | `{value, count, vars?, styles?}`: `value` is a color string; `vars` and `styles` list variables and styles that produce it |
| `typography` | `{font, style, weight, size, lineHeight, letterSpacing, count, styles?}`: one entry per distinct combination |
| `fonts` | `{<family>: [<style>, …]}` |
| `effects` | `{value, count, styles?}`: shadows as CSS `box-shadow` strings |
| `radii` | `{value, count}`: a number, or `"tl,tr,br,bl"` for mixed corners |
| `spacing` | `{value, count}`: gaps and paddings |
| `variables` | `{name, collection, type, values, css?}`: every variable used, plus every variable those reference. `values` maps mode name to value; a reference is `"-> <variable name>"`. `css` is the variable's code syntax for Web. Sorted by name |
| `styles` | `{name, type, description}`: every style used. Sorted by name |

## components.json

An array of components used in the frame, sorted by `used`, most used first.

| Field | Meaning |
|---|---|
| `name` | component set or component name |
| `kind` | `"set"` or `"component"` |
| `used` | number of instances in the frame |
| `remote` | `true` for a library component |
| `description` | description from Figma |
| `props` | sets only: `{<name>: {type, default, options?}}`, `type` is `VARIANT`, `TEXT`, `BOOLEAN` or `INSTANCE_SWAP` |
| `default` | sets only: default variant name |
| `variants` | sets only, when `settings.variants` is on: `{name, png, diff?}` for each variant |
| `variantNames` | instead of `variants` for sets with more than 40 variants: names only |

`png` is the path of the variant's 2x PNG, or `null` if the export failed.

`diff` shows how a variant differs from the default variant: `{<path>: [<default value>, <this variant's value>]}`. A path is a `tree.json` field relative to the variant root: `"fills"` for the root, `"Label/fills"` for a child, `"Label#2/y"` for the second child named Label. `null` means the field is absent on that side. Variant trees include hidden layers and the insides of icons, so a diff shows icon color changes. `id`, `name`, `css`, `fx`, `fy` and the root's `x`, `y` are not compared. The default variant has no `diff`.

## Images and files

| File | Content |
|---|---|
| `preview.png` | the whole frame at 1x; if its long side exceeds 8000 px, it is scaled down to 8000 px |
| `sections/*.png` | each section at `settings.sectionScale`, scaled down to 8000 px on the long side if needed |
| `assets/icon-*.svg`, `assets/illustration-*.svg` | icons and illustrations |
| `assets/img-*.<ext>` | original images from image fills: `png`, `jpg`, `gif`, `webp` (`bin` if unknown) |
| `assets/<name>[-<suffix>][@<n>x].<ext>` | files from a layer's Export settings |
| `components/<set>/<variant>.png` | each variant at 2x |

Identical assets are stored once, so several layers can point to the same path.

## outline.txt

One line per layer, indented two spaces per nesting level: type, name, size, position, layout, size mode, fill, border, radius, effects, text and component. An agent reads it first to find its way around and then opens `tree.json` for exact values. The file is stable. The line syntax is informational.

```
FRAME "Hero" 1440x800 @0,0 [row gap auto align space_between/center pad 80/120] fill/fixed bg #0f172a{Colors/Primary} r16/16/0/0 fx shadow
  TEXT "Title" 600x128 @120,80 fill/hug Inter Bold 56/64 #ffffff "Engineering workflows" +1 styles
  GROUP "Arrow" 24x24 @1320,398 colors #000000 -> assets/icon-arrow.svg
  INSTANCE "Button" 160x48 @120,400 bg #000000 <Button: State=Default>
```

## Format history

| Format | Plugin | Change |
|---|---|---|
| 1.0 | 1.2.0 | first documented version; `formatVersion` added to `manifest.json` |
