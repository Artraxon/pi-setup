import pty from 'node-pty';
import headless from '@xterm/headless';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { ProcessChannel } from './ipc.ts';
const { Terminal } = headless;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
export const cleanOutput = value => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

export class Sessions {
    sessions = new Map();
    next = 1;
    directory;
    constructor(onChange = () => {}, onExit = () => {}, onNotify = () => {}) {
        this.onChange = onChange; this.onExit = onExit;
        this.channel = new ProcessChannel({ onStatus: session => this.onChange(session), onNotify });
    }
    start(command, cwd, privateOutput, cols = 100, rows = 24, shell = '/bin/bash', prefix = '', options = {}) {
        if ([...this.sessions.values()].filter(s => s.running).length >= 16) throw new Error('At most 16 running processes are supported. Stop an existing session first.');
        if (this.sessions.size >= 32) {
            const old = [...this.sessions.values()].find(s => !s.running && !s.attached);
            if (!old) throw new Error('No free process retention slots.');
            old.disposed = true;
            this.channel.revoke(old);
            old.terminal.dispose();
            if (old.outputPath) rmSync(old.outputPath, { force: true });
            this.sessions.delete(old.id);
        }
        const tty = options.tty ?? true;
        const id = `pty-${this.next++}`;
        const terminal = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true, convertEol: !tty });
        const env = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([, value]) => value !== undefined));
        delete env.PI_WEB_PASSWORD;
        if (env.FORCE_COLOR === '1') delete env.FORCE_COLOR;
        if (env.CLICOLOR_FORCE === '1') delete env.CLICOLOR_FORCE;
        let resolveDone;
        const done = new Promise(resolve => { resolveDone = resolve; });
        const session = { id, command, cwd, privateOutput, terminal, tty, source: options.source ?? 'user',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), running: true,
            exitCode: undefined, signal: undefined, listeners: new Set(), log: '', ready: Promise.resolve(), done, resolveDone,
            pendingBytes: 0, paused: false, background: options.background ?? false, notifyOnExit: false,
            totalOutputBytes: 0, capturedBytes: 0, outputFileTruncated: false };
        // Private !! output remains in memory only, never in an inspectable log file.
        try {
            if (!privateOutput) {
                this.directory ??= mkdtempSync(join(tmpdir(), 'pi-processes-'));
                session.outputPath = join(this.directory, `${id}.log`);
                session.logFd = openSync(session.outputPath, 'wx', 0o600);
            }
        } catch (error) { terminal.dispose(); throw error; }
        const closeLog = () => {
            if (session.logFd !== undefined) { try { closeSync(session.logFd); } catch {} session.logFd = undefined; }
        };
        session.closeLog = closeLog;
        const receive = data => {
            if (session.disposed || !data) return;
            const bytes = Buffer.from(data);
            session.totalOutputBytes += bytes.length;
            if (session.logFd !== undefined && !session.logError) {
                try {
                    const remaining = MAX_LOG_BYTES - session.capturedBytes;
                    if (remaining > 0) {
                        const chunk = bytes.subarray(0, remaining);
                        let written = 0;
                        while (written < chunk.length) written += writeSync(session.logFd, chunk, written, chunk.length - written);
                        session.capturedBytes += written;
                    }
                    session.outputFileTruncated = session.totalOutputBytes > MAX_LOG_BYTES;
                } catch (error) { session.logError = error.message; closeLog(); }
            }
            session.tailTruncated ||= session.log.length + data.length > 1_000_000;
            session.log = (session.log + data).slice(-1_000_000);
            session.pendingBytes += bytes.length;
            if (session.pendingBytes > 262144 && !session.paused) { session.process.pause(); session.paused = true; }
            session.ready = new Promise(resolve => terminal.write(data, () => {
                session.pendingBytes -= bytes.length;
                if (session.paused && session.pendingBytes < 131072 && session.running && !session.disposed) {
                    session.process.resume(); session.paused = false;
                }
                resolve();
            }));
            session.updatedAt = new Date().toISOString();
            for (const listener of session.listeners) listener(data);
            void session.ready.then(() => { if (!session.disposed) this.onChange(session); });
        };
        const finish = (exitCode, signal) => {
            if (!session.running || session.disposed) return;
            session.running = false; session.exitCode = exitCode; session.signal = signal;
            this.channel.revoke(session);
            clearTimeout(session.timeoutTimer);
            closeLog();
            void session.ready.then(() => {
                session.resolveDone(session);
                if (!session.disposed) { this.onChange(session); this.onExit(session); }
            });
        };
        const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
        try {
            Object.assign(env, this.channel.environment(session, env));
            if (tty) {
                const processPty = pty.spawn(shell, ['-c', resolvedCommand], { name: 'xterm-256color', cols, rows, cwd, env: { ...env, TERM: 'xterm-256color' } });
                session.process = processPty;
                terminal.onData(data => { if (!session.attached && session.running) processPty.write(data); });
                processPty.onData(receive);
                processPty.onExit(({ exitCode, signal }) => finish(exitCode, signal));
            } else {
                const child = spawn(shell, ['-c', resolvedCommand], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
                session.process = { pid: child.pid,
                    pause() { child.stdout.pause(); child.stderr.pause(); },
                    resume() { child.stdout.resume(); child.stderr.resume(); },
                    kill(signal = 'SIGTERM') { child.kill(signal); },
                    resize() {},
                    write() { throw new Error('This process has no interactive stdin. Launch bash with tty: true for interaction.'); },
                };
                [child.stdout, child.stderr].forEach(stream => {
                    const decoder = new StringDecoder('utf8');
                    stream.on('data', data => receive(decoder.write(data)));
                    stream.on('end', () => receive(decoder.end()));
                });
                child.once('error', error => { receive(`Process spawn failed: ${error.message}\n`); finish(127); });
                child.once('close', (code, signal) => finish(code, signal));
                session.child = child;
            }
        } catch (error) {
            session.disposed = true;
            this.channel.revoke(session);
            closeLog(); terminal.dispose();
            if (session.outputPath) rmSync(session.outputPath, { force: true });
            throw error;
        }
        this.sessions.set(id, session);
        if (options.timeout !== undefined) session.timeoutTimer = setTimeout(() => {
            session.timedOut = true;
            this.stop(id, 'SIGKILL', false);
        }, options.timeout * 1000);
        return session;
    }
    stop(id, signal = 'SIGTERM', model = true) {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Unknown process: ${id}`);
        if (model && session.privateOutput) throw new Error('Private !! sessions cannot be controlled by model tools.');
        if (!session.running) return;
        if (!session.process.pid) return;
        try { process.kill(-session.process.pid, signal); }
        catch { try { session.process.kill(signal); } catch {} }
    }
    write(id, data, submit = false, model = true) {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Unknown process: ${id}`);
        if (model && session.privateOutput) throw new Error('Private !! sessions cannot receive model input.');
        if (!session.running || session.disposed) throw new Error('Process is no longer running.');
        if (!session.tty) throw new Error('This process has no TTY. Launch with tty: true.');
        if (session.attached) throw new Error('TTY is attached by the user; detach before sending model input.');
        if (typeof data !== 'string' || Buffer.byteLength(data) > 16384) throw new Error('Input must be a UTF-8 string of at most 16384 bytes.');
        session.process.write(data + (submit ? '\r' : ''));
    }
    async snapshot(id, model = true) {
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Unknown process: ${id}`);
        if (model && session.privateOutput) throw new Error('Private !! output is not accessible to model tools.');
        await session.ready;
        const buffer = session.terminal.buffer.active;
        const lines = Array.from({ length: session.terminal.rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
        return { id, command: session.command, running: session.running, exitCode: session.exitCode, signal: session.signal,
            tty: session.tty, background: session.background, timedOut: !!session.timedOut,
            ...(session.statusText !== undefined ? { statusText: session.statusText, statusUpdatedAt: session.statusUpdatedAt } : {}),
            cols: session.terminal.cols, rows: session.terminal.rows,
            cursor: { x: buffer.cursorX, y: buffer.cursorY }, screen: lines.join('\n'),
            output: cleanOutput(session.log).slice(-65536), outputTruncated: !!session.tailTruncated || cleanOutput(session.log).length > 65536,
            outputPath: session.outputPath, outputFileTruncated: session.outputFileTruncated || !!session.logError,
            timestamp: new Date().toISOString() };
    }
    list(model = true) {
        return [...this.sessions.values()].reverse().map(s => ({ id: s.id,
            command: model && s.privateOutput ? '[private !! session]' : s.command,
            private: s.privateOutput, running: s.running, tty: s.tty, source: s.source, background: s.background,
            exitCode: s.exitCode, signal: s.signal, createdAt: s.createdAt,
            ...(s.statusText !== undefined && !(model && s.privateOutput) ? { statusText: s.statusText, statusUpdatedAt: s.statusUpdatedAt } : {}) }));
    }
    dispose() {
        this.channel.close();
        for (const session of this.sessions.values()) {
            clearTimeout(session.timeoutTimer);
            if (session.running) this.stop(session.id, 'SIGKILL', false);
            session.disposed = true; session.running = false;
            session.closeLog();
            session.resolveDone(session);
            session.terminal.dispose();
        }
        this.sessions.clear();
        if (this.directory) { rmSync(this.directory, { recursive: true, force: true }); this.directory = undefined; }
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
