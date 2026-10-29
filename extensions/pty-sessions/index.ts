import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MouseRegion, matchesKey, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sessions, screenLines } from './sessions.ts';
import { ForegroundInput, interruptForeground } from './input.mjs';
import { registerManagedBash } from './bash.ts';
import { installProcessSettings } from './settings.ts';
import { registerSubagentResult } from './subagent-result.ts';
import { getNotificationService } from '../notifications/service.ts';

function label(value: string): string {
    return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export default function ptySessions(pi: ExtensionAPI) {
    const notifications = getNotificationService(pi);
    let host: any;
    let removeSettings: (() => void) | undefined;
    let releaseLiveness: (() => void) | undefined;
    const exitCleanup = () => { try { sessions.dispose(); } catch {} };
    let shuttingDown = false;
    let context: ExtensionContext | undefined;
    let attached: string | undefined;
    let recent: string | undefined;
    let finishAttach: (() => void) | undefined;
    let repaint: ReturnType<typeof setTimeout> | undefined;
    const sessions = new Sessions(() => {
        if (shuttingDown) return;
        if (attached) {
            const session = sessions.sessions.get(attached);
            if (session && !session.running) finishAttach?.();
        }
        if (!repaint) repaint = setTimeout(() => {
            repaint = undefined;
            if (!attached) host?.requestRender();
        }, 80);
    }, session => {
        if (shuttingDown || session.privateOutput || !session.notifyOnExit || session.exitNotified) return;
        session.exitNotified = true;
        const status = session.signal ? `signal ${session.signal}` : `exit ${session.exitCode}`;
        try {
            pi.sendMessage({ customType: 'process-exit',
                content: `Background process ${session.id} finished (${status}${session.timedOut ? '; hard timeout' : ''}). Use pty_snapshot with this ID to inspect output if relevant. This is a lifecycle notification, not a request to restart the command.`,
                display: true, details: { id: session.id, exitCode: session.exitCode, signal: session.signal, timedOut: !!session.timedOut } },
                { triggerTurn: true, deliverAs: 'followUp' });
        } catch (error) { context?.ui.notify(`Process completion notification failed: ${label(String(error))}`, 'warning'); }
    }, notifications);
    if (sessions.notifications !== notifications || typeof sessions.write !== 'function') {
        throw new Error('Managed-process backend version mismatch. Restart Pi to load matching extension files.');
    }
    registerSubagentResult(pi, sessions);

    function shellConfig(cwd: string): { shellPath: string; shellCommandPrefix: string } {
        const result = { shellPath: '/bin/bash', shellCommandPrefix: '' };
        const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
        for (const path of [join(agentDir, 'settings.json'), join(cwd, '.pi/settings.json')]) {
            try {
                const settings = JSON.parse(readFileSync(path, 'utf8'));
                if (typeof settings.shellPath === 'string') result.shellPath = settings.shellPath.replace(/^~(?=\/)/, homedir());
                if (typeof settings.shellCommandPrefix === 'string') result.shellCommandPrefix = settings.shellCommandPrefix;
            } catch {}
        }
        return result;
    }

    async function attach(id: string, ctx: ExtensionContext): Promise<void> {
        const session = sessions.sessions.get(id);
        if (!session) { ctx.ui.notify(`Unknown PTY: ${id}`, 'warning'); return; }
        if (!host || attached) return;
        // Only terminal focus changes: the parent may keep working while its
        // renderer/input loop is stopped. pty_write blocks input to attached jobs.
        recent = id;
        sessions.sessions.delete(id);
        sessions.sessions.set(id, session);
        if (!session.tty) {
            session.attached = true;
            try {
                await ctx.ui.custom<void>((tui, theme, _keys, done) => {
                    let offset = 0;
                    return {
                        render(width) {
                            const lines = screenLines(session, true);
                            while (lines.length > 1 && !stripTerminalSequences(lines[lines.length - 1]).trim()) lines.pop();
                            const count = Math.max(1, tui.terminal.rows - 4);
                            offset = Math.min(offset, Math.max(0, lines.length - count));
                            const end = lines.length - offset;
                            const status = session.running ? 'running' : session.signal ? `signal ${session.signal}` : `exit ${session.exitCode}`;
                            return [truncateToWidth(theme.fg('muted', `${id} · ${status}${session.statusText ? ` · ${label(session.statusText)}` : ''} · no TTY / read-only · ↑/↓ scroll · Ctrl+C interrupts · Esc closes`), width),
                                ...lines.slice(Math.max(0, end - count), end).map(line => truncateToWidth(line, width))];
                        },
                        handleInput(data) {
                            if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || matchesKey(data, 'ctrl+z')) done();
                            else if (matchesKey(data, 'ctrl+c')) sessions.stop(id, 'SIGINT', false);
                            else if (matchesKey(data, 'up') || matchesKey(data, 'pageUp')) { offset += matchesKey(data, 'pageUp') ? 10 : 1; tui.requestRender(); }
                            else if (matchesKey(data, 'down') || matchesKey(data, 'pageDown')) { offset = Math.max(0, offset - (matchesKey(data, 'pageDown') ? 10 : 1)); tui.requestRender(); }
                        },
                        invalidate() {},
                    };
                });
            } finally { session.attached = false; }
            return;
        }
        if (!session.running) {
            const snapshot = await sessions.snapshot(id, false);
            await ctx.ui.custom<void>((tui, theme, _keys, done) => ({
                render(width) {
                    const rows = screenLines(session).slice(0, Math.max(1, tui.terminal.rows - 4));
                    return [theme.fg('muted', `${id} · ${snapshot.signal ? `signal ${snapshot.signal}` : `exit ${snapshot.exitCode}`} · Esc/Enter closes`), ...rows.map(line => truncateToWidth(line, width))];
                },
                handleInput(data) { if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) done(); },
                invalidate() {},
            }));
            return;
        }
        await session.ready;
        attached = id;
        session.attached = true;
        host.stop();
        // Own a separate alternate screen while attached. Raw output goes only
        // here, never into Pi's layout or the preview renderer.
        process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
        const resize = () => {
            const cols = Math.max(20, process.stdout.columns || 100);
            const rows = Math.max(5, process.stdout.rows || 24);
            session.terminal.resize(cols, rows);
            if (session.running) { try { session.process.resize(cols, rows); } catch {} }
        };
        resize();
        process.stdout.write(screenLines(session).join('\r\n'));
        const buffer = session.terminal.buffer.active;
        process.stdout.write(`\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}H`);
        process.stdout.write(session.terminal.modes.applicationCursorKeysMode ? '\x1b[?1h' : '\x1b[?1l');
        process.stdout.write(session.terminal.modes.bracketedPasteMode ? '\x1b[?2004h' : '\x1b[?2004l');
        const output = (data: string) => process.stdout.write(data);
        session.listeners.add(output);
        try {
            await new Promise<void>(resolve => {
                let closed = false;
                let inputTimer: ReturnType<typeof setTimeout> | undefined;
                const detach = () => {
                    if (closed) return;
                    closed = true;
                    if (inputTimer) clearTimeout(inputTimer);
                    process.stdin.removeListener('data', input);
                    process.stdout.removeListener('resize', resize);
                    finishAttach = undefined;
                    resolve();
                };
                const decoder = new ForegroundInput((data: Buffer) => {
                    if (session.running) { try { session.process.write(data); } catch { detach(); } }
                }, () => interruptForeground(session), detach);
                const input = (data: Buffer) => {
                    if (inputTimer) clearTimeout(inputTimer);
                    decoder.feed(data);
                    // A standalone Escape must not wait indefinitely for a CSI.
                    if (!closed && decoder.pending.length) inputTimer = setTimeout(() => decoder.flush(), 40);
                };
                finishAttach = detach;
                process.stdout.on('resize', resize);
                process.stdin.setRawMode?.(true);
                process.stdin.on('data', input);
                process.stdin.resume();
                if (!session.running) detach();
            });
        } finally {
            session.listeners.delete(output);
            session.attached = false;
            attached = undefined;
            process.stdout.write('\x1b[0m\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1l\x1b[?25h\x1b[?1049l');
            if (!shuttingDown) {
                host.start();
                host.requestRender(true);
            } else process.stdin.setRawMode?.(false);
        }
    }

    registerManagedBash(pi, sessions, shellConfig, (session, ctx) => {
        if (ctx.mode !== 'tui') return;
        pi.sendMessage({ customType: 'pty-preview', content: `Managed process ${session.id} continues in background.`,
            display: true, details: { id: session.id } }, { deliverAs: 'nextTurn' });
    }, session => { recent = session.id; });

    pi.registerMessageRenderer('pty-preview', (message, options, theme) => {
        const id = (message.details as { id: string }).id;
        const content = {
            render(width: number) {
                const session = sessions.sessions.get(id);
                if (!session) return [theme.fg('muted', `${id} · PTY unavailable after restart/reload`)];
                const status = session.running ? 'running' : session.signal ? `signal ${session.signal}` : `exit ${session.exitCode}`;
                const header = `${id} · ${status} · ${session.tty ? 'TTY' : 'no TTY'}${session.privateOutput ? ' · private !!' : ''}${session.statusText ? ` · ${label(session.statusText)}` : ''} · ${label(session.command)}`;
                const buffer = session.terminal.buffer.active;
                // A full-screen child's first rows are usually a logo/help header,
                // not useful progress. Keep collapsed previews metadata-only, also
                // after detaching; expanded previews and snapshots stay complete.
                const hideScreen = !options.expanded && buffer.type === 'alternate';
                const lines = hideScreen ? [] : screenLines(session, options.expanded);
                let end = lines.length;
                const start = options.expanded ? 0 : buffer.baseY;
                while (end > 1 && !buffer.getLine(start + end - 1)?.translateToString(true)) end--;
                const visible = options.expanded ? lines.slice(0, end) : lines.slice(Math.max(0, end - 8), end);
                return [truncateToWidth(theme.fg('muted', header), width),
                    ...visible.map(line => truncateToWidth(line, width)),
                    truncateToWidth(theme.fg('muted', `Ctrl+O ${options.expanded ? 'collapses' : 'expands'} · Ctrl+click to ${session.tty ? 'attach' : 'view'} · /fg · /top`), width)];
            },
            invalidate() {},
        };
        return new MouseRegion(content, event => {
            if (!event.ctrl || event.button !== 'left') return;
            if (event.type === 'press') return { handled: true, render: false };
            if (event.type === 'click' && context) { void attach(id, context); return { handled: true }; }
        });
    });

    pi.on('session_start', (_event, ctx) => {
        shuttingDown = false;
        context = ctx;
        process.removeListener('exit', exitCleanup);
        process.once('exit', exitCleanup);
        releaseLiveness?.();
        releaseLiveness = undefined;
        const liveness = (globalThis as any)[Symbol.for('@agegr/pi-web/session-liveness/v1')];
        if (liveness?.version === 1 && ctx.sessionManager?.getSessionId) {
            releaseLiveness = liveness.register({ name: 'managed-processes', sessionId: ctx.sessionManager.getSessionId(),
                sessionFile: ctx.sessionManager.getSessionFile?.(), isActive: () => [...sessions.sessions.values()].some(s => s.running) });
        }
        if (ctx.mode !== 'tui') return;
        // Invisible factory obtains the host TUI for stop/start and repaints.
        ctx.ui.setWidget('pty-host', (tui, theme) => {
            removeSettings?.();
            host = tui;
            removeSettings = installProcessSettings(tui, theme, ctx);
            return { render: () => [], invalidate() {} };
        });
    });
    pi.on('session_shutdown', () => {
        shuttingDown = true;
        removeSettings?.();
        removeSettings = undefined;
        releaseLiveness?.();
        releaseLiveness = undefined;
        process.removeListener('exit', exitCleanup);
        finishAttach?.();
        if (repaint) clearTimeout(repaint);
        sessions.dispose();
    });

    pi.on('user_bash', async (event, ctx) => {
        if (ctx.mode !== 'tui') return;
        if ([...sessions.sessions.values()].filter(s => s.running).length >= 16) {
            throw new Error('At most 16 running PTYs are supported; attach and exit an existing session first.');
        }
        const config = shellConfig(event.cwd);
        const session = sessions.start(event.command, event.cwd, event.excludeFromContext,
            Math.max(20, host?.terminal.columns || 100), Math.max(5, host?.terminal.rows || 24),
            config.shellPath, config.shellCommandPrefix, { tty: true, source: 'user', background: true });
        session.notifyOnExit = !event.excludeFromContext;
        recent = session.id;
        pi.sendMessage({ customType: 'pty-preview', content: `PTY session ${session.id} started${event.excludeFromContext ? ' (private)' : ''}.`,
            display: true, details: { id: session.id } });
        return { result: { output: `Started ${session.id} in background. Use /fg ${session.id} or /top to attach.`,
            exitCode: 0, cancelled: false, truncated: false } };
    });

    pi.registerCommand('fg', {
        description: 'Attach to a TTY or view a pipe process: /fg [id], default most recently used running session',
        handler: async (args, ctx) => {
            const id = args.trim() || (recent && sessions.sessions.get(recent)?.running ? recent :
                [...sessions.sessions.values()].reverse().find(s => s.running)?.id);
            if (!id) { ctx.ui.notify('No running PTYs. Start one with !command.', 'info'); return; }
            await attach(id, ctx);
        },
    });
    pi.registerCommand('top', {
        description: 'Choose a managed process with arrows or Ctrl+J/Ctrl+K; Enter attaches to TTYs or views pipe output',
        handler: async (_args, ctx) => {
            const entries = sessions.list(false);
            if (!entries.length) { ctx.ui.notify('No PTY sessions yet.', 'info'); return; }
            const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
                let index = 0;
                return {
                    render(width) {
                        const count = Math.max(1, Math.min(8, tui.terminal.rows - 6));
                        const start = Math.max(0, Math.min(index - count + 1, entries.length - count));
                        return [theme.fg('muted', 'Processes · ↑/↓ or Ctrl+K/J · Enter selects · Esc closes'),
                            ...entries.slice(start, start + count).map((entry, offset) => {
                                const session = sessions.sessions.get(entry.id);
                                const status = session?.running ? 'running' : session?.signal ? `signal ${session.signal}` : `exit ${session?.exitCode}`;
                                return truncateToWidth(theme.fg(start + offset === index ? 'accent' : 'muted',
                                    `${start + offset === index ? '›' : ' '} ${entry.id} · ${status} · ${entry.tty ? 'TTY' : 'pipe'}${entry.private ? ' · private' : ''}${session?.statusText ? ` · ${label(session.statusText)}` : ''} · ${label(entry.command)}`), width);
                            })];
                    },
                    handleInput(data) {
                        if (matchesKey(data, 'escape')) done(undefined);
                        else if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+k')) { index = (index - 1 + entries.length) % entries.length; tui.requestRender(); }
                        else if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+j')) { index = (index + 1) % entries.length; tui.requestRender(); }
                        else if (matchesKey(data, 'enter')) done(entries[index].id);
                    },
                    invalidate() {},
                };
            });
            if (selected) await attach(selected, ctx);
        },
    });

    for (const [command, signal, description] of [
        ['stop', 'SIGTERM', 'Gracefully terminate a managed process'],
        ['kill', 'SIGKILL', 'Force-kill a managed process'],
    ]) pi.registerCommand(command, {
        description: `${description}: /${command} id (${signal})`,
        handler: async (args, ctx) => {
            const [id, extra] = args.trim().split(/\s+/);
            if (!id || extra) { ctx.ui.notify(`Usage: /${command} id`, 'warning'); return; }
            try { sessions.stop(id, signal, false); ctx.ui.notify(`Sent ${signal} to ${id}.`, 'info'); }
            catch (error) { ctx.ui.notify(label(String(error)), 'warning'); }
        },
    });
    pi.registerTool({
        name: 'pty_write', label: 'PTY input',
        description: 'Send UTF-8 input to a public interactive TTY. data is raw terminal input; submit appends Enter. Private, exited, non-TTY and user-attached sessions are denied.',
        parameters: Type.Object({ id: Type.String(), data: Type.String({ maxLength: 16384 }), submit: Type.Optional(Type.Boolean()) }),
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
        async execute(_id, args) {
            sessions.write(args.id, args.data, args.submit ?? false);
            return { content: [{ type: 'text', text: `Sent input to ${args.id}.` }], details: { id: args.id } };
        },
    });
    pi.registerTool({
        name: 'pty_stop', label: 'Stop process',
        description: 'Signal the process group of a public managed process or TTY. Default SIGTERM; SIGINT interrupts, SIGKILL forces termination. Private !! sessions cannot be controlled by model tools.',
        parameters: Type.Object({ id: Type.String(), signal: Type.Optional(Type.Union([Type.Literal('SIGTERM'), Type.Literal('SIGINT'), Type.Literal('SIGKILL')])) }),
        async execute(_id, args) {
            const signal = args.signal ?? 'SIGTERM';
            if (!['SIGTERM', 'SIGINT', 'SIGKILL'].includes(signal)) throw new Error('Unsupported signal.');
            sessions.stop(args.id, signal);
            return { content: [{ type: 'text', text: `Sent ${signal} to ${args.id}.` }], details: { id: args.id, signal } };
        },
    });

    pi.registerTool({
        name: 'pty_list', label: 'PTY sessions', description: 'List managed bash processes and user-started TTY sessions. Includes TTY/pipe mode, running state, IDs and latest statusText. Children can report with pi-process status|notify "text". Private !! command, output and status are redacted.',
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute() {
            const list = sessions.list();
            return { content: [{ type: 'text', text: JSON.stringify(list) }], details: undefined };
        },
    });
    pi.registerTool({
        name: 'pty_snapshot', label: 'PTY screen', description: 'Inspect a public managed process or TTY: status, screen, recent plain output and bounded log path. Does not attach or send input. Private !! output is denied.',
        parameters: Type.Object({ id: Type.String({ description: 'PTY id from pty_list' }) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute(_id, args) {
            const snapshot = await sessions.snapshot(args.id);
            return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], details: undefined };
        },
    });
}
