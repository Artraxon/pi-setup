import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const { createClionFileActions } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
const pycharm = { name: 'PyCharm', url: 'http://127.0.0.1:29172/index-mcp/streamable-http' };
const clion = { name: 'CLion', url: 'http://127.0.0.1:29177/index-mcp/streamable-http' };

function setup(t, overrides = {}, mode = 'json') {
    const directory = mkdtempSync(join(tmpdir(), 'clion-extension-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'File.cpp'), '');
    const events = new Map(), commands = new Map(), opened = [], notices = [];
    let transform, discoveries = 0, saved;
    const host = { setFocus() {}, requestRender() {}, openUrl() {} };
    const originalFocus = host.setFocus;
    const theme = { fg: (_color, text) => text };
    const dependencies = {
        discoverIdeEndpoints: async () => { discoveries++; return [pycharm, clion]; },
        preferredIdeUrl: () => saved,
        savePreferredIdeUrl: url => { saved = url; },
        openInClion: async (...args) => { opened.push(args); },
        ...overrides,
    };
    const pi = { on(name, handler) { events.set(name, handler); },
        registerCommand(name, command) { commands.set(name, command); },
        registerMarkdownTransformer(value) { transform = value; } };
    createClionFileActions(dependencies)(pi);
    const ctx = { cwd: directory, mode, hasUI: true, sessionManager: { getBranch: () => [] }, ui: {
        notify: (...args) => notices.push(args),
        setWidget(_key, factory) { factory(host, theme); },
        setStatus() {}, onTerminalInput: () => () => {},
    } };
    const settings = () => {
        const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }] };
        host.setFocus(list);
        return list.items.find(item => item.id === 'ide-file-links');
    };
    return { directory, events, commands, ctx, host, originalFocus, opened, notices, settings,
        transform: (...args) => transform(...args), discoveries: () => discoveries, saved: () => saved,
        reload() { createClionFileActions(dependencies)(pi); } };
}

test('CLion guidance is contributed every turn without replacing existing instructions; only assistant prose is transformed', async t => {
    const s = setup(t);
    await s.events.get('session_start')({}, s.ctx);
    const options = { sections: { existing: 'keep me' } };
    s.events.get('before_agent_start')({ systemPromptOptions: options }, s.ctx);
    assert.equal(options.sections.existing, 'keep me');
    assert.match(options.sections.clion_file_references, /CLion-compatible Markdown links/);
    const first = options.sections.clion_file_references;
    s.events.get('before_agent_start')({ systemPromptOptions: options }, s.ctx);
    assert.equal(options.sections.clion_file_references, first);
    assert.equal(s.transform('See `File.cpp:7`.', { messageType: 'assistant', isStreaming: true }), 'See [File.cpp:7](File.cpp#L7).');
    for (const messageType of ['user', 'assistant-thinking']) assert.equal(s.transform('See `File.cpp:7`.', { messageType }), 'See `File.cpp:7`.');
    assert.equal(s.discoveries(), 1);
    assert.equal(s.opened.length, 0, 'startup never opens files');
});

test('startup selects the first available IDE; settings changes navigation immediately and survives /reload', async t => {
    const s = setup(t, {}, 'tui');
    await s.events.get('session_start')({}, s.ctx);
    t.after(() => s.events.get('session_shutdown')({}, s.ctx));
    assert.match(s.settings().currentValue, /PyCharm.*29172/);
    await s.commands.get('clion').handler('File.cpp:7:2', s.ctx);
    assert.equal(s.opened[0][2], pycharm.url);
    assert.equal(s.opened[0][0].line, 7);
    assert.equal(s.opened[0][0].column, 2);
    let selected;
    const row = s.settings();
    const menu = row.submenu(row.currentValue, value => { selected = value; });
    menu.selectItem(clion.url);
    menu.handleInput('\r');
    assert.match(selected, /CLion.*29177/);
    assert.equal(s.saved(), clion.url);
    await s.commands.get('clion').handler('File.cpp', s.ctx);
    assert.equal(s.opened[1][2], clion.url);
    assert.match(s.settings().currentValue, /CLion.*29177/);
    // /reload shuts down the old runtime, constructs a new one and emits session_start.
    s.events.get('session_shutdown')({}, s.ctx);
    assert.equal(s.host.setFocus, s.originalFocus);
    s.reload();
    await s.events.get('session_start')({}, s.ctx);
    assert.equal(s.discoveries(), 2);
    assert.match(s.settings().currentValue, /CLion.*29177/);
    await s.commands.get('clion').handler('File.cpp', s.ctx);
    assert.equal(s.opened[2][2], clion.url);
});

test('unavailable saved preference falls back; no IDE is clearly shown and does not attempt navigation', async t => {
    const s = setup(t, { preferredIdeUrl: () => 'http://offline' }, 'tui');
    await s.events.get('session_start')({}, s.ctx);
    assert.match(s.settings().currentValue, /PyCharm/);
    s.events.get('session_shutdown')({}, s.ctx);
    const none = setup(t, { discoverIdeEndpoints: async () => [] }, 'tui');
    await none.events.get('session_start')({}, none.ctx);
    t.after(() => none.events.get('session_shutdown')({}, none.ctx));
    assert.match(none.settings().currentValue, /None found/);
    assert.equal(none.settings().submenu, undefined);
    await none.commands.get('clion').handler('File.cpp', none.ctx);
    assert.equal(none.opened.length, 0);
    assert.match(none.notices[0][0], /No available IDE.*\/reload/);
});

test('shutdown cancels discovery and late results cannot install stale UI', async t => {
    let finish, signal;
    const s = setup(t, { discoverIdeEndpoints: options => {
        signal = options.signal;
        return new Promise(resolve => { finish = resolve; });
    } }, 'tui');
    const start = s.events.get('session_start')({}, s.ctx);
    s.events.get('session_shutdown')({}, s.ctx);
    assert.equal(signal.aborted, true);
    finish([pycharm]);
    await start;
    assert.equal(s.host.setFocus, s.originalFocus);
    assert.equal(s.settings(), undefined);
    assert.equal(s.opened.length, 0);
});
