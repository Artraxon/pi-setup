#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { initializeSubagent } from '../../extensions/pty-sessions/subagent-store.ts';

export function launchOptions(args) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
        model: { type: 'string', default: 'openai/gpt-6-luna' },
        thinking: { type: 'string', default: 'low' },
        tools: { type: 'string', default: 'read,bash' },
    } });
    if (positionals.length > 1) throw new Error('Pass a single shell-quoted task, optionally preceded by --model, --thinking, or --tools.');
    return { values, task: positionals[0] };
}
export function childArguments(options, sessionDirectory) {
    return ['-ne', '-ns', '-np', '-nc', '--no-mcp', '-e', fileURLToPath(new URL('./report.ts', import.meta.url)),
        '--session-dir', sessionDirectory, '--session-id', randomUUID(),
        '--tools', options.values.tools, '--model', options.values.model, '--thinking', options.values.thinking,
        ...(options.task === undefined ? [] : [options.task])];
}
export function main(args = process.argv.slice(2)) {
    const options = launchOptions(args);
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Launch with managed bash tty:true, yield_after:0; a normal interactive TUI is required.');
    if (process.env.PI_PROCESS_PRIVATE === '1') throw new Error('Result-producing subagents require a public process; private !! jobs must not be persisted.');
    const directory = process.env.PI_PROCESS_DATA_DIR, id = process.env.PI_PROCESS_ID;
    if (!directory || !id || !process.env.PI_PROCESS_TOKEN || !process.env.PI_PROCESS_SOCKET) {
        throw new Error('Managed-process result support is missing. Reload the parent Pi before launching a subagent.');
    }
    const sessionDirectory = initializeSubagent(directory, id);
    const child = spawn('pi', childArguments(options, sessionDirectory), {
        stdio: 'inherit', env: { ...process.env, PI_SUBAGENT_DIR: directory },
    });
    child.once('error', error => { console.error(`Subagent launch failed: ${error.message}`); process.exitCode = 1; });
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
}
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
