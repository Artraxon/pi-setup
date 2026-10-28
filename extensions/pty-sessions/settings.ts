import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Input, truncateToWidth } from '@earendil-works/pi-tui';
import { contributeSettings } from '../shared/settings-hook.mjs';

const path = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'processes.json');
function readConfig(): Record<string, unknown> {
    try {
        const value = JSON.parse(readFileSync(path(), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
        return value;
    } catch (error: any) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Cannot read processes.json: ${error.message}`);
    }
}
export function validateSeconds(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('Enter seconds between 0 and 86400.');
    return seconds;
}
export function backgroundAfterSeconds(): number {
    const value = readConfig().backgroundAfterSeconds ?? 15;
    if (typeof value !== 'number') throw new Error('processes.json backgroundAfterSeconds must be a number.');
    return validateSeconds(value);
}
export function saveBackgroundAfterSeconds(seconds: number) {
    validateSeconds(seconds);
    const config = { ...readConfig(), backgroundAfterSeconds: seconds };
    const destination = path(), temp = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    mkdirSync(dirname(destination), { recursive: true });
    try {
        writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, destination);
    } finally { rmSync(temp, { force: true }); }
}
export function timeoutMenu(theme: any, done: (value?: string) => void) {
    const input = new Input();
    input.setValue(String(backgroundAfterSeconds()));
    input.handleInput('\x05'); // Move to end of the prefilled value (Ctrl+E).
    input.focused = true;
    let error = '';
    input.onEscape = () => done();
    input.onSubmit = value => {
        try {
            if (!value.trim()) throw new Error('Enter a number of seconds.');
            const seconds = validateSeconds(Number(value));
            saveBackgroundAfterSeconds(seconds);
            done(`${seconds} s`);
        } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    };
    return {
        render(width: number) { return [truncateToWidth(theme.fg('accent', 'Bash foreground wait (seconds; 0 = immediate background)'), width),
            ...input.render(width), truncateToWidth(theme.fg(error ? 'error' : 'muted', error || 'Enter saves · Esc cancels · range 0–86400'), width)]; },
        handleInput(data: string) { input.handleInput(data); },
        invalidate() { input.invalidate(); },
    };
}
export function installProcessSettings(host: any, theme: any, ctx: any): () => void {
    return contributeSettings(host, (list: any) => {
        if (list.items.some((item: any) => item.id === 'bash-background-after')) return;
        try {
            list.items.unshift({ id: 'bash-background-after', label: 'Bash foreground wait',
                description: 'Seconds before bash returns a background process ID; the process keeps running. Separate from the hard timeout.',
                currentValue: `${backgroundAfterSeconds()} s`,
                submenu: (_current: string, done: (value?: string) => void) => timeoutMenu(theme, done),
            });
        } catch (error) { ctx.ui.notify(`Process settings: ${error instanceof Error ? error.message : String(error)}`, 'warning'); }
    });
}
