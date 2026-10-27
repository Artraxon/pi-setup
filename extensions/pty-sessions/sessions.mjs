import pty from 'node-pty';
import headless from '@xterm/headless';
const { Terminal } = headless;

export class Sessions {
    sessions = new Map();
    next = 1;
    constructor(onChange = () => {}) { this.onChange = onChange; }
    start(command, cwd, privateOutput, cols = 100, rows = 24, shell = '/bin/bash', prefix = '') {
        // Bound retained terminal buffers and logs in long-lived Pi sessions.
        if (this.sessions.size >= 32) {
            for (const [oldId, old] of this.sessions) {
                if (!old.running && !old.attached) {
                    old.disposed = true;
                    old.terminal.dispose();
                    this.sessions.delete(oldId);
                    break;
                }
            }
        }
        const id = `pty-${this.next++}`;
        const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true });
        const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
        // PTY detection, rather than global force-color variables, controls output.
        if (env.FORCE_COLOR === '1') delete env.FORCE_COLOR;
        if (env.CLICOLOR_FORCE === '1') delete env.CLICOLOR_FORCE;
        const processPty = pty.spawn(shell, ['-c', prefix ? `${prefix}\n${command}` : command], {
            name: 'xterm-256color', cols, rows, cwd, env: { ...env, TERM: 'xterm-256color' },
        });
        const session = { id, command, cwd, privateOutput, terminal, process: processPty,
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), running: true,
            exitCode: undefined, signal: undefined, listeners: new Set(), log: '', ready: Promise.resolve(),
            pendingBytes: 0, paused: false };
        this.sessions.set(id, session);
        terminal.onData(data => { if (!session.attached && session.running) processPty.write(data); });
        processPty.onData(data => {
            if (session.disposed) return;
            // Bounded raw log stays local; snapshots are read from the emulator.
            session.log = (session.log + data).slice(-1_000_000);
            session.pendingBytes += data.length;
            if (session.pendingBytes > 262144 && !session.paused) { processPty.pause(); session.paused = true; }
            session.ready = new Promise(resolve => terminal.write(data, () => {
                session.pendingBytes -= data.length;
                if (session.paused && session.pendingBytes < 131072 && session.running && !session.disposed) {
                    processPty.resume(); session.paused = false;
                }
                resolve();
            }));
            session.updatedAt = new Date().toISOString();
            for (const listener of session.listeners) listener(data);
            void session.ready.then(() => { if (!session.disposed) this.onChange(session); });
        });
        processPty.onExit(({ exitCode, signal }) => {
            if (session.disposed) return;
            session.running = false; session.exitCode = exitCode; session.signal = signal;
            void session.ready.then(() => { if (!session.disposed) this.onChange(session); });
        });
        return session;
    }
    async snapshot(id, model = true) {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Unknown PTY: ${id}`);
        if (model && session.privateOutput) throw new Error('Private !! output is not accessible to model tools.');
        await session.ready;
        const buffer = session.terminal.buffer.active;
        const lines = Array.from({ length: session.terminal.rows }, (_, row) =>
            buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
        return { id, command: session.command, running: session.running, exitCode: session.exitCode, signal: session.signal,
            cols: session.terminal.cols, rows: session.terminal.rows,
            cursor: { x: buffer.cursorX, y: buffer.cursorY }, screen: lines.join('\n'),
            timestamp: new Date().toISOString() };
    }
    list(model = true) {
        return [...this.sessions.values()].reverse().map(s => ({ id: s.id,
            command: model && s.privateOutput ? '[private !! session]' : s.command,
            private: s.privateOutput, running: s.running, exitCode: s.exitCode, signal: s.signal, createdAt: s.createdAt }));
    }
    dispose() {
        for (const session of this.sessions.values()) {
            session.disposed = true;
            if (session.running) {
                // Unix PTYs get their own process group. Terminate the group,
                // not just the shell leader, so normal child jobs do not leak.
                try { process.kill(-session.process.pid, 'SIGKILL'); }
                catch { try { session.process.kill('SIGKILL'); } catch {} }
            }
            session.terminal.dispose();
        }
        this.sessions.clear();
    }
}

// Render cells, not raw PTY escape sequences: a command cannot move Pi's cursor,
// change the clipboard or inject OSC hyperlinks through this preview.
export function screenLines(session, includeScrollback = false) {
    const terminal = session.terminal, buffer = terminal.buffer.active;
    const start = includeScrollback ? 0 : buffer.baseY;
    const count = includeScrollback ? buffer.baseY + terminal.rows : terminal.rows;
    return Array.from({ length: count }, (_, row) => {
        const line = buffer.getLine(start + row);
        if (!line) return '';
        let text = '', previous = '';
        for (let column = 0; column < terminal.cols; column++) {
            const cell = line.getCell(column);
            if (!cell || cell.getWidth() === 0) continue;
            const codes = [0];
            for (const [foreground, rgb, palette, color] of [
                [true, cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor()],
                [false, cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor()],
            ]) {
                if (rgb) codes.push(foreground ? 38 : 48, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255);
                else if (palette) codes.push(foreground ? 38 : 48, 5, color);
            }
            if (cell.isBold()) codes.push(1);
            if (cell.isDim()) codes.push(2);
            if (cell.isItalic()) codes.push(3);
            if (cell.isUnderline()) codes.push(4);
            if (cell.isInverse()) codes.push(7);
            const style = `\x1b[${codes.join(';')}m`;
            if (style !== previous) { text += style; previous = style; }
            text += cell.getChars() || ' ';
        }
        return text + '\x1b[0m';
    });
}
