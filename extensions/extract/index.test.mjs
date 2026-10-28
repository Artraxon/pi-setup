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
    '@earendil-works/pi-coding-agent': resolve(root, 'dist/index.js'),
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    '@earendil-works/pi-ai': resolve(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
} });
const { createExtractExtension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));

function setup({ blob = 'secret source', failure, cancel = false, editorCancelled = false, idle = true, pasteEdit = false } = {}) {
    const events = new Map(), commands = new Map(), entries = [], notices = [], requests = [], edits = [];
    let prompt = 'existing draft';
    const model = { provider: 'openai', id: 'gpt-6.1-terra', maxTokens: 12000 };
    class Loader { signal = new AbortController().signal; dispose() {} }
    const dependencies = {
        BorderedLoader: Loader, editorCommand: () => 'vim',
        capturePaste: async () => editorCancelled ? undefined : { blob, edit: pasteEdit },
        captureBlob: async (_host, _command, initial) => { edits.push(initial); return editorCancelled ? undefined : blob; },
        runExtraction: async (...args) => {
            requests.push(args);
            if (cancel) return new Promise(() => {});
            if (failure) throw new Error(failure);
            return { output: 'extracted result', usage: { input: 12, output: 3 }, truncated: false };
        },
    };
    createExtractExtension(dependencies)({
        on(name, fn) { events.set(name, fn); },
        registerTool() {},
        registerCommand(name, value) { commands.set(name, value); },
        appendEntry(type, data) { entries.push({ type, data }); },
    });
    const ctx = { mode: 'tui', cwd: process.cwd(), isIdle: () => idle,
        modelRegistry: { find: () => model, hasConfiguredAuth: () => true },
        ui: {
            setWidget(_key, factory) { factory({}); },
            setEditorText(value) { prompt = value; },
            notify(message, level) { notices.push({ message, level }); },
            async custom(factory) {
                return new Promise(resolve => {
                    const loader = factory({}, {}, {}, resolve);
                    if (cancel) loader.onAbort();
                });
            },
        },
    };
    events.get('session_start')({}, ctx);
    return { run: (instructions, name = 'extract') => commands.get(name).handler(instructions, ctx), requests, entries, notices, edits, prompt: () => prompt };
}

test('/extract sends only the provided blob/instructions to the side model and stages the result', async () => {
    const s = setup();
    await s.run('extract failure messages');
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0][2], 'extract failure messages');
    assert.equal(s.requests[0][3], 'secret source');
    assert.equal(s.prompt(), 'extracted result');
    assert.equal(s.entries.length, 1);
    assert.equal(s.entries[0].type, 'extract-usage');
    assert.ok(!JSON.stringify(s.entries).includes('secret source'));
    assert.match(s.notices.at(-1).message, /Review and submit/);
});

test('/epaste bypasses Vim by default, or passes the complete blob to a prefilled editor', async () => {
    const blob = 'large source\n'.repeat(2000);
    for (const pasteEdit of [false, true]) {
        const s = setup({ blob, pasteEdit });
        await s.run('extract errors', 'epaste');
        assert.equal(s.requests[0][3], blob);
        assert.equal(s.prompt(), 'extracted result');
        assert.deepEqual(s.edits, pasteEdit ? [blob] : []);
    }
    for (const options of [{ blob: '' }, { editorCancelled: true }, { idle: false }]) {
        const s = setup(options);
        await s.run('', 'epaste');
        assert.equal(s.requests.length, 0);
        assert.equal(s.prompt(), 'existing draft');
    }
});

test('empty source, editor cancellation, model failure, request cancellation and busy state preserve the draft', async () => {
    for (const options of [{ blob: '' }, { editorCancelled: true }, { failure: 'model failed' }, { cancel: true }, { idle: false }]) {
        const s = setup(options);
        await s.run('');
        assert.equal(s.prompt(), 'existing draft');
        assert.equal(s.entries.length, 0);
    }
});
