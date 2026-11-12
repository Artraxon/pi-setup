import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const root = resolve(dirname(executable), '../..');
const require = createRequire(executable);
const { createJiti } = require('jiti');
const base = resolve(root, 'node_modules/@earendil-works/pi-tui/dist');
const tui = await import(resolve(base, 'index.js'));
const { createInteractiveTuiReference } = await import(resolve(root, 'dist/modes/interactive/tui-renderer.js'));
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-tui': resolve(base, 'index.js') } });
const { default: extension, insetTranscript, isKittySsh, GUTTER_COLUMNS } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
const tick = () => new Promise(resolve => queueMicrotask(resolve));

function setup(columns = 80, rows = 24) {
    tui.setCapabilities({ images: null, trueColor: true, hyperlinks: true });
    let input, resize;
    const terminal = { columns, rows,
        start(fn, onResize) { input = fn; resize = onResize; }, stop() {}, write() {},
        hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {},
        clearScreen() {}, setTitle() {}, setProgress() {}, setWorking() {}, setCursorPosition() {}, drainInput: async () => {},
    };
    const host = new tui.TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
    const scroll = new tui.ScrollView(new tui.Text(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'), 0, 0),
        { primary: true, follow: 'end', scrollbar: 'always' });
    const widths = [];
    const dock = { render(width) { widths.push(width); return ['draft'.slice(0, width), 'footer'.slice(0, width)]; }, invalidate() {} };
    const layout = new tui.VStack([
        { component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        { component: dock, basis: 'auto', grow: 0, shrink: 0 },
    ]);
    host.setLayoutRoot(layout);
    host.start(); host.renderNow();
    function box() {
        let found;
        const visit = node => { if (node.scrollView === scroll) found = node; for (const child of node.children ?? []) visit(child); };
        visit(host.currentLayout.root);
        return found;
    }
    return { host, layout, scroll, dock, widths, box,
        input(data) { input(data); host.renderNow(); },
        resize(columns, rows = terminal.rows) { terminal.columns = columns; terminal.rows = rows; resize(); host.renderNow(); },
        close() { host.stop(); },
    };
}

function inSsh(fn) {
    const keys = ['TERM', 'TERM_PROGRAM', 'KITTY_WINDOW_ID', 'KITTY_PID', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'KITTY_SSH_KITTEN_DATA_DIR'];
    const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.TERM = 'xterm-kitty'; process.env.SSH_TTY = '/dev/pts/test';
    const restore = () => { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; };
    return Promise.resolve().then(fn).finally(restore);
}

function bridge(reference, mode = 'tui') {
    const events = new Map(); let widget; let calls = 0;
    extension({ on(name, fn) { events.set(name, fn); } });
    const ctx = { mode, ui: { setWidget(_name, factory) { calls++; widget = factory(reference); } } };
    return { start() { events.get('session_start')({}, ctx); }, stop() { events.get('session_shutdown')(); },
        widget: () => widget, calls: () => calls };
}

test('detects Kitty SSH but not local Kitty, a local agent socket, or other terminals', () => {
    for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'KITTY_SSH_KITTEN_DATA_DIR']) {
        assert.equal(isKittySsh({ TERM: 'xterm-kitty', [key]: 'present' }), true, key);
        assert.equal(isKittySsh({ TERM: 'xterm-256color', [key]: 'present' }), false, key);
    }
    assert.equal(isKittySsh({ KITTY_WINDOW_ID: '1', SSH_TTY: '/dev/pts/1' }), true);
    assert.equal(isKittySsh({ TERM_PROGRAM: 'kitty', SSH_CLIENT: 'host' }), true);
    assert.equal(isKittySsh({ TERM: 'xterm-kitty', KITTY_PID: '42' }), false);
    assert.equal(isKittySsh({ TERM: 'xterm-kitty', SSH_AUTH_SOCK: '/tmp/agent' }), false);
});

test('detects the stripped devcontainer environment using remote helper PATH, without classifying a local Kitty child as SSH', () => {
    const PATH = '/usr/bin:/root/.local/share/kitty-ssh-kitten/kitty/bin';
    assert.equal(isKittySsh({ TERM: 'xterm-kitty', PATH }), true);
    assert.equal(isKittySsh({ TERM: 'xterm-kitty', KITTY_PID: '42', PATH }), false);
    assert.equal(isKittySsh({ TERM: 'xterm', PATH }), false);
    assert.equal(isKittySsh({ TERM: 'xterm-kitty', PATH: '/tmp/not-kitty-ssh-kitten/kitty/bin' }), false);
});

