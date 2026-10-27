import { readFileSync } from 'node:fs';

// Streaming decoder for reserved foreground shortcuts. Other bytes (including
// UTF-8, arrows, paste and application keys) pass through unchanged.
export class ForegroundInput {
    pending = Buffer.alloc(0);
    constructor(write, interrupt, detach) {
        this.write = write; this.interrupt = interrupt; this.detach = detach;
    }
    feed(chunk) {
        const data = Buffer.concat([this.pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        this.pending = Buffer.alloc(0);
        let start = 0;
        for (let i = 0; i < data.length;) {
            let length = 0, action;
            if (data[i] === 3) { length = 1; action = 'interrupt'; }
            else if (data[i] === 26) { length = 1; action = 'detach'; }
            else if (data[i] === 27 && data[i + 1] === 91) {
                const rest = data.subarray(i).toString('ascii');
                const match = /^\x1b\[(?:(99|122);5(?::([123]))?u|27;5;(99|122)~)/.exec(rest);
                if (match) {
                    length = match[0].length;
                    action = match[2] === '3' ? 'release' : (match[1] || match[3]) === '99' ? 'interrupt' : 'detach';
                } else if (/^\x1b\[[0-9;:]*$/.test(rest) && rest.length < 64) {
                    if (i > start) this.write(data.subarray(start, i));
                    this.pending = data.subarray(i);
                    return;
                }
            } else if (data[i] === 27 && i + 1 === data.length) {
                if (i > start) this.write(data.subarray(start, i));
                this.pending = data.subarray(i);
                return;
            }
            if (!length) { i++; continue; }
            if (i > start) this.write(data.subarray(start, i));
            if (action === 'detach') { this.detach(); return; }
            if (action === 'interrupt') this.interrupt();
            i += length; start = i;
        }
        if (start < data.length) this.write(data.subarray(start));
    }
    flush() {
        if (this.pending.length) this.write(this.pending);
        this.pending = Buffer.alloc(0);
    }
}

export function interruptForeground(session) {
    if (!session.running) return;
    if (process.platform === 'linux') {
        try {
            // /proc stat: state, ppid, pgrp, session, tty_nr, tpgid, ...
            const stat = readFileSync(`/proc/${session.process.pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
            const sid = Number(fields[3]), foreground = Number(fields[5]);
            if (sid === session.process.pid && foreground > 0) {
                process.kill(-foreground, 'SIGINT');
                return;
            }
        } catch { /* Process exited, or /proc unavailable: use terminal VINTR. */ }
    }
    try { session.process.write('\x03'); } catch {}
}
