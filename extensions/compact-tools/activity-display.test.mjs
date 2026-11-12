import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const tuiUrl = pathToFileURL(require.resolve('@earendil-works/pi-tui')).href;
const themeUrl = pathToFileURL(resolve(dirname(executable), '../modes/interactive/theme/theme.js')).href;
// Relocate only the runtime asset's imports; execute its real implementation
// using Pi's actual Markdown renderer, theme and terminal-width utilities.
const temporary = mkdtempSync(join(tmpdir(), 'pi-activity-component-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const source = readFileSync(new URL('./activity-display.js', import.meta.url), 'utf8')
    .replace('"@earendil-works/pi-tui"', JSON.stringify(tuiUrl))
    .replace('"../theme/theme.js"', JSON.stringify(themeUrl));
const modulePath = join(temporary, 'activity.mjs');
writeFileSync(modulePath, source);
const { ActivityContainer, ActivityDisplay } = await import(pathToFileURL(modulePath).href);
const { initTheme, getMarkdownTheme } = await import(themeUrl);
const { stripTerminalSequences, visibleWidth } = await import(tuiUrl);
initTheme('dark');
const plain = line => stripTerminalSequences(line);

function fakeClock() {
    let now = 0, nextId = 0;
    const timers = new Map();
    return {
        now: () => now,
        set(callback, delay) { const id = ++nextId; timers.set(id, { at: now + delay, callback }); return id; },
        clear(id) { timers.delete(id); },
        get pending() { return timers.size; },
        advance(milliseconds) {
            const target = now + milliseconds;
            for (;;) {
                const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > target) break;
                timers.delete(next[0]);
                now = next[1].at;
                next[1].callback();
            }
            now = target;
        },
    };
}

test('visible compact activity always has one bottom spacer and renders children once', () => {
    let compact = true, renders = 0;
    const clock = fakeClock();
    const group = new ActivityContainer(() => compact, () => {}, clock);
    group.addChild({ render() { renders++; return [' activity']; }, invalidate() {} });
    assert.deepEqual(group.render(80), [' activity', '']);
    assert.deepEqual(group.render(80), [' activity', ''], 'spacing is stable between renders');
    assert.equal(renders, 1, 'cached frames must not render children again');
    clock.advance(500);
    assert.deepEqual(group.render(80), [' activity', '']);
    assert.equal(renders, 2, 'render each child once per snapshot');
    compact = false;
    assert.deepEqual(group.render(80), [' activity'], 'other display modes retain native widget spacing');
    group.clear();
    compact = true;
    assert.deepEqual(group.render(80), []);
    group.addChild({ render: () => [''], invalidate() {} });
    assert.deepEqual(group.render(80), [''], 'an empty activity area must not gain another blank row');
});

test('automatic changes are coalesced at 500ms with a trailing refresh and quiet-process heartbeat', () => {
    const clock = fakeClock();
    let value = ' first', refreshes = 0;
    const group = new ActivityContainer(() => true, () => refreshes++, clock);
    group.addChild({ render: () => value ? [value] : [], invalidate() {} });
    assert.deepEqual(group.render(80), [' first', '']);
    value = ' latest';
    for (let i = 0; i < 4; i++) {
        clock.advance(100);
        assert.deepEqual(group.render(80), [' first', '']);
        assert.equal(clock.pending, 1);
    }
    clock.advance(99);
    assert.equal(refreshes, 0);
    assert.deepEqual(group.render(80), [' first', '']);
    clock.advance(1);
    assert.equal(refreshes, 1);
    assert.deepEqual(group.render(80), [' latest', '']);
    clock.advance(500);
    assert.equal(refreshes, 2, 'elapsed time still updates without any process output');
    value = '';
    assert.deepEqual(group.render(80), []);
    assert.equal(clock.pending, 0);
});

test('short-lived activity between snapshots never flashes into the list', () => {
    const clock = fakeClock();
    let value = '';
    const group = new ActivityContainer(() => true, () => {}, clock);
    group.addChild({ render: () => value ? [value] : [], invalidate() {} });
    assert.deepEqual(group.render(80), []);
    clock.advance(100);
    value = ' blink';
    assert.deepEqual(group.render(80), []);
    clock.advance(100);
    value = '';
    assert.deepEqual(group.render(80), []);
    clock.advance(300);
    assert.deepEqual(group.render(80), []);
    assert.equal(clock.pending, 0);
});

test('user interactions, resizing and view changes bypass batching; clearing cancels timers', () => {
    const clock = fakeClock();
    let compact = true, revision = 0, value = ' collapsed';
    const group = new ActivityContainer(() => compact, () => {}, clock);
    group.addChild({ render: () => [value], invalidate() {}, getActivityRevision: () => revision });
    assert.deepEqual(group.render(80), [' collapsed', '']);
    clock.advance(1);
    value = ' expanded';
    revision++;
    assert.deepEqual(group.render(80), [' expanded', '']);
    value = ' resized';
    assert.deepEqual(group.render(40), [' resized', '']);
    compact = false;
    value = ' inline';
    assert.deepEqual(group.render(40), [' inline']);
    assert.equal(clock.pending, 0);
    compact = true;
    assert.deepEqual(group.render(40), [' inline', '']);
    group.clear();
    assert.equal(clock.pending, 0);
    assert.deepEqual(group.render(40), []);
    group.dispose();
});

test('reasoning uses the real Markdown renderer rather than displaying markup literally', () => {
    const bold = [];
    const display = new ActivityDisplay(() => 1, () => ({ ...getMarkdownTheme(), bold(text) {
        bold.push(plain(text));
        return `\x1b[1m${text}\x1b[22m`;
    } }));
    display.setReasoning('**Considering layout** and `padding`');
    const rows = display.render(100);
    assert.equal(rows.length, 1);
    assert.equal(plain(rows[0]), ' Considering layout and padding');
    assert.ok(bold.includes('Considering layout'));
    assert.match(rows[0], /\x1b\[1m/);
    assert.ok(!plain(rows[0]).includes('**') && !plain(rows[0]).includes('`'));
});

test('reasoning and tools use live normal-output padding without extra row markers', () => {
    let padding = 3;
    const display = new ActivityDisplay(() => padding);
    display.setReasoning('Aligned reasoning');
    assert.equal(plain(display.render(80)[0]), '   Aligned reasoning');
    padding = 0;
    assert.equal(plain(display.render(80)[0]), 'Aligned reasoning');
    padding = 1;
    display.setTool('alpha', 'read first.ts');
    display.setTool('beta', 'bash run-tests');
    assert.deepEqual(display.render(80).map(plain), [' read first.ts', ' bash run-tests']);
    display.removeTool('alpha');
    assert.deepEqual(display.render(80).map(plain), [' bash run-tests']);
    display.clear();
    assert.deepEqual(display.render(80), []);
});

test('styled Unicode reasoning remains one safe width-bounded line on resize', () => {
    const display = new ActivityDisplay(() => 1);
    display.setReasoning(`\x1b]0;bad-title\x07**界🙂 heading** ${'界🙂'.repeat(80)}`);
    for (const width of [1, 8, 40, 100]) {
        const rows = display.render(width);
        assert.equal(rows.length, 1);
        assert.ok(visibleWidth(rows[0]) <= width);
        assert.ok(!plain(rows[0]).includes('bad-title'));
        assert.ok(!/[\x00-\x1f\x7f]/.test(plain(rows[0])));
    }
});

test('latest paragraph replaces old reasoning; hidden and settled activity is empty', () => {
    const display = new ActivityDisplay();
    display.setReasoning('Old paragraph\n\n**Latest paragraph**');
    assert.deepEqual(display.render(80).map(plain), [' Latest paragraph']);
    display.setActive(false);
    assert.deepEqual(display.render(80), []);
    display.setActive(true);
    display.clear();
    assert.deepEqual(display.render(80), []);
});
