import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
export const builtinBash = (await import(resolve(root, 'dist/index.js'))).createBashToolDefinition;
export const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-ai': resolve(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { default: extension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
export const settings = await jiti.import(fileURLToPath(new URL('./settings.ts', import.meta.url)));
export const extractSettings = await jiti.import(fileURLToPath(new URL('../extract/settings.ts', import.meta.url)));
export async function until(predicate, timeout = 5000) {
    const end = Date.now() + timeout;
    while (!(await predicate())) {
        if (Date.now() > end) throw new Error('Managed process test timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
export function setup(t, mode = 'tui') {
    const directory = mkdtempSync(join(tmpdir(), 'pi-managed-test-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const events = new Map(), commands = new Map(), tools = new Map(), renderers = new Map(), messages = [], notices = [];
    const state = { directory, events, commands, tools, renderers, messages, notices, autoDeliver: true };
    const bus = new EventEmitter();
    const eventBus = { emit: (name, data) => bus.emit(name, data), on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); } };
    extension({
        events: eventBus,
        on(name, handler) {
            const previous = events.get(name);
            events.set(name, previous ? (...args) => { const value = previous(...args); return handler(...args) ?? value; } : handler);
        },
        registerTool(tool) { tools.set(tool.name, tool); },
        registerCommand(name, command) { commands.set(name, command); },
        registerMessageRenderer(name, renderer) { renderers.set(name, renderer); },
        sendMessage(message, options) {
            messages.push({ message, options });
            if (state.autoDeliver) queueMicrotask(() => events.get('message_end')?.({ message: { role: 'custom', ...message } }, ctx));
        },
    });
    const tui = { terminal: { columns: 70, rows: 16 }, requestRender() {},
        setFocus() {}, stop() { state.stopped = true; }, start() { state.stopped = false; } };
    const theme = { fg: (_color, text) => text };
    const ctx = { mode, cwd: directory, isIdle: () => true,
        model: { provider: 'test', id: 'current-model' }, thinkingLevel: 'low',
        sessionManager: { getSessionId: () => 'test-session', getSessionFile: () => undefined },
        ui: { setWidget(_key, factory) { factory(tui, theme); }, notify(message) { notices.push(message); },
            custom(factory) { return new Promise(resolve => { state.dialog = factory(tui, theme, {}, resolve); }); } },
    };
    t.after(() => {
        events.get('session_shutdown')();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
    });
    events.get('session_start')({}, ctx);
    return Object.assign(state, { ctx, tui, theme,
        run: (args, signal, onUpdate) => tools.get('bash').execute('test', args, signal, onUpdate, ctx),
        list: async () => JSON.parse((await tools.get('pty_list').execute()).content[0].text),
        snapshot: async id => JSON.parse((await tools.get('pty_snapshot').execute('', { id })).content[0].text),
        exits: () => messages.filter(entry => entry.message.customType === 'process-exit'),
    });
}
