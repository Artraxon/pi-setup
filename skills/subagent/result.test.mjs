import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti, until } from '../../extensions/pty-sessions/managed-fixture.mjs';
import { NotificationChannel } from '../../extensions/notifications/channel.ts';
import { finalResponse, initializeSubagent, readRecord, readResult, turnFile, writeRecord, MAX_RESULT_BYTES } from '../../extensions/pty-sessions/subagent-store.ts';
import { childArguments, launchOptions } from './launch.mjs';
const { default: reporter } = await jiti.import(fileURLToPath(new URL('./report.ts', import.meta.url)));
const { getSubagentResult } = await jiti.import(fileURLToPath(new URL('../../extensions/pty-sessions/subagent-result.ts', import.meta.url)));
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const sdk = await import(resolve(dirname(executable), '../../dist/index.js'));

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'pi-subagent-result-'));
    const previous = { ...process.env };
    process.env.PI_CODING_AGENT_DIR = directory;
    const notifications = [], statusSnapshots = [];
    const processRecord = { id: 'pty-1', running: true, privateOutput: false, dataDirectory: join(directory, 'process-data', 'result-test') };
    const channel = new NotificationChannel({ onNotify(batch) { notifications.push(...batch); }, onStatus(message) {
        processRecord.statusText = message.text;
        if (message.text.startsWith('Result ready')) statusSnapshots.push(readResult(processRecord.dataDirectory, processRecord.id));
    } });
    const env = channel.create(processRecord.id).environment(process.env);
    Object.assign(process.env, env, { PI_SUBAGENT_DIR: processRecord.dataDirectory, PI_PROCESS_SOCKET: env.PI_NOTIFY_SOCKET,
        PI_PROCESS_ID: processRecord.id, PI_PROCESS_PRIVATE: '0' });
    const sessionDirectory = initializeSubagent(processRecord.dataDirectory, processRecord.id);
    const manager = sdk.SessionManager.create(directory, sessionDirectory);
    const handlers = new Map();
    reporter({ on(name, handler) { handlers.set(name, handler); } });
    const context = { sessionManager: manager };
    const sessions = { sessions: new Map([[processRecord.id, processRecord]]) };
    t.after(() => {
        handlers.get('session_shutdown')(); channel.close();
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
        rmSync(directory, { recursive: true, force: true });
    });
    return { directory, processRecord, notifications, statusSnapshots, manager, handlers, context, sessions,
        start: () => handlers.get('before_agent_start')({}, context),
        settle: (aborted = false) => handlers.get('agent_settled')({ aborted }, context),
        result: args => getSubagentResult(sessions, { id: processRecord.id, ...args }) };
}
const assistant = (text, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
    api: 'openai-completions', provider: 'test', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(), ...extra });
const user = text => ({ role: 'user', content: text, timestamp: Date.now() });

test('launcher preserves a fresh interactive TUI, a private saved session and only the explicit reporter', () => {
    const options = launchOptions(['--tools', 'read,bash,edit,write', '--model', 'example/model', '--thinking', 'off', 'Scoped task']);
    const args = childArguments(options, '/tmp/isolated/session');
    assert.deepEqual(args.slice(0, 5), ['-ne', '-ns', '-np', '-nc', '--no-mcp']);
    assert.ok(args[args.indexOf('-e') + 1].endsWith('/report.ts'));
    assert.equal(args[args.indexOf('--session-dir') + 1], '/tmp/isolated/session');
    assert.equal(args[args.indexOf('--model') + 1], 'example/model');
    assert.equal(args.at(-1), 'Scoped task');
    assert.ok(!args.some(arg => ['--no-session', '--print', '--mode', '--continue', '--resume'].includes(arg)));
    assert.notEqual(args[args.indexOf('--session-id') + 1], childArguments(options, '/tmp/isolated/session')[args.indexOf('--session-id') + 1]);
    for (const bad of [['--mode', 'rpc'], ['--no-session'], ['one', 'two']]) assert.throws(() => launchOptions(bad));
});

