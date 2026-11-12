import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { KittyState } from './kitty-state.mjs';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const tuiRoot = resolve(root, 'node_modules/@earendil-works/pi-tui/dist');
const tui = await import(resolve(tuiRoot, 'index.js'));
const { TuiAltScreen } = await import(resolve(tuiRoot, 'tui-alt-screen.js'));
const { ToolExecutionComponent } = await import(resolve(root, 'dist/modes/interactive/components/tool-execution.js'));
const { initTheme } = await import(resolve(root, 'dist/modes/interactive/theme/theme.js'));
const { createInteractiveTuiReference } = await import(resolve(root, 'dist/modes/interactive/tui-renderer.js'));
const { getKittyImagePlacement } = await import(resolve(tuiRoot, 'terminal-image.js'));
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(tuiRoot, 'index.js'),
    '@earendil-works/pi-coding-agent': resolve(root, 'dist/index.js'),
} });
const { default: extension, collectImages } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
const { ImageViewer, geometry } = await jiti.import(fileURLToPath(new URL('./viewer.ts', import.meta.url)));
const { default: compactTools } = await jiti.import(fileURLToPath(new URL('../compact-tools/index.ts', import.meta.url)));
const fixtures = new Map();
function picture(w = 100, h = 80) {
    const key = `${w}x${h}`;
    if (fixtures.has(key)) return fixtures.get(key);
    function chunk(name, data) {
        const body = Buffer.concat([Buffer.from(name), data]);
        let crc = 0xffffffff;
        for (const byte of body) {
            crc ^= byte;
            for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
        size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([size, body, checksum]);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(w); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = 2;
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.alloc((w * 3 + 1) * h))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
    fixtures.set(key, png);
    return png;
}
const mouse = (type, extra = {}) => ({ type, button: 'left', x: 0, y: 0,
    screenX: 0, screenY: 0, width: 80, height: 24, ctrl: false, alt: false, shift: false, ...extra });
function controls(line) {
    return Object.fromEntries(/\x1b_G([^;]*);/.exec(line)[1].split(',').map(pair => pair.split('=')));
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup({ compact = false } = {}) {
    tui.setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: true });
    tui.setCellDimensions({ widthPx: 10, heightPx: 20 });
    let input, onResize, output = '', component, closed = 0;
    const graphics = new KittyState();
    const terminal = { columns: 80, rows: 24,
        start(fn, resized) { input = fn; onResize = resized; }, stop() {},
        write(value) { output += value; graphics.consume(value); },
        hideCursor() {}, showCursor() {}, moveBy() {}, clearLine() {}, clearFromCursor() {},
        clearScreen() {}, setTitle() {}, setProgress() {}, setWorking() {},
        setCursorPosition() {}, drainInput: async () => {},
    };
    const host = new TuiAltScreen(terminal);
    const reference = createInteractiveTuiReference(() => host);
    let image = new tui.Image(picture(), 'image/png', { fallbackColor: s => s });
    let tool;
    if (compact) {
        initTheme('dark', false);
        let resolver;
        compactTools({ on() {}, registerToolRenderer(fn) { resolver = fn; } });
        tool = new ToolExecutionComponent('read', 'image-result', { path: '/tmp/demo.png' },
            { imageWidthCells: 10 }, resolver('read', () => undefined), host, '/tmp');
        tool.updateResult({ content: [{ type: 'image', data: picture(), mimeType: 'image/png' }], details: undefined });
        image = tool.imageComponents[0];
        host.addChild(tool);
    } else host.addChild(image);
    const editor = { render: () => ['draft'], invalidate() {}, handleInput() {} };
    host.addChild(editor); host.setFocus(editor);
    const events = new Map(), commands = new Map(), notices = [];
    const ctx = { mode: 'tui', ui: {
        setWidget(_key, factory) { factory(reference); },
        notify(...args) { notices.push(args); },
        custom(factory, options) {
            return new Promise(resolve => {
                let handle;
                component = factory(reference, { fg: (_token, text) => text }, {}, () => {
                    handle.hide(); closed++; resolve();
                });
                handle = host.showOverlay(component, options.overlayOptions);
            });
        },
    } };
    extension({ on(name, fn) { events.set(name, fn); }, registerCommand(name, value) { commands.set(name, value); } });
    events.get('session_start')({}, ctx);
    host.start(); host.renderNow();
    return { host, image, tool, editor, ctx, terminal, graphics, notices, events, commands,
        component: () => component, output: () => output, clearOutput: () => output = '',
        input: data => input(data), closed: () => closed,
        resize(columns, rows) { terminal.columns = columns; terminal.rows = rows; onResize(); host.renderNow(); },
        cleanup() { events.get('session_shutdown')(); host.stop(); },
    };
}

