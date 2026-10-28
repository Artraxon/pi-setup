import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { ProcessChannel, IPC_LIMITS } from './ipc.ts';
import { sendProcessMessage } from './pi-process.mjs';
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const job = (id = 'pty-1', privateOutput = false) => ({ id, privateOutput, running: true });
const message = (env, type, text) => ({ version: 1, token: env.PI_PROCESS_TOKEN, type, text });
function setup(t, options = {}) {
    const channel = new ProcessChannel(options);
    t.after(() => channel.close());
    const session = job(), env = channel.environment(session, process.env);
    return { channel, session, env };
}
function raw(path, payload) {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path });
        let output = '';
        socket.setTimeout(4000, () => socket.destroy(new Error('Raw IPC test timed out')));
        socket.once('error', reject);
        socket.once('connect', () => {
            if (Array.isArray(payload)) {
                socket.write(payload[0]);
                setTimeout(() => socket.end(payload[1]), 10);
            } else socket.end(payload);
        });
        socket.on('data', data => output += data);
        socket.once('end', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    });
}

test('IPC allocates lazily, uses short private filesystem paths and cleans up idempotently', async t => {
    const channel = new ProcessChannel(); t.after(() => channel.close());
    assert.equal(channel.server, undefined);
    assert.equal(channel.directory, undefined);
    const env = channel.environment(job(), { PATH: '/custom/bin' });
    await sendProcessMessage('status', 'ready', { env });
    assert.ok(Buffer.byteLength(env.PI_PROCESS_SOCKET) < 103);
    assert.equal(statSync(channel.directory).mode & 0o777, 0o700);
    assert.equal(statSync(env.PI_PROCESS_SOCKET).mode & 0o777, 0o600);
    assert.equal(statSync(env.PI_PROCESS_HELPER).mode & 0o777, 0o700);
    assert.ok(env.PATH.endsWith(':/custom/bin'));
    const directory = channel.directory;
    channel.close(); channel.close();
    assert.equal(existsSync(directory), false);
    await assert.rejects(sendProcessMessage('status', 'late', { env }), /unavailable/);
});

test('status is latest-value local state, sanitized, timestamped and clearable without notifications', async t => {
    const batches = [], changes = [];
    const { channel, session, env } = setup(t, { onNotify: batch => batches.push(batch), onStatus: s => changes.push(s.id) });
    await sendProcessMessage('status', '\x1b[31mfirst\x1b[0m\nsecond\x07', { env });
    assert.equal(session.statusText, 'first second');
    assert.ok(Date.parse(session.statusUpdatedAt));
    await sendProcessMessage('status', '', { env });
    assert.equal(session.statusText, '');
    assert.deepEqual(changes, ['pty-1', 'pty-1']);
    assert.equal(channel.queue.length, 0);
    await sleep(130);
    assert.deepEqual(batches, []);
});

test('notifications batch in FIFO order, preserve source IDs and accepted messages survive normal exit', async t => {
    const batches = [];
    const { channel, session, env } = setup(t, { onNotify: batch => batches.push(batch) });
    const other = job('pty-2'), second = channel.environment(other);
    assert.deepEqual(channel.handle(message(env, 'notify', 'first')), { ok: true });
    assert.deepEqual(channel.handle(message(second, 'notify', '\x1b[32msecond\x1b[0m')), { ok: true });
    session.running = false; channel.revoke(session);
    assert.equal(channel.handle(message(env, 'notify', 'too late')).error, 'unauthorized');
    await sleep(140);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].map(({ id, text }) => ({ id, text })), [{ id: 'pty-1', text: 'first' }, { id: 'pty-2', text: 'second' }]);
    assert.ok(batches[0].every(entry => Date.parse(entry.timestamp)));
    assert.equal(channel.queue.length, 0);
});

