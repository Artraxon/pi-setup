import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jiti, until } from '../pty-sessions/managed-fixture.mjs';
import { sendNotification } from './pi-notify.mjs';
const { getNotificationService } = await jiti.import(fileURLToPath(new URL('./service.ts', import.meta.url)));
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const root = resolve(dirname(executable), '../..');
const sdk = await import(resolve(root, 'dist/index.js'));
const ai = await import(resolve(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'));

function runtime(t) {
    const bus = new EventEmitter(), handlers = new Map(), commands = new Map(), renderers = new Map(), sent = [], notices = [];
    const context = { isIdle: () => true, sessionManager: { getBranch: () => [] }, ui: { notify: message => notices.push(message) } };
    const emit = (name, ...args) => { for (const handler of handlers.get(name) ?? []) handler(...args); };
    const facade = () => ({
        events: { emit: (name, value) => bus.emit(name, value), on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); } },
        on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
        registerCommand(name, command) { assert.ok(!commands.has(name)); commands.set(name, command); },
        registerMessageRenderer(name, renderer) { assert.ok(!renderers.has(name)); renderers.set(name, renderer); },
        sendMessage(message, options) { sent.push({ message, options }); queueMicrotask(() => emit('message_end', { message: { role: 'custom', ...message } }, context)); },
    });
    t.after(() => emit('session_shutdown'));
    return { facade, emit, commands, context, sent, notices, bus };
}

test('different extension facades share one service without a global singleton or a process backend', async t => {
    const r = runtime(t), a = r.facade(), b = r.facade();
    assert.notEqual(a.events, b.events);
    const first = getNotificationService(a), second = getNotificationService(b);
    assert.equal(first, second); assert.equal(first.version, 3); assert.equal(r.commands.size, 3);
    r.emit('session_start', {}, r.context);
    const env = first.create('watcher').environment();
    assert.ok(!JSON.stringify(env).includes('TOKEN'));
    await sendNotification('notify', 'Standalone service works', { socket: env.PI_NOTIFY_SOCKET });
    await until(() => r.sent.length === 1);
    assert.match(r.sent[0].message.content, /Untrusted notifications/);
    assert.equal(r.sent[0].message.details.notifications[0].id, 'watcher');
    assert.deepEqual(r.sent[0].options, { triggerTurn: true, deliverAs: 'followUp' });
});

test('services are scoped to their Pi event buses and shutdown detaches stale service discovery', async t => {
    const a = runtime(t), b = runtime(t), first = getNotificationService(a.facade()), second = getNotificationService(b.facade());
    assert.notEqual(first, second);
    const x = first.create('x').environment(), y = second.create('y').environment();
    assert.notEqual(x.PI_NOTIFY_SOCKET, y.PI_NOTIFY_SOCKET);
    a.emit('session_shutdown'); assert.equal(first.closed, true); assert.throws(() => first.create('x'), /closed/);
    assert.equal(a.bus.listenerCount('pi-local-notifications:service/v3'), 0);
    assert.equal(second.closed, false);
});

test('endpoint consumers own their status handlers and lifetimes without a broadcast identity registry', async t => {
    const r = runtime(t), service = getNotificationService(r.facade()), a = [], b = [];
    const first = service.create('first', { onStatus: value => a.push(value) }), second = service.create('second', { onStatus: value => b.push(value) });
    await sendNotification('status', 'First', { socket: first.path }); assert.equal(a[0].text, 'First'); assert.equal(b.length, 0);
    first.close(); await sendNotification('status', 'Second', { socket: second.path }); assert.equal(b[0].text, 'Second'); assert.equal(a.length, 1);
    assert.equal(r.sent.length, 0);
});

test('separate commands create/reuse external sockets, list them and close only the requested endpoint', async t => {
    const r = runtime(t); getNotificationService(r.facade());
    const command = r.commands.get('create-socket').handler;
    const list = r.commands.get('list-sockets').handler, close = r.commands.get('close-socket').handler;
    assert.equal(r.commands.has('notify-socket'), false);
    const path = () => r.notices.at(-1).split('\n')[0].slice(8);
    await command('build watcher', r.context); const a = path();
    await command('test watcher', r.context); const b = path(); assert.notEqual(a, b);
    await command('build watcher', r.context); assert.equal(path(), a);
    await list('', r.context); assert.match(r.notices.at(-1), /build watcher: /); assert.match(r.notices.at(-1), /test watcher: /);
    await close('build watcher', r.context);
    await assert.rejects(sendNotification('notify', 'Closed', { socket: a }), /unavailable/);
    await sendNotification('status', 'Still open', { socket: b });
    await command('build watcher', r.context); assert.notEqual(path(), a);
});

test('socket commands validate arguments and cannot close a managed consumer endpoint', async t => {
    const r = runtime(t), service = getNotificationService(r.facade());
    const create = r.commands.get('create-socket').handler, list = r.commands.get('list-sockets').handler, close = r.commands.get('close-socket').handler;
    await list('', r.context); assert.equal(r.notices.at(-1), 'No active sockets.');
    await create(' ', r.context); assert.equal(r.notices.at(-1), 'Usage: /create-socket LABEL');
    await close('', r.context); assert.equal(r.notices.at(-1), 'Usage: /close-socket LABEL');
    await list('unexpected', r.context); assert.equal(r.notices.at(-1), 'Usage: /list-sockets');
    const owned = service.create('managed');
    await close('managed', r.context); assert.match(r.notices.at(-1), /No external endpoint/); assert.equal(owned.closed, false);
});