test('native size, fit large images, bounded centered source crop on zoom', () => {
    const dim = { widthPx: 2000, heightPx: 1000 }, cell = { widthPx: 10, heightPx: 20 };
    const fit = geometry(dim, 80, 20, cell, 0.4);
    assert.deepEqual(fit, { x: 0, y: 0, w: 2000, h: 1000, columns: 80, rows: 20 });
    const zoom = geometry(dim, 80, 20, cell, 1);
    assert.deepEqual(zoom, { x: 600, y: 300, w: 800, h: 400, columns: 80, rows: 20 });
    assert.equal(geometry(dim, 80, 20, cell, 1, 1e6, -1e6).x, 1200);
    assert.equal(geometry(dim, 80, 20, cell, 1, 1e6, -1e6).y, 0);
});

test('real fullscreen mouse press/release opens foreground; q restores inline image and focus', async () => {
    const s = setup();
    const original = s.image.render(80)[0];
    try {
        // The implicit transcript is top-aligned. Exercise real SGR mouse routing.
        s.input('\x1b[<0;1;1M'); s.input('\x1b[<0;1;1m');
        await tick();
        assert.ok(s.host.hasOverlay());
        s.host.renderNow();
        assert.equal(s.image.render(80)[0], '', 'underlying image is suppressed, not painted over the viewer');
        const screen = s.host.getScreenLines();
        assert.ok(screen.at(-1).includes('100%'));
        const graphic = screen.find(line => line.includes('\x1b_G'));
        assert.ok(graphic, 'foreground image survives real overlay compositing');
        assert.notEqual(controls(graphic).i, controls(original).i);
        assert.equal(controls(graphic).c, '10', '100px at 10px/cell, not upscaled');
        assert.equal(controls(graphic).r, '4');
        s.input('q'); await tick();
        assert.equal(s.closed(), 1);
        assert.equal(s.host.hasOverlay(), false);
        assert.equal(s.host.getFocusedComponent(), s.editor);
        assert.equal(s.image.render(80)[0], original);
        s.host.renderNow();
        const restoredGraphic = s.host.getScreenLines().find(line => line.includes('\x1b_G'));
        assert.equal(controls(restoredGraphic).i, controls(original).i, 'viewer placement is gone');
        assert.ok(s.graphics.placements.has(controls(original).i), 'inline image data really survived the clear');
        assert.deepEqual(s.graphics.missingPlacements, []);
        assert.deepEqual(s.notices, []);
    } finally { s.cleanup(); }
});

test('keyboard and Ctrl+wheel zoom, key release ignored; SSH cache sends placements, not image bytes again', async () => {
    const s = setup();
    try {
        const opened = s.commands.get('image').handler('', s.ctx);
        await tick(); s.host.renderNow();
        s.clearOutput();
        s.input('+'); s.host.renderNow();
        assert.ok(s.host.getScreenLines().at(-1).includes('125%'));
        assert.ok(!s.output().includes(picture()), 'zoom does not retransmit the PNG');
        assert.match(s.output(), /a=p/);
        s.input('\x1b[43;1:3u'); s.host.renderNow();
        assert.ok(s.host.getScreenLines().at(-1).includes('125%'));
        s.input('\x1b[<80;40;12M'); s.host.renderNow(); // Ctrl+wheel up
        assert.ok(s.host.getScreenLines().at(-1).includes('156%'));
        s.input('\x1b[<81;40;12M'); s.input('-'); s.host.renderNow();
        assert.ok(s.host.getScreenLines().at(-1).includes('100%'));
        s.input('\x1b'); await opened;
        assert.equal(s.host.hasOverlay(), false);
    } finally { s.cleanup(); }
});

