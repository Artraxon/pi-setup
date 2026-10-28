import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { extractionModelSpec, saveExtractionModel, installSettingsRow } = await jiti.import(fileURLToPath(new URL('./settings.ts', import.meta.url)));
function setup(t) {
    const directory = mkdtempSync(join(tmpdir(), 'extract-settings-'));
    const previous = process.env.PI_CODING_AGENT_DIR, model = process.env.PI_EXTRACT_MODEL;
    process.env.PI_CODING_AGENT_DIR = directory;
    delete process.env.PI_EXTRACT_MODEL;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        if (model === undefined) delete process.env.PI_EXTRACT_MODEL; else process.env.PI_EXTRACT_MODEL = model;
        rmSync(directory, { recursive: true, force: true });
    });
    return directory;
}

test('saved model overrides environment/default and persists independently of chat settings', t => {
    const directory = setup(t);
    assert.equal(extractionModelSpec(), 'openai/gpt-6.1-terra');
    process.env.PI_EXTRACT_MODEL = 'other/environment';
    assert.equal(extractionModelSpec(), 'other/environment');
    saveExtractionModel('openai/selected');
    assert.equal(extractionModelSpec(), 'openai/selected');
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'extract.json'))), { model: 'openai/selected' });
});

test('native /settings gets a model row, picker persists selection, and hook cleanup restores focus', t => {
    setup(t);
    let focused;
    const original = function(component) { focused = component; };
    const host = { setFocus: original };
    const theme = { fg: (_color, text) => text };
    const ctx = { modelRegistry: { getAvailable: () => [
        { provider: 'openai', id: 'gpt-6.1-terra', contextWindow: 272000, cost: { input: 1, output: 5 } },
        { provider: 'openai', id: 'cheaper', contextWindow: 100000, cost: { input: 0.1, output: 0.5 } },
    ] }, ui: { notify(message) { throw new Error(message); } } };
    const cleanup = installSettingsRow(host, theme, ctx);
    const other = { items: [{ id: 'other' }] };
    host.setFocus(other);
    assert.equal(other.items.length, 1);
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }], filteredItems: [], applyFilter() { this.filteredItems = this.items; } };
    host.setFocus(list);
    assert.equal(focused, list);
    assert.equal(list.items[0].id, 'extract-model');
    host.setFocus(list);
    assert.equal(list.items.filter(item => item.id === 'extract-model').length, 1);
    let chosen;
    const menu = list.items[0].submenu(list.items[0].currentValue, value => chosen = value);
    menu.selectItem('openai/cheaper');
    menu.handleInput('\r');
    assert.equal(chosen, 'openai/cheaper');
    assert.equal(extractionModelSpec(), 'openai/cheaper');
    cleanup();
    assert.equal(host.setFocus, original);
});
