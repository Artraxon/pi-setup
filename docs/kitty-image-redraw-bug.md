# Pi 1.5.0: Kitty images disappear after a full redraw

**Affected component:** `@earendil-works/pi-tui` 1.5.0, fullscreen renderer, Kitty graphics protocol.

**Symptom:** An inline image disappears while its reserved space, surrounding text, and click target remain. Resizing or closing an image-viewer overlay can trigger it. SSH, Sway, and extensions are not required.

## Cause

In the installed package's `dist/tui-alt-screen.js`:

1. `prepareKittyScreen()` (lines 248–266) substitutes cached image transmissions with placement-only commands (`a=p`) when transmission generations match.
2. `doRender()` prepares those commands **before** performing a full redraw (lines 1478–1508).
3. The full-redraw buffer emits `a=d,d=a` (remove placements, retain data), followed by ED 2 (`CSI 2 J`), followed by the prepared image commands.
4. Kitty's ED 2 handling frees the now-unplaced image data. The subsequent `a=p` refers to a missing image; Pi's layout remains intact.

The upload cache therefore becomes inconsistent with terminal graphics state. Refreshing uploads only when dimensions change is insufficient: forced redraws at unchanged dimensions also trigger the bug.

## Minimal reproduction

From the Pi setup repository root, in Kitty:

```sh
node extensions/image-viewer/repro.mjs /absolute/path/to/image.png
```

Wait for the image, then press **r**. On the affected renderer, the image disappears but text remains. **q/Escape** quits. This uses only the installed Pi TUI library, without loading extensions, settings, or making model/API calls.

Alternatively, run `pi --no-extensions --tui-mode fullscreen`, display a PNG with the built-in `read` tool, and resize only the terminal height. Width changes can regenerate the upload and mask the bug.

## Fix and validation

Invalidate the renderer's uploaded-image cache **before preparing a frame that will emit ED 2**, so visible images are retransmitted after the clear. Preserve upload reuse on ordinary partial redraws.

The setup's [compatibility workaround](.devcontainer/pi/extensions/image-viewer/kitty-cache.ts#L16) implements this without modifying installed Pi files. The proper upstream fix belongs in Pi's renderer.

Verified the unpatched standalone reproducer's emitted commands through a pseudo-terminal: full clear, then `a=p`, without PNG retransmission. Regression tests use a graphics-state oracle to check repeated open/resize/close/full-redraw cycles, including unchanged dimensions. These checks are not a live visual test in Kitty/Sway.
