import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const packageRoot = resolve(dirname(executable), '../..');
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-ai': resolve(packageRoot, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
    '@earendil-works/pi-tui': resolve(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const extension = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));

async function until(predicate) {
    const end = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('extension test timed out');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}

test('public/private tools, picker keys, foreground detach and shutdown', async () => {
    const events = new Map(), commands = new Map(), tools = new Map(), messages = [];
    let previewRenderer;
    const bus = new EventEmitter();
    extension.default({
        events: { emit: (name, data) => bus.emit(name, data), on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); } },
        on(name, handler) { const previous = events.get(name); events.set(name, previous ? (...args) => { previous(...args); return handler(...args); } : handler); },
        registerTool(tool) { tools.set(tool.name, tool); },
        registerCommand(name, command) { commands.set(name, command); },
        registerMessageRenderer(name, renderer) { if (name === 'pty-preview') previewRenderer = renderer; },
        sendMessage(message) { messages.push(message); },
    });
    let stopped = false, menu;
    const tui = { terminal: { columns: 60, rows: 16 }, requestRender() {},
        stop() { stopped = true; }, start() { stopped = false; } };
    const ctx = { mode: 'tui', isIdle: () => true, cwd: process.cwd(), ui: {
        setWidget(_key, factory) { factory(tui); },
        notify() {},
        async custom(factory) {
            return new Promise(resolve => {
                menu = factory(tui, { fg: (_color, text) => text }, {}, resolve);
                assert.ok(menu.render(60).length <= 10);
                menu.handleInput('\x0a'); // Ctrl+J moves down, does not select.
                menu.handleInput('\x0b'); // Ctrl+K moves up.
                menu.handleInput('\x1b'); // Escape cancels.
            });
        },
    } };
    const list = async () => JSON.parse((await tools.get('pty_list').execute()).content[0].text);
    const snapshot = async id => JSON.parse((await tools.get('pty_snapshot').execute('', { id })).content[0].text);
    try {
        events.get('session_start')({}, ctx);
        const publicResult = await events.get('user_bash')({ command: 'echo public; sleep 30', cwd: process.cwd(), excludeFromContext: false }, ctx);
        assert.match(publicResult.result.output, /Started pty-1/);
        await events.get('user_bash')({ command: 'echo hidden; sleep 30', cwd: process.cwd(), excludeFromContext: true }, ctx);
        assert.equal(messages.length, 2);
        assert.ok(messages.every(message => !message.content.includes('hidden')));
        assert.equal((await list())[0].command, '[private !! session]');
        await assert.rejects(snapshot('pty-2'), /Private/);
        await until(() => messages.length === 2);
        await commands.get('top').handler('', ctx);
        // Attach using the real raw-input handler but a mocked Pi TUI. Only the
        // explicit focused input goes to the PTY; Ctrl+Z detaches without SIGTSTP.
        const originalWrite = process.stdout.write;
        process.stdout.write = () => true;
        try {
            const attachment = commands.get('fg').handler('pty-1', ctx);
            await until(() => stopped);
            process.stdin.emit('data', Buffer.from('\x1a'));
            await attachment;
            assert.equal(stopped, false);
        } finally {
            process.stdout.write = originalWrite;
            process.stdin.pause();
        }
        assert.equal((await list()).find(s => s.id === 'pty-1').running, true);
        assert.match((await snapshot('pty-1')).screen, /public/);
        const preview = previewRenderer(messages[0], {}, { fg: (_color, text) => text });
        assert.ok(preview.render(60).length <= 10);
        const mouse = { type: 'click', button: 'left', ctrl: true, alt: false, shift: false,
            x: 0, y: 0, width: 60, height: 10, screenX: 0, screenY: 0 };
        assert.equal(preview.handleMouse({ ...mouse, ctrl: false }), undefined);
        process.stdout.write = () => true;
        try {
            assert.equal(preview.handleMouse(mouse).handled, true);
            await until(() => stopped);
            process.stdin.emit('data', Buffer.from('\x03'));
            await until(() => !stopped);
        } finally {
            process.stdout.write = originalWrite;
            process.stdin.pause();
        }
        assert.equal((await list()).find(s => s.id === 'pty-1').running, false);
        assert.equal((await list()).find(s => s.id === 'pty-2').running, true);
    } finally {
        events.get('session_shutdown')();
    }
});
