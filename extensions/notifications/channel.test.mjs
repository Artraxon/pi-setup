import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NotificationChannel, IPC_LIMITS } from './channel.ts';
import { sendNotification } from './pi-notify.mjs';
const exec = promisify(execFile), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const message = (type, text) => ({ type, text });
function setup(t, options = {}) {
    const statuses = [], channel = new NotificationChannel({ ...options, onStatus: value => { statuses.push(value); options.onStatus?.(value); } });
    t.after(() => channel.close());
    const endpoint = channel.create('worker');
    return { channel, endpoint, statuses, env: endpoint.environment(process.env) };
}
function raw(path, payload) {
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path }); let output = '';
        socket.setTimeout(4000, () => socket.destroy(new Error('Raw notification test timed out')));
        socket.once('error', reject);
        socket.once('connect', () => {
            if (Array.isArray(payload)) { socket.write(payload[0]); setTimeout(() => socket.end(payload[1]), 10); }
            else socket.end(payload);
        });
        socket.on('data', data => output += data);
        socket.once('end', () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    });
}

test('resources are lazy and each endpoint has a private socket without client identity or tokens', async t => {
    const channel = new NotificationChannel(); t.after(() => channel.close());
    assert.equal(channel.directory, undefined); assert.equal(channel.endpoints.size, 0);
    const endpoint = channel.create('watcher'), env = endpoint.environment({ PATH: '/custom/bin' });
    assert.ok(!Object.keys(env).some(key => /TOKEN|PROCESS|SOURCE|LABEL/.test(key)));
    await sendNotification('status', 'ready', { env });
    assert.ok(Buffer.byteLength(endpoint.path) < 103);
    assert.equal(statSync(channel.directory).mode & 0o777, 0o700);
    assert.equal(statSync(endpoint.path).mode & 0o777, 0o600);
    assert.equal(statSync(env.PI_NOTIFY_HELPER).mode & 0o777, 0o700);
    assert.ok(env.PATH.endsWith(':/custom/bin'));
    const directory = channel.directory; channel.close(); channel.close();
    assert.equal(existsSync(directory), false);
    await assert.rejects(sendNotification('notify', 'late', { env }), /unavailable/);
});

test('labels belong to sockets; even equal labels allocate different endpoints and callers cannot supply an identity', async t => {
    const batches = [], { channel, endpoint } = setup(t, { onNotify: batch => batches.push(batch) });
    const second = channel.create('watcher'), sameLabel = channel.create('worker');
    assert.equal(new Set([endpoint.path, second.path, sameLabel.path]).size, 3);
    assert.deepEqual(await raw(endpoint.path, JSON.stringify(message('notify', 'First')) + '\n'), { ok: true });
    await sendNotification('notify', 'Second', { socket: second.path });
    assert.deepEqual(await raw(endpoint.path, JSON.stringify({ ...message('notify', 'Spoofed'), source: 'watcher' }) + '\n'), { ok: false, error: 'invalid_message' });
    await sleep(140);
    assert.deepEqual(batches[0].map(({ id, text }) => [id, text]), [['worker', 'First'], ['watcher', 'Second']]);
});

test('status callbacks are endpoint-local, sanitized, timestamped and clearable, with no model notification', async t => {
    const batches = [], { channel, env, statuses } = setup(t, { onNotify: value => batches.push(value) });
    const other = [], second = channel.create('second', { onStatus: value => other.push(value) });
    await sendNotification('status', '\x1b[31mfirst\x1b[0m\nsecond\x07', { env });
    await sendNotification('status', '', { env });
    await sendNotification('status', 'Local', { socket: second.path });
    assert.equal(statuses[0].id, 'worker'); assert.equal(statuses[0].text, 'first second');
    assert.ok(Date.parse(statuses[0].timestamp)); assert.equal(statuses[1].text, ''); assert.equal(statuses.length, 2);
    assert.deepEqual(other.map(({ id, text }) => [id, text]), [['second', 'Local']]);
    await sleep(130); assert.deepEqual(batches, []); assert.equal(channel.queue.length, 0);
});

