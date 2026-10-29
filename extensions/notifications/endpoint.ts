import { createServer } from 'node:net';
import { chmodSync, unlinkSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';

export const IPC_LIMITS = Object.freeze({ frameBytes: 65536, statusBytes: 1024, notifyBytes: 8192,
    labelBytes: 128, connections: 32, queue: 32, idleMs: 3000, batchMs: 100, batchBytes: 32768 });

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
        socket.setTimeout(IPC_LIMITS.idleMs, () => socket.destroy());
        const deadline = setTimeout(() => socket.destroy(), IPC_LIMITS.idleMs); deadline.unref();
        socket.on('error', () => {});
        socket.once('close', () => { clearTimeout(deadline); this.sockets.delete(socket); this.connections.delete(socket); });
        let buffer = Buffer.alloc(0), answered = false;
        const reply = result => {
            if (answered) return;
            answered = true; socket.end(`${JSON.stringify(result)}\n`);
        };
        socket.on('data', chunk => {
            if (answered) return;
            if (buffer.length + chunk.length > IPC_LIMITS.frameBytes) { reply({ ok: false, error: 'frame_too_large' }); return; }
            buffer = Buffer.concat([buffer, chunk]);
            const newline = buffer.indexOf(10);
            if (newline < 0) return;
            try {
                if (buffer.subarray(newline + 1).toString('utf8').trim()) throw new Error('extra frame');
                reply(this.onMessage(JSON.parse(buffer.subarray(0, newline).toString('utf8'))));
            } catch { reply({ ok: false, error: 'invalid_message' }); }
        });
        socket.once('end', () => { if (!answered) reply({ ok: false, error: 'incomplete_message' }); });
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
