import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exported for applications that prefer an API; no Pi SDK or other dependency.
export function sendProcessMessage(type, text, { env = process.env, timeout = 3000 } = {}) {
    if (!['status', 'notify'].includes(type) || typeof text !== 'string') return Promise.reject(new Error('Expected status or notify and a text string.'));
    if (!env.PI_PROCESS_SOCKET || !env.PI_PROCESS_TOKEN) return Promise.reject(new Error('No managed Pi process endpoint in the environment.'));
    const limit = type === 'status' ? 1024 : 8192;
    if (Buffer.byteLength(text) > limit) return Promise.reject(new Error(`Text exceeds ${limit} UTF-8 bytes.`));
    const frame = JSON.stringify({ version: 1, token: env.PI_PROCESS_TOKEN, type, text }) + '\n';
    return new Promise((resolve, reject) => {
        const socket = createConnection({ path: env.PI_PROCESS_SOCKET });
        let buffer = '', done = false;
        const timer = setTimeout(() => finish(new Error('Process IPC timed out.')), timeout);
        const finish = error => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error); else resolve();
        };
        socket.once('connect', () => socket.write(frame));
        socket.once('error', error => finish(new Error(`Process IPC unavailable (${error.code ?? 'connection error'}).`)));
        socket.once('close', () => { if (!done) finish(new Error('Process IPC closed without an acknowledgement.')); });
        socket.on('data', data => {
            buffer += data.toString('utf8');
            if (Buffer.byteLength(buffer) > 1024) { finish(new Error('Invalid process IPC acknowledgement.')); return; }
            const newline = buffer.indexOf('\n');
            if (newline < 0) return;
            try {
                const ack = JSON.parse(buffer.slice(0, newline));
                finish(ack.ok === true ? undefined : new Error(`Process IPC rejected message: ${String(ack.error ?? 'invalid acknowledgement')}`));
            } catch { finish(new Error('Invalid process IPC acknowledgement.')); }
        });
    });
}

export async function main(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Usage: pi-process status|notify "text"\nstatus updates the process list only; notify queues an agent follow-up.\nEmpty status clears it. Notifications from private !! jobs are rejected.');
        return;
    }
    if (args.length !== 2 || !['status', 'notify'].includes(args[0])) throw new Error('Usage: pi-process status|notify "text"');
    await sendProcessMessage(args[0], args[1]);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(); }
    catch (error) { console.error(`pi-process: ${error.message}`); process.exitCode = 1; }
}
