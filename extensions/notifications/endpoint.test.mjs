import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { NotificationEndpoint, IPC_LIMITS } from './endpoint.ts';

async function setup(t) {
    const directory = mkdtempSync('/tmp/pi-stream-'), messages = [], connections = new Set();
    const endpoint = new NotificationEndpoint({ label: 'stream', path: join(directory, 'socket'),
        helper: '/unused', connections, onMessage: message => { messages.push(message); return { ok: true }; }, onClose() {} });
    let socket;
    t.after(() => { socket?.destroy(); endpoint.close(); rmSync(directory, { recursive: true, force: true }); });
    await once(endpoint.server, 'listening');
    socket = createConnection(endpoint.path);
    await once(socket, 'connect');
    const replies = createInterface({ input: socket })[Symbol.asyncIterator]();
    const reply = async () => JSON.parse((await replies.next()).value);
    return { endpoint, socket, messages, reply, replies };
}
const frame = text => Buffer.from(JSON.stringify({ type: 'status', text }) + '\n');
const schema = Buffer.from('"type":VARSIZED:NOT_NULLABLE,"text":VARSIZED:NOT_NULLABLE\n');

test('an initial NebulaStream schema is skipped without an acknowledgement or notification', { timeout: 5000 }, async t => {
    const { socket, messages, reply, replies } = await setup(t);
    socket.end(Buffer.concat([schema, frame('first'), frame('second')]));
    assert.deepEqual(await reply(), { ok: true });
    assert.deepEqual(await reply(), { ok: true });
    assert.equal((await replies.next()).done, true);
    assert.deepEqual(messages.map(({ text }) => text), ['first', 'second']);
});

test('the schema header may be split across socket writes', { timeout: 5000 }, async t => {
    const { socket, messages, reply, replies } = await setup(t);
    socket.write(schema.subarray(0, 10));
    await sleep(20);
    assert.deepEqual(messages, []);
    socket.end(Buffer.concat([schema.subarray(10), frame('after schema')]));
    assert.deepEqual(await reply(), { ok: true });
    assert.equal((await replies.next()).done, true);
    assert.equal(messages[0].text, 'after schema');
});

test('a schema-only stream ends cleanly without submitting a message', { timeout: 5000 }, async t => {
    const { socket, messages, replies } = await setup(t);
    socket.end(schema);
    assert.equal((await replies.next()).done, true);
    assert.deepEqual(messages, []);
});

test('a repeated schema header is rejected rather than ignored midstream', { timeout: 5000 }, async t => {
    const { socket, messages, reply } = await setup(t);
    socket.end(Buffer.concat([schema, frame('accepted'), schema, frame('not accepted')]));
    assert.deepEqual(await reply(), { ok: true });
    assert.deepEqual(await reply(), { ok: false, error: 'invalid_message' });
    assert.deepEqual(messages.map(({ text }) => text), ['accepted']);
});

test('an unrelated schema is still invalid notification traffic', { timeout: 5000 }, async t => {
    const { socket, messages, reply } = await setup(t);
    socket.end('"value":UINT64:NOT_NULLABLE\n');
    assert.deepEqual(await reply(), { ok: false, error: 'invalid_message' });
    assert.deepEqual(messages, []);
});

test('one connection accepts batched frames and a UTF-8 frame split across writes', { timeout: 5000 }, async t => {
    const { endpoint, socket, messages, reply } = await setup(t);
    socket.write(Buffer.concat([frame('first'), frame('second')]));
    assert.deepEqual(await reply(), { ok: true });
    assert.deepEqual(await reply(), { ok: true });
    const third = frame('€ third'), split = third.indexOf(Buffer.from('€')) + 1;
    socket.write(third.subarray(0, split));
    await sleep(20);
    assert.equal(messages.length, 2);
    socket.write(third.subarray(split));
    assert.deepEqual(await reply(), { ok: true });
    assert.deepEqual(messages.map(({ text }) => text), ['first', 'second', '€ third']);
    assert.equal(endpoint.sockets.size, 1);
    const ended = once(socket, 'end');
    socket.end();
    await ended;
});

test('an idle connection remains open beyond the former three-second deadline', { timeout: 6000 }, async t => {
    const { endpoint, socket, messages, reply } = await setup(t);
    socket.write(frame('before idle'));
    assert.deepEqual(await reply(), { ok: true });
    await sleep(3200);
    assert.equal(socket.destroyed, false);
    assert.equal(endpoint.sockets.size, 1);
    socket.write(frame('after idle'));
    assert.deepEqual(await reply(), { ok: true });
    assert.deepEqual(messages.map(({ text }) => text), ['before idle', 'after idle']);
});

test('the frame limit applies per message, not to the total bytes on a connection', { timeout: 5000 }, async t => {
    const { socket, messages, reply } = await setup(t);
    const large = frame('x'.repeat(IPC_LIMITS.frameBytes / 2));
    socket.write(Buffer.concat([large, large, large]));
    for (let i = 0; i < 3; ++i) assert.deepEqual(await reply(), { ok: true });
    assert.equal(messages.length, 3);
});

test('EOF rejects an incomplete trailing frame after a complete message', { timeout: 5000 }, async t => {
    const { socket, messages, reply } = await setup(t);
    socket.end(Buffer.concat([frame('complete'), Buffer.from('{')]));
    assert.deepEqual(await reply(), { ok: true });
    assert.deepEqual(await reply(), { ok: false, error: 'incomplete_message' });
    assert.equal(messages.length, 1);
});
