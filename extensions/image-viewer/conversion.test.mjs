import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const tuiPath = resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js');
const tui = await import(tuiPath);
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': tuiPath,
    '@earendil-works/pi-coding-agent': resolve(root, 'dist/index.js'),
} });
const { default: extension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));

test('non-PNG content is converted remotely in memory before opening; conversion errors leave hooks usable', async () => {
    tui.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    const gif = new tui.Image('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'image/gif', { fallbackColor: s => s });
    const corrupt = new tui.Image('invalid', 'image/png', { fallbackColor: s => s });
    const events = new Map(), commands = new Map(), notices = [], pictures = [];
    const host = { children: [gif, corrupt], requestRender() {}, terminal: { rows: 24 } };
    const ctx = { mode: 'tui', ui: {
        setWidget(_name, factory) { factory(host); },
        notify(message) { notices.push(message); },
        async custom(factory) {
            const viewer = factory(host, { fg: (_token, text) => text }, {}, () => {});
            pictures.push(viewer.render(80));
            viewer.close();
        },
    } };
    extension({ on(name, fn) { events.set(name, fn); }, registerCommand(name, cmd) { commands.set(name, cmd); } });
    events.get('session_start')({}, ctx);
    try {
        await commands.get('image').handler('2', ctx);
        assert.match(notices[0], /Could not decode/);
        await commands.get('image').handler('1', ctx);
        assert.equal(pictures.length, 1);
        assert.ok(pictures[0].at(-1).includes('1×1'));
        assert.ok(pictures[0].some(line => line.includes('f=100')));
    } finally { events.get('session_shutdown')(); }
});
