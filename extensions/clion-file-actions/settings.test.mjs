import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { preferredIdeUrl, savePreferredIdeUrl, installIdeSettings } = await jiti.import(fileURLToPath(new URL('./settings.ts', import.meta.url)));

function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'ide-settings-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

test('manual preference persists in independent settings and preserves unrelated keys', t => {
    const directory = setup(t);
    assert.equal(preferredIdeUrl(), undefined);
    writeFileSync(join(directory, 'ide-file-links.json'), JSON.stringify({ other: true }));
    savePreferredIdeUrl('http://127.0.0.1:29172/index-mcp/streamable-http');
    assert.match(preferredIdeUrl(), /29172/);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'ide-file-links.json'))), {
        other: true, preferredUrl: 'http://127.0.0.1:29172/index-mcp/streamable-http',
    });
    writeFileSync(join(directory, 'ide-file-links.json'), '{ broken');
    assert.throws(() => preferredIdeUrl(), /Cannot read/);
    assert.throws(() => savePreferredIdeUrl('http://localhost'), /Cannot read/);
    assert.equal(readFileSync(join(directory, 'ide-file-links.json'), 'utf8'), '{ broken');
});

test('settings shows the selection once, only lists available endpoints, and cancel leaves it unchanged', t => {
    const theme = { fg: (_color, text) => text };
    const host = { setFocus() {} }, original = host.setFocus;
    const available = [{ name: 'PyCharm', url: 'http://127.0.0.1:29172/test' }, { name: 'CLion', url: 'http://127.0.0.1:29177/test' }];
    const selection = { available, selected: available[0] };
    const chosen = [];
    const cleanup = installIdeSettings(host, theme, { ui: { notify() {} } }, selection, endpoint => chosen.push(endpoint));
    t.after(cleanup);
    const unrelated = { items: [{ id: 'other' }] };
    host.setFocus(unrelated);
    assert.equal(unrelated.items.length, 1);
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }] };
    host.setFocus(list); host.setFocus(list);
    assert.equal(list.items.filter(item => item.id === 'ide-file-links').length, 1);
    const row = list.items[0];
    assert.match(row.currentValue, /PyCharm.*29172/);
    let finished = false, result;
    const menu = row.submenu(row.currentValue, value => { finished = true; result = value; });
    assert.equal(menu.items.length, 2);
    menu.selectItem(available[1].url);
    menu.handleInput('\x1b');
    assert.equal(finished, true);
    assert.equal(result, undefined);
    assert.equal(chosen.length, 0);
    assert.equal(selection.selected, available[0]);
    cleanup();
    assert.equal(host.setFocus, original);
});

test('a failed preference save reports the error without committing a selection', t => {
    const theme = { fg: (_color, text) => text }, notices = [];
    const host = { setFocus() {} };
    const endpoint = { name: 'PyCharm', url: 'http://127.0.0.1:29172/test' };
    const cleanup = installIdeSettings(host, theme, { ui: { notify: (...args) => notices.push(args) } },
        { available: [endpoint], selected: endpoint }, () => { throw new Error('read-only configuration'); });
    t.after(cleanup);
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }] };
    host.setFocus(list);
    let finished = false;
    list.items[0].submenu('', () => { finished = true; }).handleInput('\r');
    assert.equal(finished, false);
    assert.match(notices[0][0], /read-only configuration/);
    assert.equal(notices[0][1], 'error');
});
