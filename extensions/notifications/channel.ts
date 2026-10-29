import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { NotificationEndpoint, IPC_LIMITS } from './endpoint.ts';
export { IPC_LIMITS } from './endpoint.ts';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const clean = value => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const bucket = (capacity, interval, now) => ({ capacity, interval, tokens: capacity, at: now });
function available(value, now) {
    value.tokens = Math.min(value.capacity, value.tokens + Math.max(0, now - value.at) / value.interval);
    value.at = now;
    return value.tokens >= 1;
}
export function notificationLabel(value) {
    if (typeof value !== 'string') throw new Error('Expected a notification label.');
    const label = clean(value).replace(/[\r\n\t]/g, ' ').trim();
    if (!label || Buffer.byteLength(label) > IPC_LIMITS.labelBytes) throw new Error('Label must be 1–128 UTF-8 bytes.');
    return label;
}

// Shared bounded inbox and endpoint factory, independent of process launching.
// Each create() allocates a distinct socket, even when labels happen to match.
export class NotificationChannel {
    endpoints = new Map();
    sockets = new Set();
    queue = [];
    next = 0;
    closed = false;
    constructor({ onStatus = () => {}, onNotify = () => {}, now = Date.now } = {}) {
        this.onStatus = onStatus; this.onNotify = onNotify; this.now = now;
        this.globalNotify = bucket(6, 10_000, now());
        this.globalStatus = bucket(100, 10, now());
    }
    create(label, { onStatus = this.onStatus, notify = true } = {}) {
        if (this.closed) throw new Error('Notifications are closed.');
        label = notificationLabel(label);
        this.start();
        const path = join(this.directory, String(++this.next));
        const endpoint = new NotificationEndpoint({ label, path, helper: this.helper, connections: this.sockets,
            onMessage: message => this.handle(endpoint, message), onClose: () => this.endpoints.delete(path) });
        Object.assign(endpoint, { onStatus, notify });
        this.endpoints.set(path, endpoint);
        return endpoint;
    }
    start() {
        if (this.directory) return;
        if (process.platform === 'win32') throw new Error('Notifications require Unix-domain sockets (Linux/macOS).');
        this.directory = mkdtempSync('/tmp/pi-notify-');
        try {
            chmodSync(this.directory, 0o700);
            this.bin = join(this.directory, 'bin'); mkdirSync(this.bin, { mode: 0o700 });
            this.helper = join(this.bin, 'pi-notify');
            const script = fileURLToPath(new URL('./pi-notify.mjs', import.meta.url));
            writeFileSync(this.helper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o700 });
        } catch (error) { this.close(); throw error; }
    }
    handle(endpoint, message) {
        if (this.closed || endpoint.closed || this.endpoints.get(endpoint.path) !== endpoint) return { ok: false, error: 'unavailable' };
        if (!message || Array.isArray(message) || !['status', 'notify'].includes(message.type) || typeof message.text !== 'string' ||
            Object.keys(message).some(key => !['type', 'text'].includes(key))) return { ok: false, error: 'invalid_message' };
        const bytes = Buffer.byteLength(message.text);
        if (bytes > (message.type === 'status' ? IPC_LIMITS.statusBytes : IPC_LIMITS.notifyBytes)) return { ok: false, error: 'text_too_large' };
        const now = this.now();
        if (message.type === 'status') {
            if (!available(this.globalStatus, now)) return { ok: false, error: 'rate_limited' };
            this.globalStatus.tokens--;
            endpoint.onStatus({ id: endpoint.label, text: clean(message.text).replace(/[\r\n\t]/g, ' '), timestamp: new Date(now).toISOString() });
        } else {
            if (!endpoint.notify) return { ok: false, error: 'private_process' };
            const text = clean(message.text);
            if (!text.trim()) return { ok: false, error: 'invalid_message' };
            if (this.queue.length >= IPC_LIMITS.queue) return { ok: false, error: 'queue_full' };
            if (!available(this.globalNotify, now)) return { ok: false, error: 'rate_limited' };
            this.globalNotify.tokens--;
            this.queue.push({ id: endpoint.label, text, timestamp: new Date(now).toISOString() });
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
            let bytes = 2;
            for (const entry of this.queue) {
                const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
                if (bytes + size > IPC_LIMITS.batchBytes) break;
                batch.push(entry); bytes += size;
            }
            if (batch.length) {
                try {
                    if (this.onNotify(batch) !== false) {
                        this.queue.splice(0, batch.length);
                        this.scheduleFlush();
                    }
                } catch { /* Retain for a later flush; never crash the TUI. */ }
            }
        }, IPC_LIMITS.batchMs);
        this.flushTimer.unref();
    }
    acknowledge(batch) {
        if (this.closed || !batch.length || !batch.every((entry, index) => this.queue[index] === entry)) return false;
        this.queue.splice(0, batch.length); this.scheduleFlush(); return true;
    }
    close() {
        if (this.closed) return;
        this.closed = true; clearTimeout(this.flushTimer); this.flushTimer = undefined; this.queue.length = 0;
        for (const endpoint of this.endpoints.values()) endpoint.close();
        if (this.directory) {
            try { rmSync(this.directory, { recursive: true, force: true }); }
            catch (error) { this.failure = error.code ?? 'directory cleanup failed'; }
            this.directory = undefined;
        }
    }
}