async function sdkFixture(t, extensions) {
    const directory = mkdtempSync(join(tmpdir(), 'pi-notify-sdk-'));
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: extensions });
    await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(directory, 'auth.json'), modelsPath: join(directory, 'models.json') });
    await modelRuntime.setRuntimeApiKey('openai', 'local-test-not-a-real-key');
    const model = { id: 'gpt-4o', name: 'Test', provider: 'openai', api: 'openai-completions', baseUrl: 'http://invalid.local', reasoning: false,
        input: ['text'], contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const { session } = await sdk.createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader, modelRuntime, model,
        sessionManager: sdk.SessionManager.inMemory(directory), thinkingLevel: 'off', noTools: true });
    const notices = [], errors = [];
    await session.bindExtensions({ mode: 'print', uiContext: { notify: value => notices.push(value) }, onError: value => errors.push(value) });
    let requests = 0;
    session.agent.streamFunction = () => {
        requests++;
        const stream = ai.createAssistantMessageEventStream();
        const message = { role: 'assistant', content: [{ type: 'text', text: 'External notification received.' }], stopReason: 'stop',
            api: 'openai-completions', provider: 'openai', model: 'gpt-4o', timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
        return stream;
    };
    let closed = false;
    const shutdown = async () => {
        if (closed) return;
        closed = true; await session.abort(); await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    };
    t.after(async () => { await shutdown(); rmSync(directory, { recursive: true, force: true }); });
    return { session, notices, errors, shutdown, requests: () => requests };
}

test('an already-running external process learns only the socket path later and wakes Pi without process-launching support', async t => {
    const client = new URL('./pi-notify.mjs', import.meta.url).href;
    const worker = spawn(process.execPath, ['--input-type=module', '-e', `
        import { sendNotification } from ${JSON.stringify(client)};
        process.on('message', async message => {
            try { await sendNotification('notify', message.text, { socket: message.socket }); process.send({ sent: true }); }
            catch (error) { process.send({ error: error.message }); }
        });
        process.send({ ready: true });
    `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
    t.after(() => { worker.kill('SIGKILL'); if (worker.connected) worker.disconnect(); });
    assert.deepEqual((await once(worker, 'message'))[0], { ready: true });
    const originalPid = worker.pid;
    const s = await sdkFixture(t, [fileURLToPath(new URL('./index.ts', import.meta.url))]);
    assert.ok(!s.session.getActiveToolNames().some(name => name.startsWith('pty_')));
    await s.session.prompt('/create-socket existing-worker');
    assert.equal(s.requests(), 0, 'endpoint discovery does not invoke a model');
    const socket = s.notices.find(value => value.startsWith('Socket: ')).split('\n')[0].slice(8);
    const response = once(worker, 'message'); worker.send({ socket, text: 'Work finished outside Pi' });
    assert.deepEqual((await response)[0], { sent: true }); assert.equal(worker.pid, originalPid);
    await until(() => s.requests() === 1 && s.session.isIdle);
    const reports = s.session.messages.filter(message => message.role === 'custom' && message.customType === 'process-message');
    assert.equal(reports.length, 1); assert.equal(reports[0].details.notifications[0].id, 'existing-worker');
    assert.match(reports[0].content, /Work finished outside Pi/);
    assert.equal(s.session.getLastAssistantText(), 'External notification received.');
    assert.deepEqual(s.errors, []);
    await s.session.prompt('/create-socket second-task');
    const nextSocket = s.notices.at(-1).split('\n')[0].slice(8);
    assert.notEqual(nextSocket, socket);
    const nextResponse = once(worker, 'message'); worker.send({ socket: nextSocket, text: 'Another task, no sender identity' });
    assert.deepEqual((await nextResponse)[0], { sent: true });
    await until(() => s.requests() === 2 && s.session.isIdle);
    const nextReport = s.session.messages.filter(message => message.role === 'custom' && message.customType === 'process-message').at(-1);
    assert.deepEqual(JSON.parse(nextReport.content.split('\n')[1]), [['second-task', 'Another task, no sender identity']]);
    await s.shutdown();
    assert.doesNotThrow(() => process.kill(worker.pid, 0), 'Pi shutdown must not kill the external worker');
    const closedResponse = once(worker, 'message'); worker.send({ socket, text: 'Endpoint is now closed' });
    assert.match((await closedResponse)[0].error, /unavailable/);
});

test('real SDK loads standalone notifications and managed processes in either order without duplicate services or commands', async t => {
    const paths = [fileURLToPath(new URL('./index.ts', import.meta.url)), fileURLToPath(new URL('../pty-sessions/index.ts', import.meta.url))];
    for (const extensions of [paths, [...paths].reverse()]) {
        const s = await sdkFixture(t, extensions);
        await s.session.prompt('/create-socket SDK watcher');
        assert.equal(s.notices.filter(value => value.startsWith('Socket: ')).length, 1);
        assert.deepEqual(s.errors, []); await s.shutdown();
    }
});