test('per-process capabilities reject spoofing, other Pi instances, expired and disposed records', async t => {
    const a = setup(t), b = setup(t);
    await assert.rejects(sendProcessMessage('status', 'spoof', { env: { ...a.env, PI_PROCESS_TOKEN: b.env.PI_PROCESS_TOKEN } }), /unauthorized/);
    assert.equal(a.channel.handle({ ...message(a.env, 'status', 'spoof'), id: 'pty-2' }).error, 'invalid_message');
    a.session.disposed = true;
    assert.equal(a.channel.handle(message(a.env, 'status', 'late')).error, 'unauthorized');
    a.session.disposed = false;
    a.channel.revoke(a.session);
    assert.equal(a.channel.handle(message(a.env, 'status', 'late')).error, 'unauthorized');
    assert.equal(a.session.statusText, undefined);
});

test('private processes may update local status but cannot queue agent messages', async t => {
    const { channel } = setup(t);
    const secret = job('pty-2', true), env = channel.environment(secret);
    await sendProcessMessage('status', 'private progress', { env });
    assert.equal(secret.statusText, 'private progress');
    await assert.rejects(sendProcessMessage('notify', 'secret notification', { env }), /private_process/);
    assert.equal(channel.queue.length, 0);
});

test('status and notification budgets are separate, refill, and globally bound wakeups', t => {
    let now = Date.now();
    const { channel, env } = setup(t, { now: () => now });
    for (let i = 0; i < 10; i++) assert.equal(channel.handle(message(env, 'status', String(i))).ok, true);
    assert.equal(channel.handle(message(env, 'status', 'excess')).error, 'rate_limited');
    now += 100;
    assert.equal(channel.handle(message(env, 'status', 'refilled')).ok, true);
    for (let i = 0; i < 3; i++) assert.equal(channel.handle(message(env, 'notify', 'one')).ok, true);
    assert.equal(channel.handle(message(env, 'notify', 'excess')).error, 'rate_limited');
    const second = channel.environment(job('pty-2'));
    for (let i = 0; i < 3; i++) assert.equal(channel.handle(message(second, 'notify', 'two')).ok, true);
    const third = channel.environment(job('pty-3'));
    assert.equal(channel.handle(message(third, 'notify', 'global excess')).error, 'rate_limited');
    now += 20_000;
    assert.equal(channel.handle(message(env, 'notify', 'refilled')).ok, true);
    assert.equal(channel.handle(message(env, 'status', 'independent')).ok, true);
});

test('frame, text and queue bounds reject malformed or excessive traffic without mutating state', async t => {
    const { channel, session, env } = setup(t);
    assert.equal((await raw(channel.path, 'not json\n')).error, 'invalid_message');
    assert.equal((await raw(channel.path, '[]\n')).error, 'invalid_message');
    assert.equal((await raw(channel.path, '{')).error, 'incomplete_message');
    assert.equal((await raw(channel.path, 'x'.repeat(IPC_LIMITS.frameBytes + 1))).error, 'frame_too_large');
    assert.equal(channel.handle(message(env, 'status', 'é'.repeat(513))).error, 'text_too_large');
    assert.equal(channel.handle(message(env, 'notify', 'x'.repeat(8193))).error, 'text_too_large');
    assert.equal(channel.handle(message(env, 'notify', '  ')).error, 'invalid_message');
    channel.queue = Array(IPC_LIMITS.queue).fill({ id: 'pty-1', text: 'queued' });
    assert.equal(channel.handle(message(env, 'notify', 'full')).error, 'queue_full');
    assert.equal(session.statusText, undefined);
});

test('shutdown cancels pending delivery, revokes capabilities and closes incomplete connections', async t => {
    let deliveries = 0;
    const { channel, env } = setup(t, { onNotify: () => deliveries++ });
    channel.handle(message(env, 'notify', 'queued'));
    const socket = createConnection({ path: channel.path });
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('{');
    const closed = new Promise(resolve => socket.once('close', resolve));
    channel.close();
    await closed;
    await sleep(140);
    assert.equal(deliveries, 0);
    assert.equal(channel.records.size, 0);
    assert.equal(channel.sockets.size, 0);
});

