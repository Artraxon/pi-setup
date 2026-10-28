import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from './managed-fixture.mjs';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const root = resolve(dirname(executable), '../..');
const sdk = await import(resolve(root, 'dist/index.js'));
const ai = await import(resolve(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'));
const assistant = (content, stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
    api: 'openai-completions', provider: 'openai', model: 'gpt-4o', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test('real parent SDK preserves a completion when Escape clears follow-ups and aborts the parent run', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'pi-notification-abort-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [fileURLToPath(new URL('./index.ts', import.meta.url))] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') });
    await modelRuntime.setRuntimeApiKey('openai', 'local-test-not-a-real-key');
    const model = { id: 'gpt-4o', name: 'Test', provider: 'openai', api: 'openai-completions', baseUrl: 'http://invalid.local', reasoning: false,
        input: ['text'], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, model, resourceLoader,
        settingsManager, sessionManager: sdk.SessionManager.inMemory(directory), thinkingLevel: 'off', tools: ['bash'] });
    const errors = [];
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    t.after(async () => {
        await session.abort();
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(directory, { recursive: true, force: true });
    });
    let requests = 0;
    const accepted = join(directory, 'accepted');
    session.agent.streamFunction = (_model, _context, options) => {
        const stream = ai.createAssistantMessageEventStream(), request = ++requests;
        const message = request === 1 ? assistant([{ type: 'toolCall', id: 'launch', name: 'bash', arguments: {
            command: `pi-process notify 'completion-abort-repro'; printf accepted > '${accepted}'; sleep 30`, yield_after: 0,
        } }], 'toolUse') : assistant([{ type: 'text', text: request === 2 ? '' : 'Child completion received.' }], request === 2 ? 'pending' : 'stop');
        queueMicrotask(() => {
            stream.push({ type: 'start', partial: message });
            if (request === 2) {
                const abort = () => { stream.push({ type: 'error', reason: 'aborted', error: assistant([], 'aborted') }); stream.end(); };
                if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
            } else { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); }
        });
        return stream;
    };
    const running = session.prompt('Start a child, then keep working.');
    await until(() => requests >= 2 && existsSync(accepted));
    await new Promise(resolve => setTimeout(resolve, 250)); // IPC batching has run while the parent is busy.
    assert.equal(session.messages.filter(message => message.role === 'custom' && message.customType === 'process-message').length, 0);
    session.clearQueue(); // This is what the interactive Escape path does.
    await session.abort(); await running;
    await until(() => session.messages.some(message => message.role === 'custom' && message.customType === 'process-message'), 2000);
    await until(() => session.isIdle && requests === 3);
    const reports = session.messages.filter(message => message.role === 'custom' && message.customType === 'process-message');
    assert.equal(reports.length, 1);
    assert.match(reports[0].content, /completion-abort-repro/);
    assert.equal(session.getLastAssistantText(), 'Child completion received.');
    assert.deepEqual(errors, []);
});