test('settlement saves only final text before IPC reports; native JSONL retains the history outside parent context', async t => {
    const s = fixture(t);
    await s.start();
    s.manager.appendMessage(user('Review a large task'));
    s.manager.appendMessage(assistant('', { stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'DO_NOT_FORWARD_THINKING' }, { type: 'toolCall', id: 'call', name: 'read', arguments: {} }] }));
    s.manager.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'DO_NOT_FORWARD_TOOL_HISTORY '.repeat(10000) }], isError: false, timestamp: Date.now() });
    s.manager.appendMessage(assistant('', { content: [{ type: 'thinking', thinking: 'DO_NOT_FORWARD_THINKING' }, { type: 'text', text: 'Three concise findings.' }] }));
    await s.settle();
    await until(() => s.notifications.length === 1);
    assert.equal(s.notifications[0].id, 'pty-1');
    assert.match(s.notifications[0].text, /turn 1 completed.*subagent_result/);
    assert.equal(s.statusSnapshots.length, 1);
    assert.equal(s.statusSnapshots[0].output, 'Three concise findings.');
    assert.deepEqual(s.result(), { id: 'pty-1', turn: 1, status: 'completed', output: 'Three concise findings.' });
    assert.ok(JSON.stringify(s.result()).length < 150);
    assert.ok(readFileSync(s.manager.getSessionFile(), 'utf8').includes('DO_NOT_FORWARD_TOOL_HISTORY'));
    assert.ok(!JSON.stringify(readResult(s.processRecord.dataDirectory, 'pty-1')).includes('DO_NOT_FORWARD'));
    for (const file of ['subagent.json', 'latest.json', turnFile(1)]) assert.equal(statSync(join(s.processRecord.dataDirectory, file)).mode & 0o777, 0o600);
    assert.equal(statSync(s.processRecord.dataDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(join(s.processRecord.dataDirectory, 'sessions')).mode & 0o777, 0o700);
    await s.settle();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(s.notifications.length, 1, 'duplicate settlement does not notify twice');
    s.processRecord.running = false;
    assert.equal(s.result().output, 'Three concise findings.', 'result survives child exit');
});

test('reusable child results are numbered; running/error/aborted turns never return a prior answer', async t => {
    const s = fixture(t);
    assert.equal(s.result().status, 'idle');
    await s.start(); s.manager.appendMessage(user('First')); s.manager.appendMessage(assistant('First answer')); await s.settle();
    await s.start(); s.manager.appendMessage(user('Follow-up'));
    assert.deepEqual(s.result(), { id: 'pty-1', turn: 2, status: 'running', output: '' });
    assert.equal(s.result({ turn: 1 }).output, 'First answer');
    s.manager.appendMessage(assistant('Incomplete output', { stopReason: 'length' })); await s.settle();
    assert.equal(s.result().status, 'error'); assert.equal(s.result().output, '');
    await s.start(); s.manager.appendMessage(user('Third')); s.manager.appendMessage(assistant('Partial output', { stopReason: 'aborted' })); await s.settle(true);
    assert.equal(s.result().status, 'aborted'); assert.equal(s.result().output, '');
    assert.equal(s.result({ turn: 1 }).output, 'First answer');
    await assert.rejects(async () => s.result({ turn: 99 }), /No saved/);
});

test('result reader paginates long answers without splitting Unicode and omits session/history metadata', async t => {
    const s = fixture(t), output = '🙂' + 'long answer '.repeat(2000);
    await s.start(); s.manager.appendMessage(user('Long')); s.manager.appendMessage(assistant(output)); await s.settle();
    let offset = 0, combined = '';
    do {
        const result = s.result({ offset, max_chars: offset === 0 ? 1 : 1000 });
        assert.ok(result.output.isWellFormed()); combined += result.output;
        assert.equal(result.sessionFile, undefined);
        if (!result.truncated) break;
        assert.ok(result.next_offset > offset); offset = result.next_offset;
        assert.ok(existsSync(result.result_file));
    } while (true);
    assert.equal(combined, output);
    for (const args of [{ max_chars: 0 }, { max_chars: 65537 }, { turn: '../latest' }, { offset: -1 }, { offset: 1 }]) assert.throws(() => s.result(args));
    assert.throws(() => getSubagentResult(s.sessions, { id: 'missing' }), /Unknown/);
    s.processRecord.privateOutput = true;
    assert.throws(() => s.result(), /Private/);
});