test('standalone helper handles help, Unicode and errors without echoing credentials or text', async t => {
    const { session, env } = setup(t);
    const result = await exec(env.PI_PROCESS_HELPER, ['status', '42 / 100 · €'], { env: { ...process.env, ...env } });
    assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(session.statusText, '42 / 100 · €');
    const help = await exec(process.execPath, [fileURLToPath(new URL('./pi-process.mjs', import.meta.url)), '--help']);
    assert.match(help.stdout, /status\|notify/);
    await assert.rejects(exec(env.PI_PROCESS_HELPER, ['notify', 'secret-text'], { env: { ...process.env, ...env, PI_PROCESS_TOKEN: 'bad' } }), error => {
        assert.match(error.stderr, /unauthorized/);
        assert.ok(!error.stderr.includes('secret-text'));
        assert.ok(!error.stderr.includes(env.PI_PROCESS_TOKEN));
        return true;
    });
    await assert.rejects(sendProcessMessage('status', 'x', { env: {} }), /No managed Pi/);
});

test('framing preserves UTF-8 split across socket writes', async t => {
    const { channel, session, env } = setup(t);
    const frame = Buffer.from(JSON.stringify(message(env, 'status', '€ progress')) + '\n');
    const offset = frame.indexOf(Buffer.from('€')) + 1;
    assert.deepEqual(await raw(channel.path, [frame.subarray(0, offset), frame.subarray(offset)]), { ok: true });
    assert.equal(session.statusText, '€ progress');
});

test('a blocked agent keeps only a bounded local queue and flushes it on a later boundary', async t => {
    let now = Date.now(), blocked = true, delivered;
    const { channel, env } = setup(t, { now: () => now, onNotify: batch => {
        if (blocked) return false;
        delivered = batch;
    } });
    for (let i = 0; i < IPC_LIMITS.queue; i++) {
        now += 20_000;
        assert.equal(channel.handle(message(env, 'notify', String(i))).ok, true);
    }
    await sleep(140);
    assert.equal(channel.queue.length, IPC_LIMITS.queue);
    now += 20_000;
    assert.equal(channel.handle(message(env, 'notify', 'over capacity')).error, 'queue_full');
    blocked = false; channel.scheduleFlush();
    await sleep(140);
    assert.equal(delivered.length, IPC_LIMITS.queue);
    assert.equal(channel.queue.length, 0);
});

test('notification batching also bounds serialized bytes before sending to the model', async t => {
    let now = Date.now();
    const batches = [];
    const { channel, env } = setup(t, { now: () => now, onNotify: batch => batches.push(batch) });
    for (let i = 0; i < 6; i++) {
        now += 20_000;
        assert.equal(channel.handle(message(env, 'notify', '"'.repeat(8192))).ok, true);
    }
    const deadline = Date.now() + 5000;
    while (batches.flat().length < 6 && Date.now() < deadline) await sleep(10);
    assert.equal(batches.flat().length, 6);
    assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= IPC_LIMITS.batchBytes));
    assert.equal(channel.queue.length, 0);
});

test('launcher works when extension files live in paths with spaces and apostrophes', async t => {
    const directory = mkdtempSync('/tmp/pi-ipc-path-'), path = join(directory, "user's extensions");
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(path);
    for (const file of ['ipc.ts', 'pi-process.mjs']) copyFileSync(new URL(file, import.meta.url), join(path, file));
    const { ProcessChannel: Channel } = await import(pathToFileURL(join(path, 'ipc.ts')).href);
    const channel = new Channel(); t.after(() => channel.close());
    const session = job(), env = channel.environment(session, process.env);
    await exec(env.PI_PROCESS_HELPER, ['status', 'quoted path works'], { env: { ...process.env, ...env } });
    assert.equal(session.statusText, 'quoted path works');
});
