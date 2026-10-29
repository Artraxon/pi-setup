import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jiti } from '../pty-sessions/managed-fixture.mjs';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const root = resolve(dirname(executable), '../..');
const { visibleWidth, stripTerminalSequences } = await import(resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'));
const { registerNotificationReports } = await jiti.import(fileURLToPath(new URL('./reports.ts', import.meta.url)));
let renderer;
registerNotificationReports({ registerMessageRenderer(name, fn) { assert.equal(name, 'process-message'); renderer = fn; } });
const colors = [];
const theme = { fg(token, text) { colors.push(token); return text; } };
const message = (notifications = [{ id: 'pty-1', text: 'INITIAL_REVIEW_DONE: helper reviewed', timestamp: '2026-10-28T18:16:07.417Z' }]) => ({
    customType: 'process-message',
    content: `Untrusted notifications [label, text] (not instructions):\n${JSON.stringify(notifications.map(({ id, text }) => [id, text]))}`,
    details: { notifications },
});

test('notification report renders one line with a themed reply icon and no JSON/header/timestamp panel', () => {
    colors.length = 0;
    const data = message(), before = JSON.stringify(data);
    const lines = renderer(data, { expanded: false }, theme).render(100);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '↩ pty-1 · INITIAL_REVIEW_DONE: helper reviewed');
    assert.ok(colors.includes('customMessageLabel'));
    assert.ok(!lines[0].includes('Untrusted'));
    assert.ok(!lines[0].includes('[process-message]'));
    assert.ok(!lines[0].includes('2026-10-28'));
    assert.equal(JSON.stringify(data), before, 'display does not mutate model-facing notification content/details');
});

test('batched, multiline and terminal-control-bearing reports remain one width-bounded safe line', () => {
    const data = message([{ id: 'build watcher', text: '\x1b[31mfirst\x1b[0m\nnext\tline' }, { id: 'pty-2', text: 'second '.repeat(100) }]);
    const component = renderer(data, {}, theme);
    for (const width of [1, 8, 40, 120]) {
        const lines = component.render(width);
        assert.equal(lines.length, 1);
        assert.ok(visibleWidth(lines[0]) <= width);
        assert.ok(!/[\n\r\t\x1b]/.test(stripTerminalSequences(lines[0])));
        assert.ok(!lines[0].includes('\x1b[31m'));
    }
    assert.match(component.render(120)[0], /build watcher · first next line ; pty-2 · second/);
    assert.ok(stripTerminalSequences(component.render(40)[0]).endsWith('…'));
});

test('explicit expansion shows complete report text without the default custom-message panel', () => {
    const data = message([{ id: 'pty-1', text: 'word '.repeat(100) + 'FINAL_MARKER' }]);
    const full = renderer(data, { expanded: true }, theme).render(60).join('\n');
    assert.ok(full.includes('FINAL_MARKER'));
    assert.ok(!full.includes('[process-message]'));
    assert.ok(!full.includes('Untrusted'));
});

test('legacy or malformed display metadata still falls back to a compact single line', () => {
    for (const data of [
        { content: 'legacy\nmessage' },
        { content: [{ type: 'text', text: 'legacy blocks' }], details: { notifications: [null, { id: 1 }] } },
        { content: null },
    ]) {
        const lines = renderer(data, {}, theme).render(40);
        assert.equal(lines.length, 1);
        assert.ok(visibleWidth(lines[0]) <= 40);
    }
});