test('closing an endpoint leaves other endpoints and already-accepted reports intact; paths are never reused', async t => {
    const batches = [], { channel, endpoint, env } = setup(t, { onNotify: batch => batches.push(batch) });
    const second = channel.create('other');
    await sendNotification('notify', 'Accepted before close', { env }); endpoint.close(); endpoint.close();
    assert.equal(existsSync(endpoint.path), false); assert.equal(channel.endpoints.has(endpoint.path), false);
    assert.throws(() => endpoint.environment(), /closed/);
    await assert.rejects(sendNotification('notify', 'Late', { env }), /unavailable/);
    await sendNotification('notify', 'Still works', { socket: second.path });
    const replacement = channel.create('worker'); assert.notEqual(replacement.path, endpoint.path);
    await sleep(140); assert.deepEqual(batches.flat().map(({ text }) => text), ['Accepted before close', 'Still works']);
});

test('global flood protection is shared across endpoints without per-source quotas', t => {
    let now = Date.now(); const { channel, endpoint } = setup(t, { now: () => now }), second = channel.create('second');
    for (let i = 0; i < 100; i++) assert.equal(channel.handle(i % 2 ? endpoint : second, message('status', String(i))).ok, true);
    assert.equal(channel.handle(second, message('status', 'too fast')).error, 'rate_limited');
    now += 10; assert.equal(channel.handle(endpoint, message('status', 'refilled')).ok, true);
    for (let i = 0; i < 6; i++) assert.equal(channel.handle(i % 2 ? endpoint : second, message('notify', 'Done')).ok, true);
    assert.equal(channel.handle(channel.create('new'), message('notify', 'Too fast')).error, 'rate_limited');
    now += 10000; assert.equal(channel.handle(second, message('notify', 'Refilled')).ok, true);
});

test('frame, payload, label and queue bounds reject malformed traffic and old identity-bearing frames', async t => {
    const { channel, endpoint } = setup(t);
    for (const payload of ['not json\n', '[]\n']) assert.equal((await raw(endpoint.path, payload)).error, 'invalid_message');
    assert.equal((await raw(endpoint.path, '{')).error, 'incomplete_message');
    assert.equal((await raw(endpoint.path, 'x'.repeat(IPC_LIMITS.frameBytes + 1))).error, 'frame_too_large');
    for (const extra of [{ version: 1, token: 'old' }, { version: 2, source: 'old' }, { label: 'fake' }, { id: 'fake' }]) {
        assert.equal(channel.handle(endpoint, { ...message('notify', 'Old'), ...extra }).error, 'invalid_message');
    }
    for (const label of ['', ' ', 'x'.repeat(129), 1]) assert.throws(() => channel.create(label), /label|Label/);
    assert.equal(channel.handle(endpoint, message('status', 'é'.repeat(513))).error, 'text_too_large');
    assert.equal(channel.handle(endpoint, message('notify', 'x'.repeat(8193))).error, 'text_too_large');
    assert.equal(channel.handle(endpoint, message('notify', '  ')).error, 'invalid_message');
    channel.queue = Array(IPC_LIMITS.queue).fill({ id: 'worker', text: 'queued' });
    assert.equal(channel.handle(endpoint, message('notify', 'Full')).error, 'queue_full');
});

test('there is no arbitrary endpoint-count cap; labels are sanitized at creation', async t => {
    const { channel } = setup(t);
    for (let i = 0; i < 80; i++) channel.create(`watcher-${i}`);
    const statuses = [], endpoint = channel.create('\x1b[31mwatcher\x1b[0m\nname', { onStatus: value => statuses.push(value) });
    assert.equal(channel.endpoints.size, 82); await sendNotification('status', 'Ready', { socket: endpoint.path });
    assert.equal(statuses[0].id, 'watcher name');
});

test('private endpoint policy rejects notification even when sender omits or overrides private metadata', async t => {
    const { channel } = setup(t), endpoint = channel.create('private', { notify: false });
    await sendNotification('status', 'Local only', { socket: endpoint.path });
    await assert.rejects(sendNotification('notify', 'Not allowed', { socket: endpoint.path }), /private_process/);
    assert.equal(channel.queue.length, 0);
});

