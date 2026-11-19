# figma-export

**Figma to code without the Figma MCP limits.** A Figma desktop plugin that exports the selected frames to a zip archive an AI coding agent can read: the layer tree with auto-layout and styles, CSS, design tokens and variables, component variants, PNG previews, SVG icons and original images. It works on the free Figma plan and makes no network requests.

## Why

Coding agents such as Claude Code or Cursor need structured design data to rebuild a layout: sizes, auto-layout, text styles, variables, component variants. The Figma MCP server provides this, but the free Figma plan allows only a few MCP calls a month. This plugin produces the same kind of data locally, once per frame, in files an agent reads one at a time: a short `outline.txt` first, exact values in `tree.json` and `tokens.json` when needed.

The archive format is a documented contract: [FORMAT.md](FORMAT.md) lists the files and fields that stay stable, so other tools can build on it.

## Install

1. Download the [latest release](https://github.com/superherono/figma-export/releases/latest) (Source code, zip) and unzip it, or `git clone` this repository.
2. Open the design in the **Figma desktop app** (development plugins do not run in the browser).
3. Figma menu → Plugins → Development → **Import plugin from manifest…**
4. Choose `manifest.json` from the downloaded folder.

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
  manifest.json          format version, file, page, date, options, frames, sections, warnings
  01-<frame>/
    outline.txt          one line per layer: type, name, size, position, layout, fill, text
    tree.json            all layer properties
    tokens.json          colors, typography, fonts, shadows, radii, spacing, variables, styles, with usage counts
    components.json      components in use: properties, variants, how each variant differs from the default
    preview.png          the whole frame at 1x (very tall frames are scaled down to 8000 px)
    sections/NN-*.png    visible children of the frame (a single wrapper is unwrapped), 2x or 1x
    assets/              icon-*.svg, illustration-*.svg, img-*.jpg|png (original photos), Export settings files
    components/<set>/    PNG of each variant, 2x
```

Cyrillic layer and frame names are transliterated to Latin in file and folder names.

Every field, which parts are stable and how format versions change: [FORMAT.md](FORMAT.md).

## Limitations

- Prototype animations are not exported. States such as hover are visible only when they are component variants.
- A library component whose variant set is not accessible is exported as one entry by instance name, without variants, and `manifest.json` gets a warning.
- Sets with more than 40 variants: names only. More than 40 sections: the section list without PNGs.
- Warnings go to `manifest.json` (`frames[].warnings`) and to the plugin window: failure type, count and the first layer names.
- If Figma does not return an instance's main component within 10 seconds, the export continues without that data.
- Code is limited to ES2017 syntax: older versions of the Figma plugin sandbox reject `?.` and `??`.

## Privacy

The plugin has no network access (`"networkAccess": {"allowedDomains": ["none"]}` in `manifest.json`). The archive is built inside Figma and saved only where you choose.

## Tests

```
npm test
```

Requires Node 20+ and Python 3: a test reads the generated zip with Python's `zipfile` to check it independently of the plugin code. The Figma API is replaced by a fake in `test/mock.js`. `test/review.test.js` holds regression tests for issues found in review.

## How AI was used

The plugin was written with Claude Code as the coding agent. I defined what the archive must contain for an agent to rebuild a layout, reviewed the output, and turned review findings into the regression tests in `test/review.test.js`. The archive itself is designed for agents: an agent reads `manifest.json` and `outline.txt` first and opens `tree.json`, `tokens.json` and section PNGs only for the parts it is building.

## License

[MIT](LICENSE)