test('active-branch selection rejects tool-only, missing and switched-branch runs instead of returning stale text', () => {
    const entry = (id, message) => ({ id, type: 'message', message });
    const old = entry('old', assistant('Previous branch answer'));
    const tool = entry('tool', assistant('Tool preamble', { stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'x' }] }));
    assert.equal(finalResponse([old, entry('u', user('New task')), tool], 'old', false).status, 'error');
    assert.equal(finalResponse([old, entry('u', user('New task'))], 'old', false).output, '');
    assert.equal(finalResponse([old], 'different-branch', false).status, 'error');
    assert.equal(finalResponse([old], null, true).status, 'aborted');
});

test('result storage rejects symlinks, oversized/corrupt/mismatched records and workspace reuse', async t => {
    const s = fixture(t), directory = s.processRecord.dataDirectory;
    assert.throws(() => initializeSubagent(directory, 'pty-1'), /already has/);
    const target = join(s.directory, 'outside.json');
    writeFileSync(target, JSON.stringify({ version: 1, id: 'pty-1', turn: 1, status: 'completed', output: 'do not read' }));
    rmSync(join(directory, 'latest.json')); symlinkSync(target, join(directory, 'latest.json'));
    assert.throws(() => s.result(), /ELOOP|symlink/i);
    rmSync(join(directory, 'latest.json'));
    writeRecord(directory, 'latest.json', { version: 1, id: 'pty-2', turn: 1, status: 'completed', output: 'wrong process' });
    assert.throws(() => s.result(), /Invalid/);
    writeFileSync(join(directory, 'latest.json'), 'not json'); assert.throws(() => s.result());
    assert.throws(() => writeRecord(directory, 'too-big.json', { output: 'x'.repeat(MAX_RESULT_BYTES) }), /8 MiB/);
    writeFileSync(join(directory, 'latest.json'), 'x'.repeat(MAX_RESULT_BYTES + 1)); assert.throws(() => s.result(), /oversized/);
});

test('real SDK lifecycle exports a settled answer and follow-up without UI scraping or a network/model call', async t => {
    const s = fixture(t);
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: s.directory, agentDir: s.directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [fileURLToPath(new URL('./report.ts', import.meta.url))] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(s.directory, 'auth.json'), modelsPath: join(s.directory, 'models.json') });
    await modelRuntime.setRuntimeApiKey('openai', 'local-test-not-a-real-key');
    const model = { id: 'gpt-4o', name: 'Test', provider: 'openai', api: 'openai-completions', baseUrl: 'http://invalid.local',
        reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { session } = await sdk.createAgentSession({ cwd: s.directory, agentDir: s.directory, sessionManager: s.manager,
        settingsManager, resourceLoader, modelRuntime, model, thinkingLevel: 'off', noTools: true });
    const ai = await import(resolve(dirname(executable), '../../node_modules/@earendil-works/pi-ai/dist/index.js'));
    const errors = [];
    await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
    let count = 0;
    session.agent.streamFunction = () => {
        const stream = ai.createAssistantMessageEventStream();
        const message = assistant(`SDK final answer ${++count}`, { provider: 'openai', model: 'gpt-4o' });
        queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
        return stream;
    };
    try {
        await session.prompt('First scoped task');
        assert.equal(s.result().output, 'SDK final answer 1'); assert.equal(s.result().turn, 1);
        await session.prompt('Follow-up task');
        assert.equal(s.result().output, 'SDK final answer 2'); assert.equal(s.result().turn, 2);
        assert.equal(s.result({ turn: 1 }).output, 'SDK final answer 1');
        assert.deepEqual(errors, []);
        assert.ok(existsSync(s.manager.getSessionFile()));
    } finally { session.dispose(); }
});

test('large final responses produce an explicit export error, not a false completion or raw history fallback', async t => {
    const s = fixture(t);
    await s.start(); s.manager.appendMessage(user('Large')); s.manager.appendMessage(assistant('x'.repeat(MAX_RESULT_BYTES))); await s.settle();
    assert.equal(s.result().status, 'error'); assert.equal(s.result().output, '');
    assert.match(s.result().error, /Could not save/);
});
