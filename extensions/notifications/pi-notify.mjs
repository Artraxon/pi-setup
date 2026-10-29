#!/usr/bin/env node
import { createConnection } from 'node:net';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Standalone client: usable by an already-running program without Pi's SDK.
export function sendNotification(type, text, { env = process.env, socket = env.PI_NOTIFY_SOCKET, timeout = 3000 } = {}) {
    if (!['status', 'notify'].includes(type) || typeof text !== 'string') return Promise.reject(new Error('Expected status or notify and a text string.'));
    if (typeof socket !== 'string' || !socket) return Promise.reject(new Error('No Pi notification socket; supply --socket or PI_NOTIFY_SOCKET.'));
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 60000) return Promise.reject(new Error('Timeout must be 1–60000 milliseconds.'));
    const limit = type === 'status' ? 1024 : 8192;
    if (Buffer.byteLength(text) > limit) return Promise.reject(new Error(`Text exceeds ${limit} UTF-8 bytes.`));
    const frame = JSON.stringify({ type, text }) + '\n';
    return new Promise((resolve, reject) => {
        const connection = createConnection({ path: socket });
        let buffer = Buffer.alloc(0), done = false;
        const timer = setTimeout(() => finish(new Error('Notification timed out.')), timeout);
        const finish = error => {
            if (done) return;
            done = true; clearTimeout(timer); connection.destroy();
            if (error) reject(error); else resolve();
        };
        connection.once('connect', () => connection.write(frame));
        connection.once('error', error => finish(new Error(`Notification socket unavailable (${error.code ?? 'connection error'}).`)));
        connection.once('close', () => { if (!done) finish(new Error('Notification socket closed without an acknowledgement.')); });
        connection.on('data', data => {
            if (buffer.length + data.length > 1024) { finish(new Error('Invalid notification acknowledgement.')); return; }
            buffer = Buffer.concat([buffer, data]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            try {
                if (buffer.subarray(newline + 1).toString('utf8').trim()) throw new Error('Extra acknowledgement data');
                const ack = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
                finish(ack.ok === true ? undefined : new Error(`Notification rejected: ${String(ack.error ?? 'invalid acknowledgement')}`));
            } catch { finish(new Error('Invalid notification acknowledgement.')); }
        });
    });
}
export async function main(args = process.argv.slice(2)) {
    let parsed;
    try {
        parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
            socket: { type: 'string' }, help: { type: 'boolean', short: 'h' },
        } });
    } catch { throw new Error('Invalid arguments; use pi-notify --help.'); }
    const { values, positionals } = parsed;
    if (values.help) {
        console.log('Usage: pi-notify [--socket PATH] status|notify "text"\nSocket defaults to PI_NOTIFY_SOCKET. The parent assigns the label to the socket; clients send only type and text.');
        return;
    }
    if (positionals.length !== 2 || !['status', 'notify'].includes(positionals[0])) throw new Error('Usage: pi-notify [--socket PATH] status|notify "text"');
    await sendNotification(positionals[0], positionals[1], { socket: values.socket ?? process.env.PI_NOTIFY_SOCKET });
}
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
    try { await main(); } catch (error) { console.error(`pi-notify: ${error.message}`); process.exitCode = 1; }
}
