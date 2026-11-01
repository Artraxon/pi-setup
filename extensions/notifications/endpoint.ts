import { createServer } from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

export const IPC_LIMITS = Object.freeze({ frameBytes: 65536, statusBytes: 1024, notifyBytes: 8192,
    labelBytes: 128, connections: 32, queue: 32, batchMs: 100, batchBytes: 32768 });

// Optional first line emitted by NebulaStream's File sink for notification output.
const NEBULASTREAM_SCHEMA = '"type":VARSIZED:NOT_NULLABLE,"text":VARSIZED:NOT_NULLABLE';

// One socket, one parent-assigned label. Clients never send their identity.
export class NotificationEndpoint {
    sockets = new Set();
    closed = false;
    constructor({ label, path, helper, connections, onMessage, onClose }) {
        Object.assign(this, { label, path, helper, connections, onMessage, onClose });
        this.server = createServer(socket => this.accept(socket));
        this.server.maxConnections = IPC_LIMITS.connections;
        this.server.on('error', error => { this.failure = error.code ?? 'server error'; this.close(); });
        this.server.once('listening', () => {
            if (this.closed) return;
            try { chmodSync(this.path, 0o600); }
            catch (error) { this.failure = error.code ?? 'socket permissions'; this.close(); }
        });
        try { this.server.listen(path); this.server.unref(); }
        catch (error) { this.close(); throw error; }
    }
    environment(inherited = {}) {
        if (this.closed) throw new Error(`Notification endpoint is closed${this.failure ? ` (${this.failure})` : ''}.`);
        return { PI_NOTIFY_SOCKET: this.path, PI_NOTIFY_HELPER: this.helper,
            PATH: `${dirname(this.helper)}${delimiter}${inherited.PATH ?? '/usr/bin:/bin'}` };
    }
    accept(socket) {
        if (this.closed || this.connections.size >= IPC_LIMITS.connections) { socket.destroy(); return; }
        this.sockets.add(socket); this.connections.add(socket);
        socket.unref();
        socket.on('error', () => {});
        socket.once('close', () => { this.sockets.delete(socket); this.connections.delete(socket); });
        socket.on('drain', () => socket.resume());
        let buffer = Buffer.alloc(0), failed = false, firstFrame = true;
        const fail = error => {
            failed = true; socket.end(`${JSON.stringify({ ok: false, error })}\n`);
        };
        socket.on('data', chunk => {
            if (failed) return;
            buffer = Buffer.concat([buffer, chunk]);
            let newline;
            while ((newline = buffer.indexOf(10)) >= 0) {
                if (newline + 1 > IPC_LIMITS.frameBytes) { fail('frame_too_large'); return; }
                const frame = buffer.subarray(0, newline).toString('utf8');
                buffer = buffer.subarray(newline + 1);
                const isSchema = firstFrame && frame === NEBULASTREAM_SCHEMA;
                firstFrame = false;
                if (isSchema) continue;
                let result;
                try { result = this.onMessage(JSON.parse(frame)); }
                catch { fail('invalid_message'); return; }
                if (!socket.write(`${JSON.stringify(result)}\n`)) socket.pause();
            }
            if (buffer.length > IPC_LIMITS.frameBytes) fail('frame_too_large');
        });
        socket.once('end', () => { if (!failed && buffer.length) fail('incomplete_message'); });
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        for (const socket of this.sockets) { socket.destroy(); this.connections.delete(socket); }
        this.sockets.clear();
        try { this.server.close(); } catch {}
        try { unlinkSync(this.path); } catch (error) { if (error.code !== 'ENOENT') this.failure ??= error.code; }
        this.onClose();
    }
}