test('moves only the transcript scrollbar inward; real SGR track clicks and dragging scroll at the new column', () => {
    const s = setup();
    const restore = insetTranscript(s.layout);
    try {
        assert.equal(typeof restore, 'function'); s.host.renderNow();
        assert.equal(s.box().rect.width, 80 - GUTTER_COLUMNS);
        assert.equal(s.layout.entries[1].component, s.dock);
        assert.equal(s.widths.at(-1), 80, 'editor/footer remain full width');
        const column = s.box().rect.width;
        const initial = s.scroll.scrollTop;
        s.input(`\x1b[<0;${column};10M`);
        assert.ok(s.host.scrollbarDrag, 'press captures the scrollbar, not text');
        s.input(`\x1b[<32;${column};3M`);
        assert.ok(s.scroll.scrollTop < initial);
        s.input(`\x1b[<0;${column};3m`);
        assert.equal(s.host.scrollbarDrag, undefined);
        restore(); restore(); s.host.renderNow();
        assert.equal(s.box().rect.width, 80);
        assert.equal(s.layout.entries[0].component, s.scroll);
        assert.equal(s.layout.children[0], s.scroll);
    } finally { restore?.(); s.close(); }
});

test('gutter follows resize and shrinks safely in tiny terminals', () => {
    const s = setup(); const restore = insetTranscript(s.layout);
    try {
        s.resize(120); assert.equal(s.box().rect.width, 119); assert.equal(s.widths.at(-1), 120);
        s.resize(2); assert.equal(s.box().rect.width, 1);
        s.resize(80); assert.equal(s.box().rect.width, 79);
    } finally { restore?.(); s.close(); }
});

test('cleanup preserves another extension replacement and unsupported layouts are harmless', () => {
    assert.equal(insetTranscript({ render: () => [], invalidate() {} }), undefined);
    assert.equal(insetTranscript({ entries: {}, children: {} }), undefined);
    const s = setup(); const restore = insetTranscript(s.layout);
    try {
        const other = { render: () => [], invalidate() {} };
        s.layout.entries[0].component = other; s.layout.children[0] = other;
        restore(); assert.equal(s.layout.entries[0].component, other); assert.equal(s.layout.children[0], other);
    } finally { s.close(); }
});

test('bridge is idempotent, reload-safe and ignores queued/stale callbacks after shutdown', () => inSsh(async () => {
    const s = setup(); let active = s.host;
    const reference = createInteractiveTuiReference(() => { if (!active) throw new Error('stale'); return active; });
    const b = bridge(reference);
    try {
        b.start(); s.host.renderNow(); assert.equal(s.box().rect.width, 79);
        const old = b.widget(); old.render(); old.render(); await tick(); s.host.renderNow();
        assert.equal(s.box().rect.width, 79);
        b.start(); s.host.renderNow(); assert.equal(s.box().rect.width, 79, 'does not stack gutters');
        old.render();
        b.stop(); s.host.renderNow(); assert.equal(s.box().rect.width, 80);
        active = undefined;
        assert.deepEqual(old.render(), []); assert.deepEqual(b.widget().render(), []);
        await tick();
    } finally { active = s.host; b.stop(); s.close(); }
}));

test('bridge supports regular/fullscreen switches through a real stable TUI reference', () => inSsh(async () => {
    const s = setup(); const regular = { requestRender() {} }; let active = regular;
    const b = bridge(createInteractiveTuiReference(() => active));
    try {
        b.start(); assert.equal(s.box().rect.width, 80);
        active = s.host; b.widget().render(); await tick(); s.host.renderNow(); assert.equal(s.box().rect.width, 79);
        active = regular; b.widget().render(); await tick(); s.host.renderNow(); assert.equal(s.box().rect.width, 80);
        active = s.host; b.widget().render(); await tick(); s.host.renderNow(); assert.equal(s.box().rect.width, 79);
    } finally { active = s.host; b.stop(); s.close(); }
}));

test('local Kitty does not install a widget even with an SSH agent and old remote helpers on PATH', () => inSsh(async () => {
    delete process.env.SSH_TTY;
    process.env.KITTY_PID = '42';
    const b = bridge(undefined); b.start(); b.stop(); assert.equal(b.calls(), 0);
}));

test('non-TUI modes do not install a widget', () => inSsh(async () => {
    for (const mode of ['print', 'rpc', 'json']) {
        const b = bridge(undefined, mode); b.start(); b.stop(); assert.equal(b.calls(), 0);
    }
}));
