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
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { createPasteDialog } = await jiti.import(fileURLToPath(new URL('./paste.ts', import.meta.url)));

test('large bracketed paste stays compact and expands completely for Enter and Ctrl+G', () => {
    const blob = 'a source line with exact details\n'.repeat(3000) + 'last line';
    for (const [key, edit] of [['\r', false], ['\x07', true]]) {
        let result;
        const component = createPasteDialog({ terminal: { rows: 30, columns: 100 }, requestRender() {} },
            { fg: (_color, text) => text }, value => { result = value; });
        component.focused = true;
        component.handleInput('\x1b[200~' + blob + '\x1b[201~');
        const display = component.render(100).join('\n');
        assert.ok(display.length < 2000, 'large pasted source must not be rendered in full');
        assert.match(display, /paste/i);
        component.handleInput(key);
        assert.deepEqual(result, { blob, edit });
    }
});

test('Escape and Ctrl+C cancel without accepting source', () => {
    for (const key of ['\x1b', '\x03']) {
        let called = false, result = 'not cancelled';
        const component = createPasteDialog({ terminal: { rows: 30, columns: 100 }, requestRender() {} },
            { fg: (_color, text) => text }, value => { called = true; result = value; });
        component.handleInput(key);
        assert.equal(called, true);
        assert.equal(result, undefined);
    }
});
