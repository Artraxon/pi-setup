import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { SettingsList } from '@earendil-works/pi-tui';
import { contributeSettings } from '../shared/settings-hook.mjs';

function configPath(): string {
    return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'compact-tools.json');
}
function readConfig(): Record<string, unknown> {
    try {
        const value = JSON.parse(readFileSync(configPath(), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
        return value;
    } catch (error: any) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Cannot read compact-tools.json: ${error.message}`);
    }
}
export function loadCompactActivityEnabled(): boolean {
    const value = readConfig().activityEnabled;
    if (value === undefined) return true;
    if (typeof value !== 'boolean') throw new Error('compact-tools.json activityEnabled must be a boolean.');
    return value;
}
export function saveCompactActivityEnabled(enabled: boolean): void {
    if (typeof enabled !== 'boolean') throw new Error('Compact activity setting must be a boolean.');
    const destination = configPath();
    const config = { ...readConfig(), activityEnabled: enabled };
    mkdirSync(dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, destination);
    } finally { rmSync(temp, { force: true }); }
}

export function installCompactSettings(tui: any, theme: any, ctx: any, applyEnabled: (enabled: boolean) => void): () => void {
    return contributeSettings(tui, (list: any) => {
        if (list.items.some((item: any) => item.id === 'compact-activity')) return;
        try {
            const enabled = loadCompactActivityEnabled();
            list.items.unshift({
                id: 'compact-activity', label: 'Compact activity', currentValue: enabled ? 'On' : 'Off',
                description: 'On: live activity above the prompt. Off: inline one-line summaries.',
                submenu: (current: string, done: (value?: string) => void) => {
                    const selected = current === 'On' || current === 'Off' ? current : (enabled ? 'On' : 'Off');
                    const menu = new SettingsList([{
                        id: 'compact-activity-choice', label: 'Compact activity', currentValue: selected, values: ['On', 'Off'],
                    }], 3, {
                        label: (value: string, selected: boolean) => theme.fg(selected ? 'accent' : 'text', value),
                        value: (value: string) => theme.fg('muted', value), description: (value: string) => theme.fg('muted', value),
                        cursor: theme.fg('accent', '› '), hint: (value: string) => theme.fg('muted', value),
                    }, (_id: string, value: string) => {
                        const next = value === 'On';
                        try {
                            saveCompactActivityEnabled(next);
                            applyEnabled(next);
                            done(value);
                        } catch (error) {
                            ctx.ui.notify(`Compact activity settings: ${error instanceof Error ? error.message : String(error)}`, 'error');
                        }
                    }, () => done());
                    return menu;
                },
            });
        } catch (error) {
            ctx.ui.notify(`Compact activity settings: ${error instanceof Error ? error.message : String(error)}`, 'warning');
        }
    });
}
