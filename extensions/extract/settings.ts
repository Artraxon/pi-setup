import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SettingsList } from '@earendil-works/pi-tui';
import { DEFAULT_MODEL } from './core.ts';

function configPath(): string {
    return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'extract.json');
}
function readConfig(): Record<string, unknown> {
    try {
        const value = JSON.parse(readFileSync(configPath(), 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
        return value;
    } catch (error: any) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Cannot read extract.json: ${error.message}`);
    }
}
export function extractionModelSpec(): string {
    const configured = readConfig().model;
    if (configured !== undefined && (typeof configured !== 'string' || !configured.trim())) throw new Error('extract.json model must be a nonempty provider/model-id.');
    return configured as string || process.env.PI_EXTRACT_MODEL || DEFAULT_MODEL;
}
export function saveExtractionModel(spec: string) {
    if (!/^[^/]+\/.+/.test(spec)) throw new Error('Expected provider/model-id.');
    const config = { ...readConfig(), model: spec };
    const path = configPath(), directory = join(path, '..');
    mkdirSync(directory, { recursive: true });
    const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        writeFileSync(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
}

export function modelMenu(ctx: any, theme: any, current: string, done: (value?: string) => void) {
    const models = ctx.modelRegistry.getAvailable().slice().sort((a: any, b: any) =>
        (a.cost?.input ?? Infinity) - (b.cost?.input ?? Infinity) || a.id.localeCompare(b.id));
    const items = models.map((model: any) => {
        const spec = `${model.provider}/${model.id}`;
        const cost = model.cost;
        const price = typeof cost?.input === 'number' && typeof cost?.output === 'number'
            ? `$${cost.input} input / $${cost.output} output per 1M tokens` : 'Pricing unavailable';
        return { id: spec, label: `${model.id} [${model.provider}]`,
            description: `${price} · ${model.contextWindow?.toLocaleString() ?? '?'} context tokens`,
            currentValue: spec === current ? 'selected' : '', values: ['use'] };
    });
    const list = new SettingsList(items, 10, {
        label: (value, selected) => theme.fg(selected ? 'accent' : 'text', value),
        value: value => theme.fg('muted', value), description: value => theme.fg('muted', value),
        cursor: theme.fg('accent', '› '), hint: value => theme.fg('muted', value),
    }, spec => {
        try { saveExtractionModel(spec); done(spec); }
        catch (error) { ctx.ui.notify(`Extraction settings: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
    }, () => done(), { enableSearch: true });
    list.selectItem(current);
    return list;
}

/** Pi 1.3 has no public settings-contribution API. Hook only its main settings
 * list (identified by stable built-in item IDs), not arbitrary extension lists.
 * No runtime files or prototypes are patched, and shutdown restores the hook.
 */
export function installSettingsRow(host: any, theme: any, ctx: any): () => void {
    const previous = host.setFocus;
    if (typeof previous !== 'function') return () => {};
    function focus(this: any, component: any, ...args: any[]) {
        const list = component;
        if (Array.isArray(list?.items) && list.items.some((item: any) => item.id === 'theme') &&
            list.items.some((item: any) => item.id === 'tui-mode') && !list.items.some((item: any) => item.id === 'extract-model')) {
            try {
                list.items.unshift({ id: 'extract-model', label: 'Extraction model',
                    description: 'Separate model for /extract; does not change the main conversation model',
                    currentValue: extractionModelSpec(),
                    submenu: (current: string, done: (value?: string) => void) => modelMenu(ctx, theme, current, done),
                });
                if (typeof list.applyFilter === 'function') list.applyFilter(list.searchInput?.getValue() || '');
                else if (Array.isArray(list.filteredItems) && list.filteredItems !== list.items) list.filteredItems = [...list.items];
            } catch (error) {
                ctx.ui.notify(`Extraction settings: ${error instanceof Error ? error.message : String(error)}. The /settings integration may need updating for this Pi version.`, 'warning');
            }
        }
        return previous.call(this, component, ...args);
    }
    host.setFocus = focus;
    return () => { if (host.setFocus === focus) host.setFocus = previous; };
}
