import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

export const IPC_LIMITS = Object.freeze({ frameBytes: 65536, statusBytes: 1024, notifyBytes: 8192,
    connections: 32, queue: 32, idleMs: 3000, batchMs: 100, batchBytes: 32768 });
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const clean = value => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const bucket = (capacity, interval, now) => ({ capacity, interval, tokens: capacity, at: now });
function available(value, now) {
    value.tokens = Math.min(value.capacity, value.tokens + Math.max(0, now - value.at) / value.interval);
    value.at = now;
    return value.tokens >= 1;
}

// Created with a session manager, but resources are allocated only at first launch.
export class ProcessChannel {
    records = new Map();
    sockets = new Set();
    queue = [];
    closed = false;
    constructor({ onStatus = () => {}, onNotify = () => {}, now = Date.now } = {}) {
        this.onStatus = onStatus;
        this.onNotify = onNotify;
        this.now = now;
        this.globalNotify = bucket(6, 10_000, now());
    }
    environment(session, inherited = {}) {
        if (this.closed) throw new Error(`Process IPC is closed${this.failure ? ` (${this.failure})` : ''}.`);
        this.start();
        const token = randomBytes(32).toString('hex');
        const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
        session.dataDirectory = join(resolve(agentDir), 'process-data', randomUUID());
        this.records.set(token, { session, status: bucket(10, 100, this.now()), notify: bucket(3, 20_000, this.now()) });
        return { PI_PROCESS_SOCKET: this.path, PI_PROCESS_TOKEN: token, PI_PROCESS_HELPER: this.helper,
            PI_PROCESS_ID: session.id, PI_PROCESS_DATA_DIR: session.dataDirectory, PI_PROCESS_PRIVATE: session.privateOutput ? '1' : '0',
            PATH: `${this.bin}${delimiter}${inherited.PATH ?? '/usr/bin:/bin'}` };
    }
    start() {
        if (this.server) return;
        if (process.platform === 'win32') throw new Error('Process IPC requires Unix-domain sockets (Linux/macOS).');
        // /tmp is short on Linux and macOS, unlike arbitrary TMPDIR paths.
        this.directory = mkdtempSync('/tmp/pi-ipc-');
        try {
            chmodSync(this.directory, 0o700);
            this.path = join(this.directory, 's');
            this.bin = join(this.directory, 'bin');
            mkdirSync(this.bin, { mode: 0o700 });
            this.helper = join(this.bin, 'pi-process');
            const script = fileURLToPath(new URL('./pi-process.mjs', import.meta.url));
            writeFileSync(this.helper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
            this.server = createServer(socket => this.accept(socket));
            this.server.maxConnections = IPC_LIMITS.connections;
            this.server.on('error', error => { this.failure = error.code ?? 'server error'; this.close(); });
            this.server.once('listening', () => {
                if (this.closed) return;
                try { chmodSync(this.path, 0o600); }
                catch (error) { this.failure = error.code ?? 'socket permissions'; this.close(); }
            });
            this.server.listen(this.path);
            this.server.unref();
        } catch (error) { this.close(); throw error; }
    }
    accept(socket) {
        if (this.closed || this.sockets.size >= IPC_LIMITS.connections) { socket.destroy(); return; }
        this.sockets.add(socket);
        socket.unref();
        socket.setTimeout(IPC_LIMITS.idleMs, () => socket.destroy());
        const deadline = setTimeout(() => socket.destroy(), IPC_LIMITS.idleMs);
        deadline.unref();
        socket.on('error', () => {});
        socket.once('close', () => { clearTimeout(deadline); this.sockets.delete(socket); });
        let buffer = Buffer.alloc(0), answered = false;
        const reply = result => {
            if (answered) return;
            answered = true;
            socket.end(`${JSON.stringify(result)}\n`);
        };
        socket.on('data', chunk => {
            if (answered) return;
            if (buffer.length + chunk.length > IPC_LIMITS.frameBytes) { reply({ ok: false, error: 'frame_too_large' }); return; }
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            try {
                if (buffer.subarray(newline + 1).toString('utf8').trim()) throw new Error('extra frame');
                const message = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
                reply(this.handle(message));
            } catch { reply({ ok: false, error: 'invalid_message' }); }
        });
        socket.once('end', () => { if (!answered) reply({ ok: false, error: 'incomplete_message' }); });
    }
    handle(message) {
        if (this.closed) return { ok: false, error: 'unavailable' };
        if (!message || Array.isArray(message) || message.version !== 1 || typeof message.token !== 'string' ||
            !['status', 'notify'].includes(message.type) || typeof message.text !== 'string' ||
            Object.keys(message).some(key => !['version', 'token', 'type', 'text'].includes(key))) return { ok: false, error: 'invalid_message' };
        const record = this.records.get(message.token), session = record?.session;
        if (!session?.running || session.disposed) return { ok: false, error: 'unauthorized' };
        const bytes = Buffer.byteLength(message.text);
        if (bytes > (message.type === 'status' ? IPC_LIMITS.statusBytes : IPC_LIMITS.notifyBytes)) return { ok: false, error: 'text_too_large' };
        const now = this.now();
        if (message.type === 'status') {
            if (!available(record.status, now)) return { ok: false, error: 'rate_limited' };
            record.status.tokens--;
            session.statusText = clean(message.text).replace(/[\r\n\t]/g, ' ');
            session.statusUpdatedAt = new Date(now).toISOString();
            this.onStatus(session);
        } else {
            if (session.privateOutput) return { ok: false, error: 'private_process' };
            const text = clean(message.text);
            if (!text.trim()) return { ok: false, error: 'invalid_message' };
            if (this.queue.length >= IPC_LIMITS.queue) return { ok: false, error: 'queue_full' };
            if (!available(record.notify, now) || !available(this.globalNotify, now)) return { ok: false, error: 'rate_limited' };
            record.notify.tokens--; this.globalNotify.tokens--;
            this.queue.push({ id: session.id, text, timestamp: new Date(now).toISOString() });
            this.scheduleFlush();
        }
        return { ok: true };
    }
    scheduleFlush() {
        if (this.flushTimer || this.closed || !this.queue.length) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            if (this.closed) return;
            const batch = [];
            let bytes = 2; // JSON array delimiters; all text is already bounded.
            for (const entry of this.queue) {
                const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
                if (bytes + size > IPC_LIMITS.batchBytes) break;
                batch.push(entry); bytes += size;
            }
            if (batch.length) {
                // false means a previous follow-up is outstanding. Retain a bounded
                // queue until the next agent-end boundary or incoming message.
                try {
                    if (this.onNotify(batch) !== false) {
                        this.queue.splice(0, batch.length);
                        this.scheduleFlush();
                    }
                }
                catch { /* Retain for a later flush; never crash the TUI. */ }
            }
        }, IPC_LIMITS.batchMs);
        this.flushTimer.unref();
    }
    acknowledge(batch) {
        if (this.closed || !batch.length || !batch.every((entry, index) => this.queue[index] === entry)) return false;
        this.queue.splice(0, batch.length);
        this.scheduleFlush();
        return true;
    }
    revoke(session) {
        for (const [token, record] of this.records) if (record.session === session) this.records.delete(token);
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
        this.queue.length = 0;
        this.records.clear();
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        try { this.server?.close(); } catch (error) { this.failure ??= error.code ?? 'server close failed'; }
        if (this.directory) {
            try { rmSync(this.directory, { recursive: true, force: true }); }
            catch (error) { this.failure ??= error.code ?? 'directory cleanup failed'; }
            this.directory = undefined;
        }
    }
}
