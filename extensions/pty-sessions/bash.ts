import { Type } from '@earendil-works/pi-ai';
import { constants } from 'node:os';
import { backgroundAfterSeconds, validateSeconds } from './settings.ts';
import { cleanOutput } from './sessions.ts';

const tail = (text: string, bytes: number) => {
    const buffer = Buffer.from(text);
    return buffer.length <= bytes ? text : buffer.subarray(-bytes).toString('utf8');
};

export function registerManagedBash(pi: any, sessions: any, shellConfig: (cwd: string) => any,
    onBackground: (session: any, ctx: any) => void, onStart: (session: any) => void = () => {}) {
    pi.registerTool({
        name: 'bash', label: 'bash',
        description: 'Execute a shell command, no TTY by default. After the /settings foreground wait (15s), return background:true while the job keeps running; exit notifies the agent. Inspect with pty_snapshot; stop with pty_stop. Output: last 2000 lines/50 KiB, with a log path when truncated.',
        promptSnippet: 'Execute bash commands (ls, grep, find, etc.)',
        promptGuidelines: ['background:true with exit_code:null means still running, not failed. Await its notification or inspect pty_snapshot; do not relaunch it.'],
        parameters: Type.Object({
            command: Type.String({ minLength: 1, description: 'Shell command to execute' }),
            timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483, description: 'Hard timeout in seconds, including background time; no default.' })),
            tty: Type.Optional(Type.Boolean({ description: 'Interactive PTY at launch; default false. User attaches with /fg.' })),
            yield_after: Type.Optional(Type.Number({ minimum: 0, maximum: 86400, description: 'Foreground wait seconds; default /settings (15). 0 backgrounds immediately.' })),
        }),
        outputSchema: Type.Object({
            output: Type.String(), truncated: Type.Boolean(),
            full_output_path: Type.Optional(Type.String()),
            exit_code: Type.Union([Type.Number(), Type.Null()]), wall_time_seconds: Type.Number(),
            id: Type.Optional(Type.String()), background: Type.Optional(Type.Boolean()), tty: Type.Optional(Type.Boolean()),
            signal: Type.Optional(Type.Union([Type.String(), Type.Number()])),
            timed_out: Type.Optional(Type.Boolean()), output_file_truncated: Type.Optional(Type.Boolean()),
        }),
        async execute(_id: string, args: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
            signal?.throwIfAborted();
            if (typeof args.command !== 'string' || !args.command.trim()) throw new Error('A nonempty shell command is required.');
            const seconds = args.yield_after === undefined ? backgroundAfterSeconds() : validateSeconds(args.yield_after);
            if (args.timeout !== undefined && (!Number.isFinite(args.timeout) || args.timeout <= 0 || args.timeout > 2147483)) throw new Error('timeout must be positive and at most 2147483 seconds.');
            const config = shellConfig(ctx.cwd);
            const env = { ...process.env };
            for (const key of ['PI_WEB_PASSWORD', 'PI_SESSION_ID', 'PI_SESSION_FILE', 'PI_PROVIDER', 'PI_MODEL', 'PI_REASONING_LEVEL']) delete env[key];
            if (ctx.sessionManager?.getSessionId) env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
            if (ctx.sessionManager?.getSessionFile?.()) env.PI_SESSION_FILE = ctx.sessionManager.getSessionFile();
            if (ctx.model) { env.PI_PROVIDER = ctx.model.provider; env.PI_MODEL = ctx.model.id; }
            if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
            const start = Date.now();
            const session = sessions.start(args.command, ctx.cwd, false, 100, 24,
                config.shellPath, config.shellCommandPrefix, { tty: args.tty ?? false, source: 'model', timeout: args.timeout, env });
            onStart(session);
            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            let updateTimer: ReturnType<typeof setTimeout> | undefined;
            let rejectAbort: (reason?: any) => void = () => {};
            const abort = () => {
                session.cancelled = true;
                sessions.stop(session.id, 'SIGKILL');
                rejectAbort(signal?.reason ?? new Error('Command cancelled.'));
            };
            const update = () => {
                if (!onUpdate || updateTimer) return;
                updateTimer = setTimeout(() => {
                    updateTimer = undefined;
                    try { onUpdate({ content: [{ type: 'text', text: tail(cleanOutput(session.log), 8192) }], details: { id: session.id, tty: session.tty } }); } catch {}
                }, 100);
            };
            session.listeners.add(update);
            try {
                const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
                signal?.addEventListener('abort', abort, { once: true });
                if (signal?.aborted) abort();
                await Promise.race([session.done, new Promise(resolve => { waitTimer = setTimeout(resolve, seconds * 1000); }), aborted]);
                signal?.throwIfAborted();
                if (session.disposed) throw new Error('Process session disposed during command execution.');
                if (!session.running) await session.done;
                if (session.running) {
                    session.background = true;
                    session.notifyOnExit = true;
                    onBackground(session, ctx);
                }
                const raw = cleanOutput(session.log);
                const modelOutput = tail(raw.split('\n').slice(-2000).join('\n'), 50 * 1024);
                const output = tail(raw, 1024 * 1024);
                const fileTruncated = session.outputFileTruncated || !!session.logError;
                const truncated = !!session.tailTruncated || output !== raw || modelOutput !== raw || fileTruncated;
                const exitCode = session.running ? null : session.signal
                    ? 128 + (typeof session.signal === 'number' ? session.signal : constants.signals[session.signal] ?? 0)
                    : session.exitCode ?? 1;
                const managed = session.running || session.tty || !!session.signal || !!session.timedOut || fileTruncated;
                const structuredContent = {
                    output, truncated,
                    ...(truncated ? { full_output_path: session.outputPath } : {}),
                    exit_code: exitCode, wall_time_seconds: Math.round((Date.now() - start) / 100) / 10,
                    ...(managed ? { id: session.id } : {}),
                    ...(session.running ? { background: true, tty: session.tty } : session.tty ? { tty: true } : {}),
                    ...(session.signal ? { signal: session.signal } : {}),
                    ...(session.timedOut ? { timed_out: true } : {}),
                    ...(fileTruncated ? { output_file_truncated: true } : {}),
                };
                let text = modelOutput || '(no output)';
                if (truncated) text += `\n\n[Output truncated. Full output: ${session.outputPath}${fileTruncated ? ' (capture incomplete: size cap or write error)' : ''}]`;
                const status = session.running
                    ? `Process ${session.id} running in background${session.tty ? ' (TTY)' : ''}; exit will notify the agent.`
                    : session.timedOut ? `Command timed out after ${args.timeout} seconds`
                    : exitCode !== 0 ? `Command exited with code ${exitCode}` : '';
                if (status) text += `\n\n${status}`;
                return {
                    content: [{ type: 'text', text }], structuredContent,
                    details: managed || truncated ? { id: session.id, background: session.running, tty: session.tty,
                        exitCode, signal: session.signal, timedOut: !!session.timedOut, truncated,
                        ...(truncated ? { fullOutputPath: session.outputPath } : {}), outputFileTruncated: fileTruncated } : undefined,
                    ...(!session.running && (exitCode !== 0 || !!session.timedOut) ? { isError: true } : {}),
                };
            } finally {
                if (waitTimer) clearTimeout(waitTimer);
                if (updateTimer) clearTimeout(updateTimer);
                signal?.removeEventListener('abort', abort);
                session.listeners.delete(update);
            }
        },
    });
}