test('resize, pan, reset and repeated zoom keep all lines and placements inside terminal', () => {
    const s = setup();
    let done = 0;
    try {
        const viewer = new ImageViewer({ data: picture(2000, 1000), dimensions: { widthPx: 2000, heightPx: 1000 } },
            s.host, text => text, () => done++);
        const initial = viewer.render(80);
        assert.match(initial.at(-1), /40%/);
        const transfer = initial.find(line => line.includes('\x1b_G'));
        const chunks = [...transfer.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
        assert.ok(chunks.length > 1, 'large PNG uses chunked SSH-safe transfer');
        assert.ok(chunks.every(([, controls, payload]) => payload.length <= 4096 && !/t=[fst]/.test(controls)));
        assert.equal(chunks.map(([, , payload]) => payload).join(''), picture(2000, 1000));
        for (let i = 0; i < 12; i++) viewer.handleInput('+');
        viewer.handleInput('\x1b[C');
        const graphic = viewer.render(80).find(line => line.includes('\x1b_G'));
        assert.ok(Number(controls(graphic).x) > 0);
        assert.ok(Number(controls(graphic).w) < 2000);
        const placement = getKittyImagePlacement(graphic);
        assert.match(placement.sequence, /x=\d+,y=\d+,w=\d+,h=\d+/);
        for (const [columns, rows] of [[12, 5], [1, 1], [120, 60]]) {
            s.terminal.columns = columns; s.terminal.rows = rows;
            const lines = viewer.render(columns);
            assert.equal(lines.length, rows);
            for (const line of lines) assert.ok(tui.visibleWidth(line) <= columns);
            const image = lines.find(line => line.includes('\x1b_G'));
            if (image) {
                assert.ok(Number(controls(image).c) <= columns);
                assert.ok(Number(controls(image).r) < rows);
            }
        }
        viewer.handleInput('0'); assert.match(viewer.render(120).at(-1), /60%/);
        viewer.handleInput('q'); viewer.handleInput('\x1b'); assert.equal(done, 1);
    } finally { s.cleanup(); }
});

test('inline graphics survive viewer close, repeated resizes and forced full redraws at unchanged dimensions', async () => {
    const s = setup({ compact: true });
    const inlineId = String(s.image.getImageId());
    try {
        assert.ok(s.graphics.placements.has(inlineId), 'initial inline graphics are visible');
        for (let round = 0; round < 3; round++) {
            const opened = s.commands.get('image').handler('', s.ctx);
            await tick(); s.host.renderNow();
            const foregroundId = controls(s.host.getScreenLines().find(line => line.includes('\x1b_G'))).i;
            assert.ok(s.graphics.placements.has(foregroundId), 'foreground graphics are actually placed');
            for (const [columns, rows] of [[40, 12], [80, 24]]) {
                s.resize(columns, rows);
                assert.ok(s.graphics.placements.has(foregroundId), 'foreground survives resize');
                s.host.renderNow(true);
                assert.ok(s.graphics.placements.has(foregroundId), 'foreground survives ED 2 full clear at unchanged size');
            }
            s.input('q'); await opened; s.host.renderNow();
            assert.ok(s.graphics.placements.has(inlineId), 'closing viewer must restore graphics, not just the click target');
            for (const [columns, rows] of [[40, 12], [80, 24], [80, 12], [80, 24]]) {
                s.resize(columns, rows);
                assert.ok(s.graphics.placements.has(inlineId), 'inline graphics survive resize');
                s.host.renderNow(true);
                assert.ok(s.graphics.placements.has(inlineId), 'inline graphics survive repeated full clears');
            }
        }
        assert.deepEqual(s.graphics.missingPlacements, [], 'never reference image data erased by ED 2');
    } finally { s.cleanup(); }
});

test('foreground image reuploads on shrink and expand, including height-only and cell-pixel resize', async () => {
    const s = setup();
    try {
        const opened = s.commands.get('image').handler('', s.ctx);
        await tick(); s.host.renderNow();
        const imageId = controls(s.host.getScreenLines().find(line => line.includes('\x1b_G'))).i;
        for (const [columns, rows] of [[40, 12], [80, 24], [80, 10], [80, 24], [1, 1], [80, 24]]) {
            s.clearOutput(); s.resize(columns, rows);
            if (rows === 1) continue; // Only the control row fits, but recovery must still work.
            const graphic = s.host.getScreenLines().find(line => line.includes('\x1b_G'));
            assert.ok(graphic, 'resized frame retains the foreground image');
            assert.equal(controls(graphic).i, imageId);
            assert.ok(s.output().includes(picture()), 'resize must reupload PNG, not reference a possibly lost terminal image');
            assert.ok(s.host.getScreenLines().at(-1).includes('100%'), 'resize preserves zoom');
            s.clearOutput(); s.input('+'); s.host.renderNow();
            assert.ok(!s.output().includes(picture()), 'ordinary zoom still reuses uploaded data');
            s.input('-'); s.host.renderNow();
        }
        s.clearOutput();
        tui.setCellDimensions({ widthPx: 9, heightPx: 18 });
        s.host.invalidate(); s.host.renderNow();
        assert.ok(s.output().includes(picture()), 'cell pixel changes also refresh the upload');
        s.input('q'); await opened;
    } finally { s.cleanup(); }
});

test('inline compact tool image also recovers from height-only resizing and return to original size', () => {
    const s = setup({ compact: true });
    try {
        for (const [columns, rows] of [[80, 12], [80, 24], [40, 12], [80, 24]]) {
            s.clearOutput(); s.resize(columns, rows);
            assert.ok(s.host.getScreenLines().some(line => line.includes('\x1b_G')));
            assert.ok(s.output().includes(picture()), 'inline cached image must be refreshed after resize');
        }
    } finally { s.cleanup(); }
});

test('click outside actual image, drags, right click and existing overlays do not open viewer', async () => {
    const s = setup();
    try {
        assert.equal(s.image.handleMouse(mouse('click', { x: 70 })), undefined);
        assert.equal(s.image.handleMouse(mouse('drag')), undefined);
        assert.equal(s.image.handleMouse(mouse('click', { button: 'right' })), undefined);
        const overlay = s.host.showOverlay({ render: () => ['dialog'], invalidate() {} });
        assert.equal(s.image.handleMouse(mouse('click')), undefined);
        overlay.hide();
        assert.equal(s.host.hasOverlay(), false);
        await s.commands.get('image').handler('0', s.ctx);
        assert.match(s.notices[0][0], /Use \/image/);
        assert.deepEqual(collectImages(s.host), [s.image]);
    } finally { s.cleanup(); }
});

test('actual compact tool-result image receives clicks below the self-rendered text area', async () => {
    const beforeMouse = ToolExecutionComponent.prototype.handleMouse;
    const s = setup({ compact: true });
    try {
        assert.deepEqual(collectImages(s.host), [s.image]);
        const imageRow = s.host.getScreenLines().findIndex(line => line.includes('\x1b_G'));
        assert.ok(imageRow > s.tool.selfRenderHeight, 'image is outside the text mouse region');
        for (const row of [imageRow, imageRow + 2]) {
            s.input(`\x1b[<0;1;${row + 1}M`); s.input(`\x1b[<0;1;${row + 1}m`);
            await tick();
            assert.ok(s.host.hasOverlay(), 'click on compact tool image must open viewer');
            s.host.renderNow();
            assert.ok(s.host.getScreenLines().at(-1).includes('100%'));
            s.input('q'); await tick(); s.host.renderNow();
            assert.equal(s.host.hasOverlay(), false);
        }
        // Plain text selection must not expand; Ctrl-click owns expansion.
        assert.equal(s.tool.expanded, false);
        s.input('\x1b[<0;1;2M'); s.input('\x1b[<0;1;2m');
        assert.equal(s.tool.expanded, false);
        s.input('\x1b[<16;1;2M'); s.input('\x1b[<16;1;2m');
        assert.equal(s.tool.expanded, true);
        assert.equal(s.host.hasOverlay(), false);
    } finally { s.cleanup(); }
    assert.equal(ToolExecutionComponent.prototype.handleMouse, beforeMouse);
});

test('shutdown restores prototype hooks, closes viewer, and prevents stale async opens', async () => {
    const beforeRender = tui.Image.prototype.render;
    const beforeMouse = Object.getOwnPropertyDescriptor(tui.Image.prototype, 'handleMouse');
    const beforePrepare = TuiAltScreen.prototype.prepareKittyScreen;
    const s = setup();
    assert.notEqual(TuiAltScreen.prototype.prepareKittyScreen, beforePrepare);
    const pending = s.commands.get('image').handler('', s.ctx);
    s.events.get('session_shutdown')();
    await pending;
    assert.equal(s.host.hasOverlay(), false);
    assert.equal(tui.Image.prototype.render, beforeRender);
    assert.equal(TuiAltScreen.prototype.prepareKittyScreen, beforePrepare);
    assert.deepEqual(Object.getOwnPropertyDescriptor(tui.Image.prototype, 'handleMouse'), beforeMouse);
    s.host.stop();
    const next = setup();
    try {
        const opened = next.commands.get('image').handler('', next.ctx);
        await tick();
        assert.ok(next.host.hasOverlay());
        next.events.get('session_shutdown')(); await opened;
        assert.equal(next.host.hasOverlay(), false);
        assert.equal(tui.Image.prototype.render, beforeRender);
        assert.equal(TuiAltScreen.prototype.prepareKittyScreen, beforePrepare);
    } finally { next.host.stop(); }
});
