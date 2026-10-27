import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MouseRegion, matchesKey, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';
import { Type } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Sessions, screenLines } from './sessions.mjs';
import { ForegroundInput, interruptForeground } from './input.mjs';

function label(value: string): string {
    return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

export default function ptySessions(pi: ExtensionAPI) {
    let host: any;
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
    });

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
        if (!ctx.isIdle()) { ctx.ui.notify('Wait for the agent to finish before attaching.', 'warning'); return; }
        recent = id;
        sessions.sessions.delete(id);
        sessions.sessions.set(id, session);
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

    pi.registerMessageRenderer('pty-preview', (message, options, theme) => {
        const id = (message.details as { id: string }).id;
        const content = {
            render(width: number) {
                const session = sessions.sessions.get(id);
                if (!session) return [theme.fg('muted', `${id} · PTY unavailable after restart/reload`)];
                const status = session.running ? 'running' : session.signal ? `signal ${session.signal}` : `exit ${session.exitCode}`;
                const header = `${id} · ${status}${session.privateOutput ? ' · private !!' : ''} · ${label(session.command)}`;
                const lines = screenLines(session, options.expanded);
                let end = lines.length;
                const buffer = session.terminal.buffer.active;
                const start = options.expanded ? 0 : buffer.baseY;
                while (end > 1 && !buffer.getLine(start + end - 1)?.translateToString(true)) end--;
                const visible = options.expanded ? lines.slice(0, end) :
                    buffer.type === 'alternate' ? lines.slice(0, 8) : lines.slice(Math.max(0, end - 8), end);
                return [truncateToWidth(theme.fg('muted', header), width),
                    ...visible.map(line => truncateToWidth(line, width)),
                    truncateToWidth(theme.fg('muted', `Ctrl+O ${options.expanded ? 'collapses' : 'expands'} · Ctrl+click to attach · /fg · /pty-list`), width)];
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
        if (ctx.mode !== 'tui') return;
        // Invisible factory obtains the host TUI for stop/start and repaints.
        ctx.ui.setWidget('pty-host', tui => {
            host = tui;
            return { render: () => [], invalidate() {} };
        });
    });
    pi.on('session_shutdown', () => {
        shuttingDown = true;
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
            config.shellPath, config.shellCommandPrefix);
        recent = session.id;
        pi.sendMessage({ customType: 'pty-preview', content: `PTY session ${session.id} started${event.excludeFromContext ? ' (private)' : ''}.`,
            display: true, details: { id: session.id } });
        return { result: { output: `Started ${session.id} in background. Use /fg ${session.id} or /pty-list to attach.`,
            exitCode: 0, cancelled: false, truncated: false } };
    });

    pi.registerCommand('fg', {
        description: 'Attach to a PTY: /fg [id], default most recently used running session',
        handler: async (args, ctx) => {
            const id = args.trim() || (recent && sessions.sessions.get(recent)?.running ? recent :
                [...sessions.sessions.values()].reverse().find(s => s.running)?.id);
            if (!id) { ctx.ui.notify('No running PTYs. Start one with !command.', 'info'); return; }
            await attach(id, ctx);
        },
    });
    pi.registerCommand('pty-list', {
        description: 'Choose a PTY with arrows or Ctrl+J/Ctrl+K; Enter attaches',
        handler: async (_args, ctx) => {
            const entries = sessions.list(false);
            if (!entries.length) { ctx.ui.notify('No PTY sessions yet.', 'info'); return; }
            const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
                let index = 0;
                return {
                    render(width) {
                        const count = Math.max(1, Math.min(8, tui.terminal.rows - 6));
                        const start = Math.max(0, Math.min(index - count + 1, entries.length - count));
                        return [theme.fg('muted', 'PTYs · ↑/↓ or Ctrl+K/J · Enter selects · Esc closes'),
                            ...entries.slice(start, start + count).map((entry, offset) => {
                                const session = sessions.sessions.get(entry.id);
                                const status = session?.running ? 'running' : session?.signal ? `signal ${session.signal}` : `exit ${session?.exitCode}`;
                                return truncateToWidth(theme.fg(start + offset === index ? 'accent' : 'muted',
                                    `${start + offset === index ? '›' : ' '} ${entry.id} · ${status}${entry.private ? ' · private' : ''} · ${label(entry.command)}`), width);
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

    pi.registerTool({
        name: 'pty_list', label: 'PTY sessions', description: 'List user-started PTY sessions. Private !! command text and output are not exposed.',
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute() {
            const list = sessions.list();
            return { content: [{ type: 'text', text: JSON.stringify(list) }], details: undefined };
        },
    });
    pi.registerTool({
        name: 'pty_snapshot', label: 'PTY screen', description: 'Read the current rendered screen of a public PTY, including process status and cursor position. Does not attach or send input. Private !! output is denied.',
        parameters: Type.Object({ id: Type.String({ description: 'PTY id from pty_list' }) }),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        async execute(_id, args) {
            const snapshot = await sessions.snapshot(args.id);
            return { content: [{ type: 'text', text: JSON.stringify(snapshot) }], details: undefined };
        },
    });
}
