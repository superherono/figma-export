# figma-export

A Figma desktop plugin that exports the selected frames to a zip archive: the layer tree with styles, CSS, design tokens, PNG previews, icons and images. An AI coding agent reads the archive instead of calling the Figma MCP server. The plugin makes no network requests.

## Why

Coding agents need structured design data to rebuild a layout: sizes, auto-layout, text styles, variables, component variants. The Figma MCP server provides this, but the free Figma plan allows only a few MCP calls a month. This plugin produces the same kind of data locally, once per frame, in a format an agent can read file by file: a short `outline.txt` first, exact values in `tree.json` and `tokens.json` when needed.

## Install

1. Open the design in the **Figma desktop app** (development plugins do not run in the browser).
2. Figma menu → Plugins → Development → **Import plugin from manifest…**
3. Choose `manifest.json` from this repository.

If Figma rejects the `id` in the manifest: Plugins → Development → New plugin…, take the generated `id` and put it into `manifest.json`.

## Usage

1. Select one or more frames.
2. Plugins → Development → **figma-export**.
3. Check the options and click **Export**.
4. In the save dialog, choose a folder for exports (I keep a `figma-exports` folder next to each project, outside Git).
5. Give the archive name to the agent.

If the save dialog was closed, click **Save again**.

## Archive contents

```
<file>-<frame>-<YYYYMMDD-HHMM>.zip
  manifest.json          file, page, date, options, frames, sections, warnings
  01-<frame>/
    outline.txt          one line per layer: type, name, size, position, layout, fill, text
    tree.json            all layer properties (see below)
    tokens.json          colors, typography, fonts, shadows, radii, spacing, variables, styles, with usage counts
    components.json      components in use: properties, variants, how each variant differs from the default
    preview.png          the whole frame at 1x (very tall frames are scaled down to 8000 px)
    sections/NN-*.png    visible children of the frame (a single wrapper is unwrapped), 2x or 1x
    assets/              icon-*.svg, illustration-*.svg, img-*.jpg|png (original photos), Export settings files
    components/<set>/    PNG of each variant, 2x
```

Cyrillic layer and frame names are transliterated to Latin in file and folder names.

### A layer in tree.json

| Field | Meaning |
|---|---|
| `x`, `y` / `fx`, `fy` | position relative to the parent / to the root frame |
| `w`, `h` | size |
| `layout` | auto-layout: `mode`, `gap` (`auto` = space-between/around/evenly), `pad` [top, right, bottom, left], `alignMain`, `alignCross`, `wrap`; for Grid: rows, columns, tracks |
| `grids` | layout grids (columns or rows): count, gutter, width, offset |
| `size` | Fixed / Hug / Fill, horizontal and vertical |
| `absolute`, `constraints`, `grid` | behavior inside the parent |
| `fills`, `stroke`, `effects`, `radius`, `opacity`, `clip`, `mask` | appearance; a color bound to a variable is `{color, var}` |
| `text` | `chars` and `segments`: font, style, weight, size, line height, letter spacing, color, case, decoration, link, text style |
| `vars`, `styles` | names of bound variables and styles |
| `comp` | instance: component set, variant, property values (instance swap gives the component name; same-name properties keep the full `Name#id` key) |
| `css` | the layer's CSS from Figma (`getCSSAsync`) |
| `icon`, `illustration`, `asset`, `colors` | exported as one SVG; file path; colors inside |
| `exports` | files from Export settings |
| `error` | the layer could not be read: the reason (the rest of the frame is still exported) |

A layer is exported as one SVG (its children are not traversed) only if it consists of shapes without text or photos:
- with vectors: `icon-*` up to 256 px, `illustration-*` if larger;
- without vectors (rectangles, lines, ellipses): only a group of two or more shapes no larger than 48 px, such as a hamburger or a close icon.

An auto-layout container of several icons (social links, rating stars) is not an icon: it is traversed and each icon gets its own file. The root frame is always traversed. Inside component variants the traversal goes into icons as well, so that variant diffs show icon color changes.

## Limitations

- Prototype animations are not exported. States such as hover are visible only when they are component variants.
- A library component whose variant set is not accessible is exported as one entry by instance name, without variants, and `manifest.json` gets a warning.
- Sets with more than 40 variants: names only. More than 40 sections: the section list without PNGs.
- Warnings go to `manifest.json` (`frames[].warnings`) and to the plugin window: failure type, count and the first layer names.
- If Figma does not return an instance's main component within 10 seconds, the export continues without that data.
- Code is limited to ES2017 syntax: older versions of the Figma plugin sandbox reject `?.` and `??`.

## Tests

```
npm test
```

or `node --test test/`. Requires Node 20+ and Python: a test reads the generated zip with Python's `zipfile` to check it independently of the plugin code. The Figma API is replaced by a fake in `test/mock.js`. `test/review.test.js` holds regression tests for issues found in review.

## How AI was used

The plugin was written with Claude Code as the coding agent. I defined what the archive must contain for an agent to rebuild a layout, reviewed the output, and turned review findings into the regression tests in `test/review.test.js`. The archive itself is designed for agents: an agent reads `manifest.json` and `outline.txt` first and opens `tree.json`, `tokens.json` and section PNGs only for the parts it is building.

## License

[MIT](LICENSE)
