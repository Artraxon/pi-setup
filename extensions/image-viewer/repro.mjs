#!/usr/bin/env node
// Standalone reproduction against the INSTALLED Pi TUI, not the extension.
// Usage: node repro.mjs /absolute/path/to/image.png
// Requires Kitty graphics. No provider, credentials, model calls or Pi settings.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) {
    console.error('Usage: node repro.mjs /absolute/path/to/image.png');
    process.exit(2);
}
const cli = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(cli);
const { ProcessTerminal, TuiAltScreen, Image, Text, matchesKey, isKeyRelease } =
    await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);

const tui = new TuiAltScreen(new ProcessTerminal());
const image = new Image(readFileSync(process.argv[2]).toString('base64'), 'image/png',
    { fallbackColor: text => text }, { maxWidthCells: 40, maxHeightCells: 12 });
tui.addChild(image);
tui.addChild(new Text('r: forced full redraw (Pi 1.5 bug: image disappears) | q/Esc: quit', 0, 0));
tui.setFocus({
    render: () => [], invalidate() {},
    handleInput(data) {
        if (isKeyRelease(data)) return;
        if (matchesKey(data, 'r')) tui.requestRender(true);
        if (matchesKey(data, 'q') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
            tui.stop(); process.exit(0);
        }
    },
});
tui.start();
