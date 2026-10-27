import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { installLinkNavigation } = await jiti.import(fileURLToPath(new URL('./link-navigation.ts', import.meta.url)));
const osc = (url, label = url) => `\x1b]8;;${url}\x07${label}\x1b]8;;\x07`;

function setup(t) {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-clion-nav-'));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    writeFileSync(join(cwd, 'a.ts'), 'a'); writeFileSync(join(cwd, 'b.ts'), 'b');
    const original = () => [osc('a.ts:2'), osc('https://example.com', 'website'), osc('b.ts')];
    const component = { lastMessage: { role: 'assistant' }, render: original };
    const scroll = { scrollBy(delta) { this.delta = delta; } };
    let listener, status, focus = { getText() {}, setText() {} };
    const host = { getFocusedComponent: () => focus, hasOverlay: () => false, requestRender() {},
        getPrimaryScrollView: () => scroll,
        currentLayout: { root: { component: {}, scrollView: scroll, rect: { y: 0, height: 2, width: 80 },
            children: [{ component, rect: { y: -4, width: 80, height: 3 }, children: [] }] } } };
    const opened = [];
    const cleanup = installLinkNavigation(host, {}, { cwd, ui: {
        onTerminalInput(fn) { listener = fn; return () => { listener = undefined; }; },
        setStatus(_key, value) { status = value; }, notify() {},
    } }, ref => opened.push(ref));
    t.after(cleanup);
    return { host, component, original, scroll, opened, input: data => listener(data),
        status: () => status, focus: value => focus = value };
}

test('Alt+K/J navigate file links, ignore web links, preserve URLs and open only on Enter', t => {
    const s = setup(t);
    assert.deepEqual(s.input('\x1bk'), { consume: true });
    assert.match(s.status(), /b.ts/);
    assert.ok(s.component.render(80)[2].includes('\x1b]8;;b.ts\x07\x1b[7mb.ts'));
    s.input('\x1bk');
    assert.match(s.status(), /a.ts:2/);
    assert.equal(s.scroll.delta, -4);
    s.input('\x1bj');
    assert.match(s.status(), /b.ts/);
    assert.equal(s.opened.length, 0);
    assert.deepEqual(s.input('\r'), { consume: true });
    assert.equal(s.opened[0].file, 'b.ts');
    assert.equal(s.component.render, s.original);
});

test('Escape preserves prompt; ownership handoff clears the other selection mode', t => {
    const s = setup(t);
    let cancelled = 0;
    s.host[Symbol.for('pi.transcript-selection.cancel')] = () => cancelled++;
    s.input('\x1bk');
    assert.equal(cancelled, 1);
    s.input('\x1b');
    assert.equal(s.opened.length, 0);
    assert.equal(s.component.render, s.original);
    s.focus({ render() {} });
    assert.equal(s.input('\x1bk'), undefined);
});
