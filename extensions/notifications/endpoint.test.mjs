import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NotificationEndpoint, IPC_LIMITS } from './endpoint.ts';

async function exchange(t, bytes, end = false) {
    const directory = mkdtempSync('/tmp/pi-endpoint-'), messages = [];
    const endpoint = new NotificationEndpoint({ label: 'test', path: join(directory, 'socket'),
        helper: '/unused', connections: new Set(),
        onMessage: message => { messages.push(message); return { ok: true }; }, onClose() {} });
    let socket;
    t.after(() => { socket?.destroy(); endpoint.close(); rmSync(directory, { recursive: true, force: true }); });
    await once(endpoint.server, 'listening');
    socket = createConnection(endpoint.path);
    await once(socket, 'connect');
    const chunks = [];
    socket.on('data', chunk => chunks.push(chunk));
    const ended = once(socket, 'end');
    if (end) socket.end(bytes); else socket.write(bytes);
    await ended;
    return { reply: JSON.parse(Buffer.concat(chunks).toString('utf8')), messages };
}
const message = { type: 'status', text: 'one notification' };
const frame = JSON.stringify(message) + '\n';

test('accepts one JSON message and closes the connection after acknowledgement', async t => {
    assert.deepEqual(await exchange(t, frame), { reply: { ok: true }, messages: [message] });
});

test('rejects multiple messages in one frame batch', async t => {
    assert.deepEqual(await exchange(t, frame + frame), { reply: { ok: false, error: 'invalid_message' }, messages: [] });
});

test('does not recognize non-JSON protocol headers', async t => {
    assert.deepEqual(await exchange(t, 'some upstream schema\n'), { reply: { ok: false, error: 'invalid_message' }, messages: [] });
});

test('rejects an incomplete message at EOF', async t => {
    assert.deepEqual(await exchange(t, '{', true), { reply: { ok: false, error: 'incomplete_message' }, messages: [] });
});

test('bounds the bytes accepted on a connection', async t => {
    assert.deepEqual(await exchange(t, 'x'.repeat(IPC_LIMITS.frameBytes + 1)),
        { reply: { ok: false, error: 'frame_too_large' }, messages: [] });
});
