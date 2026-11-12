import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    '@earendil-works/pi-coding-agent': resolve(root, 'dist/index.js'),
} });
const settings = await jiti.import(fileURLToPath(new URL('./settings.ts', import.meta.url)));
function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'compact-settings-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

test('compact activity defaults on, persists boolean and preserves unrelated keys; malformed input is untouched', t => {
    const dir = setup(t), path = join(dir, 'compact-tools.json');
    assert.equal(settings.loadCompactActivityEnabled(), true);
    writeFileSync(path, JSON.stringify({ other: { keep: true } }));
    settings.saveCompactActivityEnabled(false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { other: { keep: true }, activityEnabled: false });
    assert.equal(settings.loadCompactActivityEnabled(), false);
    writeFileSync(path, '{bad');
    assert.throws(() => settings.saveCompactActivityEnabled(true), /Cannot read/);
    assert.equal(readFileSync(path, 'utf8'), '{bad');
    assert.throws(() => settings.loadCompactActivityEnabled(), /Cannot read/);
});

test('native /settings row persists before applying and cleans up idempotently', t => {
    const dir = setup(t), path = join(dir, 'compact-tools.json');
    let focused;
    const original = component => { focused = component; };
    const tui = { setFocus: original }, theme = { fg: (_color, text) => text };
    const notices = [], applied = [];
    const ctx = { ui: { notify: message => notices.push(message) } };
    const cleanup = settings.installCompactSettings(tui, theme, ctx, enabled => {
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).activityEnabled, enabled);
        applied.push(enabled);
    });
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }], applyFilter() {} };
    tui.setFocus(list);
    assert.equal(focused, list);
    assert.equal(list.items[0].id, 'compact-activity');
    assert.equal(list.items[0].currentValue, 'On');
    let chosen;
    const menu = list.items[0].submenu('On', value => chosen = value);
    menu.selectItem('compact-activity-choice');
    menu.handleInput('\r');
    assert.equal(chosen, 'Off');
    assert.deepEqual(applied, [false]);
    assert.equal(settings.loadCompactActivityEnabled(), false);
    cleanup(); cleanup();
    assert.equal(tui.setFocus, original);
});

test('save failure after opening the chooser does not apply or accept the new value', t => {
    const dir = setup(t), path = join(dir, 'compact-tools.json');
    const notices = [], applied = [];
    const tui = { setFocus() {} }, theme = { fg: (_color, text) => text };
    const cleanup = settings.installCompactSettings(tui, theme, { ui: { notify: m => notices.push(m) } }, v => applied.push(v));
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }] };
    tui.setFocus(list);
    let accepted;
    const menu = list.items[0].submenu('On', value => accepted = value);
    writeFileSync(path, '{changed-to-invalid-json');
    menu.handleInput('\r');
    assert.equal(accepted, undefined);
    assert.deepEqual(applied, []);
    assert.ok(notices.length > 0);
    assert.equal(readFileSync(path, 'utf8'), '{changed-to-invalid-json');
    cleanup();
});

test('failed persistence leaves active mode unchanged', t => {
    const dir = setup(t), path = join(dir, 'compact-tools.json');
    writeFileSync(path, '{broken');
    const notices = [], applied = [];
    const tui = { setFocus() {} }, theme = { fg: (_color, text) => text };
    const cleanup = settings.installCompactSettings(tui, theme, { ui: { notify: m => notices.push(m) } }, v => applied.push(v));
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }] };
    tui.setFocus(list);
    assert.equal(list.items.some(item => item.id === 'compact-activity'), false);
    assert.deepEqual(applied, []);
    assert.ok(notices.length > 0);
    assert.equal(readFileSync(path, 'utf8'), '{broken');
    cleanup();
});
