import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
    '@earendil-works/pi-ai': resolve(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
} });
const { registerExtractionTool } = await jiti.import(fileURLToPath(new URL('./tool.ts', import.meta.url)));
const { saveExtractionModel } = await jiti.import(fileURLToPath(new URL('./settings.ts', import.meta.url)));
function setup(t, extract) {
    const directory = mkdtempSync(join(tmpdir(), 'extract-tool-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
    });
    saveExtractionModel('test/cheap');
    let tool;
    const stop = registerExtractionTool({ registerTool(value) { tool = value; } }, extract);
    const model = { provider: 'test', id: 'cheap', maxTokens: 12000 };
    const ctx = { modelRegistry: { find(provider, id) { assert.equal(`${provider}/${id}`, 'test/cheap'); return model; }, hasConfiguredAuth: () => true } };
    return { tool, ctx, model, stop };
}

test('extract_text is callable from codemode, uses saved model, returns structured summary and bills nested usage without UI', async t => {
    const usage = { input: 100, output: 5, totalTokens: 105, cost: { total: 0.001 } };
    let request;
    const s = setup(t, async (...args) => { request = args; return { output: 'only the summary', usage, truncated: false }; });
    assert.equal(s.tool.exposure, 'codemode');
    assert.ok(s.tool.outputSchema);
    const blob = 'raw tool output\n'.repeat(10000);
    const result = await s.tool.execute('id', { text: blob, instructions: 'list failures', max_tokens: 2048 }, new AbortController().signal, undefined, s.ctx);
    assert.equal(request[1], s.model);
    assert.equal(request[2], 'list failures');
    assert.equal(request[3], blob);
    assert.equal(request[5], 2048);
    assert.deepEqual(result.structuredContent, { summary: 'only the summary', model: 'test/cheap', truncated: false });
    assert.equal(result.usage, usage);
    assert.ok(!JSON.stringify(result).includes('raw tool output'));
    s.stop();
});

test('truncation is explicit and model errors propagate as tool failures', async t => {
    const s = setup(t, async () => ({ output: 'partial', truncated: true }));
    const result = await s.tool.execute('id', { text: 'source' }, undefined, undefined, s.ctx);
    assert.equal(result.structuredContent.truncated, true);
    assert.match(result.content[0].text, /partial/);
    const broken = registerExtractionTool({ registerTool(tool) { s.tool = tool; } }, async () => { throw new Error('provider failed'); });
    await assert.rejects(s.tool.execute('id', { text: 'source' }, undefined, undefined, s.ctx), /provider failed/);
    broken();
});

test('caller cancellation and runtime shutdown abort side requests; invalid output limits do not call the model', async t => {
    let signal;
    const s = setup(t, async (_registry, _model, _instructions, _text, value) => {
        signal = value;
        return new Promise(resolve => value.addEventListener('abort', () => resolve(undefined), { once: true }));
    });
    const caller = new AbortController();
    const pending = s.tool.execute('id', { text: 'source' }, caller.signal, undefined, s.ctx);
    caller.abort();
    await assert.rejects(pending);
    assert.equal(signal.aborted, true);
    const pending2 = s.tool.execute('id2', { text: 'source' }, undefined, undefined, s.ctx);
    s.stop();
    await assert.rejects(pending2);
    assert.equal(signal.aborted, true);
    await assert.rejects(s.tool.execute('id3', { text: 'source', max_tokens: -1 }, undefined, undefined, s.ctx), /positive integer/);
});
