import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const { createInteractiveTuiReference } = await import(resolve(root, 'dist/modes/interactive/tui-renderer.js'));
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const extension = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));

class UserMessageComponent { text = 'user message'; render() { return [`\x1b[48;2;20;20;20m${this.text}\x1b[0m`]; } }
const assistant = () => ({ lastMessage: { role: 'assistant', content: [{ type: 'text', text: '**whole response**' }] }, render: () => ['response'] });
const tool = () => ({ toolCallId: 'call', toolName: 'bash', result: { content: [{ type: 'text', text: 'first\nsecond\nthird' }] }, render: () => ['collapsed summary'] });

function setup(previous) {
    const events = new Map(), shortcuts = [];
    let input, prompt = 'draft', focus = { getText() {}, setText() {} }, overlay = false;
    const blocks = previous?.blocks ?? [new UserMessageComponent(), assistant(), tool()];
    const original = previous?.original ?? blocks.map(block => block.render);
    const content = { mouseLayout: { width: 80, children: blocks.map(component => ({ component, height: 1 })) } };
    const scroll = previous?.scroll ?? { scrollBy(delta) { this.delta = delta; } };
    const target = { requestRender() {}, getFocusedComponent: () => focus, hasOverlay: () => overlay,
        getPrimaryScrollView: () => scroll,
        currentLayout: { root: { rect: { x: 0, y: 0, width: 80, height: 2 }, scrollView: scroll,
            component: {}, children: [{ rect: { x: 0, y: -2, width: 80, height: 3 }, component: content, children: [] }] } } };
    const host = previous?.host ?? createInteractiveTuiReference(() => target);
    let stale = false;
    const ui = {
        setWidget(_key, factory) { factory(host, { fg: (_token, value) => value, bg: (_token, value) => `selected:${value}`, getBgAnsi: () => '\x1b[44m' }); },
        onTerminalInput(handler) { input = handler; return () => { if (input === handler) input = undefined; }; },
        setStatus() {}, setEditorText(value) { prompt = value; },
    };
    const ctx = { mode: 'tui', get ui() {
        if (stale) throw new Error('This extension ctx is stale after session replacement or reload.');
        return ui;
    } };
    extension.default({ on(name, fn) { events.set(name, fn); }, registerShortcut(key) { shortcuts.push(key); } });
    events.get('session_start')({}, ctx);
    return { input: data => input?.(data), listener: () => input, host, blocks, original, scroll, shortcuts,
        invalidate: () => { stale = true; },
        prompt: () => prompt, focus: value => focus = value, overlay: value => overlay = value,
        close: () => events.get('session_shutdown')({}, ctx) };
}

test('Ctrl+K/J navigate actual blocks, Enter copies full tool output without submitting', () => {
    const s = setup();
    try {
        assert.deepEqual(s.shortcuts, []); // One input path only; no duplicate shortcut handler.
        assert.deepEqual(s.input('\x0b'), { consume: true });
        assert.equal(s.blocks[2].render(80)[0], '▎ selected:collapsed summary');
        s.input('\x1b[107;5:3u'); // Kitty key release must not move selection.
        assert.equal(s.blocks[2].render(80)[0], '▎ selected:collapsed summary');
        s.input('\x0b');
        assert.equal(s.blocks[1].render(80)[0], '▎ selected:response');
        assert.equal(s.blocks[2].render, s.original[2]);
        s.input('\x0a');
        assert.deepEqual(s.input('\r'), { consume: true });
        assert.equal(s.prompt(), 'first\nsecond\nthird');
        assert.equal(s.blocks[2].render, s.original[2]);
        assert.equal(s.input('\r'), undefined); // Normal Enter behavior restored.
    } finally { s.close(); }
});

test('selection overrides sent-prompt backgrounds and restores original rendering', () => {
    const s = setup();
    try {
        s.input('\x0b'); s.input('\x0b'); s.input('\x0b');
        const line = s.blocks[0].render(80)[0];
        assert.ok(line.startsWith('▎ '));
        assert.ok(line.includes('\x1b[48;2;20;20;20m\x1b[44muser message'));
        s.input('\x1b');
        assert.equal(s.blocks[0].render, s.original[0]);
    } finally { s.close(); }
});

test('Escape preserves draft, ordinary typing exits selection, dialogs retain keys', () => {
    const s = setup();
    try {
        s.input('\x0b'); s.input('\x1b');
        assert.equal(s.prompt(), 'draft');
        assert.equal(s.blocks[2].render, s.original[2]);
        s.input('\x0b'); assert.equal(s.input('a'), undefined);
        assert.equal(s.blocks[2].render, s.original[2]);
        s.focus({ render() {} }); assert.equal(s.input('\x0b'), undefined);
        s.focus({ getText() {}, setText() {} }); s.overlay(true);
        assert.equal(s.input('\x0a'), undefined);
    } finally { s.close(); }
});

test('reload releases the real TUI-proxy owner and makes retained callbacks/input harmless', () => {
    const ownerKey = Symbol.for('pi.transcript-selection.cancel');
    const old = setup();
    old.input('\x0b');
    const lateCancel = old.host[ownerKey], lateInput = old.listener();
    old.close();
    assert.equal(old.blocks[2].render, old.original[2]);
    old.invalidate();
    assert.doesNotThrow(() => lateCancel());
    assert.equal(old.host[ownerKey], undefined, 'clear the underlying TUI, not the empty proxy target');
    assert.equal(lateInput('\x0b'), undefined);
    const current = setup(old);
    try {
        assert.deepEqual(current.input('\x0b'), { consume: true });
        current.input('\r');
        assert.equal(current.prompt(), 'first\nsecond\nthird');
    } finally { current.close(); current.invalidate(); }
    assert.doesNotThrow(() => current.close(), 'shutdown is idempotent even after context invalidation');
});

test('Ctrl+K recovers a stale legacy owner left by an older extension version', () => {
    const s = setup();
    try {
        s.host[Symbol.for('pi.transcript-selection.cancel')] = () => {
            throw new Error('This extension ctx is stale after session replacement or reload.');
        };
        assert.deepEqual(s.input('\x0b'), { consume: true });
        s.input('\r');
        assert.equal(s.prompt(), 'first\nsecond\nthird');
    } finally { s.close(); }
});

test('scrolls an offscreen block into view and copies raw assistant Markdown', () => {
    const s = setup();
    try {
        s.input('\x0b'); s.input('\x0b');
        assert.equal(s.scroll.delta, -1);
        s.input('\r');
        assert.equal(s.prompt(), '**whole response**');
    } finally { s.close(); }
});