test('shutdown discards queued reports and closes incomplete connections on every endpoint', async t => {
    let deliveries = 0; const { channel, endpoint } = setup(t, { onNotify: () => deliveries++ });
    channel.handle(endpoint, message('notify', 'Queued'));
    const second = channel.create('second');
    const clients = [endpoint, second].map(value => createConnection({ path: value.path }));
    await Promise.all(clients.map(socket => { socket.on('error', () => {}); return new Promise(resolve => socket.once('connect', resolve)); }));
    for (const socket of clients) socket.write('{');
    const closed = Promise.all(clients.map(socket => new Promise(resolve => socket.once('close', resolve))));
    channel.close(); await closed; await sleep(140);
    assert.equal(deliveries, 0); assert.equal(channel.sockets.size, 0); assert.equal(channel.endpoints.size, 0); assert.equal(channel.queue.length, 0);
});

test('CLI needs only the socket and text, ignores inherited identity and prints no message text on failure', async t => {
    const { endpoint, env, statuses } = setup(t);
    const result = await exec(env.PI_NOTIFY_HELPER, ['--socket', endpoint.path, 'status', '42 / 100 · €'], {
        env: { PATH: process.env.PATH, PI_NOTIFY_SOURCE: 'fake', PI_PROCESS_ID: 'fake' },
    });
    assert.equal(result.stdout, ''); assert.equal(result.stderr, ''); assert.equal(statuses[0].text, '42 / 100 · €');
    assert.equal(statuses[0].id, 'worker');
    assert.match((await exec(env.PI_NOTIFY_HELPER, ['--help'])).stdout, /clients send only type and text/);
    await assert.rejects(exec(env.PI_NOTIFY_HELPER, ['--socket', '/tmp/no-such-pi-socket', 'notify', 'do-not-echo']), error => !error.stderr.includes('do-not-echo'));
    await assert.rejects(exec(env.PI_NOTIFY_HELPER, ['notify', '--do-not-echo']), error => !error.stderr.includes('--do-not-echo'));
    await assert.rejects(sendNotification('notify', 'x', { env: {} }), /No Pi notification socket/);
    await assert.rejects(sendNotification('notify', 'x', { socket: endpoint.path, timeout: -1 }), /Timeout/);
});

test('framing preserves UTF-8 split across socket writes', async t => {
    const { endpoint, statuses } = setup(t);
    const frame = Buffer.from(JSON.stringify(message('status', '€ progress')) + '\n'), offset = frame.indexOf(Buffer.from('€')) + 1;
    assert.deepEqual(await raw(endpoint.path, [frame.subarray(0, offset), frame.subarray(offset)]), { ok: true });
    assert.equal(statuses[0].text, '€ progress');
});

test('blocked delivery remains bounded and drains byte-bounded FIFO batches across closed endpoints', async t => {
    let now = Date.now(), blocked = true; const batches = [];
    const { channel, endpoint } = setup(t, { now: () => now, onNotify: batch => { if (blocked) return false; batches.push(batch); } });
    for (let i = 0; i < IPC_LIMITS.queue; i++) { now += 10000; assert.equal(channel.handle(endpoint, message('notify', `item-${i} ` + '"'.repeat(8000))).ok, true); }
    endpoint.close(); await sleep(140); assert.equal(channel.queue.length, IPC_LIMITS.queue);
    blocked = false; channel.scheduleFlush();
    const deadline = Date.now() + 5000;
    while (channel.queue.length && Date.now() < deadline) await sleep(10);
    assert.equal(channel.queue.length, 0); assert.equal(batches.flat().length, IPC_LIMITS.queue);
    assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= IPC_LIMITS.batchBytes));
    assert.ok(batches.flat().every((item, index) => item.text.startsWith(`item-${index} `)));
});

test('helper works when installed under paths containing spaces and apostrophes', async t => {
    const directory = mkdtempSync('/tmp/pi-notify-path-'), path = join(directory, "user's extensions");
    t.after(() => rmSync(directory, { recursive: true, force: true })); mkdirSync(path);
    for (const file of ['channel.ts', 'endpoint.ts', 'pi-notify.mjs']) copyFileSync(new URL(file, import.meta.url), join(path, file));
    const { NotificationChannel: Channel } = await import(pathToFileURL(join(path, 'channel.ts')).href);
    const channel = new Channel({ onStatus: value => { assert.equal(value.text, 'Quoted path works'); } }); t.after(() => channel.close());
    const env = channel.create('quoted').environment(); await exec(env.PI_NOTIFY_HELPER, ['status', 'Quoted path works'], { env: { ...process.env, ...env } });
});
