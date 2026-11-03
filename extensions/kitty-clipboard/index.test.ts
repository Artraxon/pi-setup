import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import kittyClipboard from "./index.ts";

const oldTerm = process.env.TERM;
const oldWindow = process.env.KITTY_WINDOW_ID;
process.env.TERM = "xterm-kitty";
delete process.env.KITTY_WINDOW_ID;
after(() => {
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
    if (oldWindow === undefined) delete process.env.KITTY_WINDOW_ID; else process.env.KITTY_WINDOW_ID = oldWindow;
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
function imageFile() {
    const directory = mkdtempSync(join(tmpdir(), "pi-kitty-test-"));
    const path = join(directory, "clipboard.png");
    writeFileSync(path, png);
    return { directory, path };
}

function harness(capture: () => { directory: string; path: string }, attach = true, pasteKey = "\x16") {
    const events = new Map<string, any>(), commands = new Map<string, any>();
    const calls: string[] = [], notices: string[] = [];
    let draft = "Explain this: | keep this suffix", cursor = draft.indexOf("|");
    let input: ((data: string) => unknown) | undefined;
    let focused: any = { onPasteImage() {} };
    let unsubscribed = 0;
    draft = draft.replace("|", "");
    const original = draft;
    kittyClipboard({
        on: (event: string, handler: any) => events.set(event, handler),
        registerShortcut: () => assert.fail("must reuse the native paste action, not register a competing shortcut"),
        registerCommand: (name: string, value: any) => commands.set(name, value),
    } as any, () => { calls.push("capture"); return capture(); });
    const ctx: any = {
        mode: "tui",
        ui: {
            notify: (message: string) => notices.push(message),
            getEditorText: () => draft,
            setEditorText: (text: string) => { draft = text; calls.push("setText"); },
            onTerminalInput: (handler: any) => {
                input = handler;
                return () => { input = undefined; unsubscribed++; };
            },
            pasteToEditor: (text: string) => {
                calls.push("paste");
                const value = attach ? " [#image 1] " : text;
                draft = draft.slice(0, cursor) + value + draft.slice(cursor);
                cursor += value.length;
            },
            custom: (factory: any, options: any) => new Promise(resolve => {
                assert.deepEqual(options, { overlay: true }, "must not reset the editor/cursor");
                factory({
                    stop() { calls.push("stop"); },
                    start() { calls.push("start"); },
                    requestRender(force: boolean) { assert.equal(force, true); calls.push("render"); },
                    getFocusedComponent() { return focused; },
                }, {}, {
                    matches(data: string, action: string) {
                        assert.equal(action, "app.clipboard.pasteImage");
                        return data === pasteKey;
                    },
                }, resolve);
            }),
        },
    };
    return {
        events, commands, ctx, calls, notices, original,
        start: () => events.get("session_start")({}, ctx),
        setFocus: (value: any) => { focused = value; },
        subscriptions: () => ({ active: !!input, unsubscribed }),
        dispatch: (key = "\x16") => input?.(key),
        key: async (key = "\x16") => {
            const result = input?.(key);
            await new Promise(resolve => setImmediate(resolve));
            return result;
        },
    };
}

test("native Ctrl+V suspends the terminal, attaches at the cursor, redraws, and never submits", async () => {
    const image = imageFile();
    const h = harness(() => image);
    try {
        await h.start();
        assert.deepEqual(await h.key(), { consume: true });
        assert.deepEqual(h.calls, ["stop", "capture", "start", "render", "paste", "render"]);
        assert.equal(h.ctx.ui.getEditorText(), "Explain this:  [#image 1]  keep this suffix");
        assert.deepEqual(h.notices, []);
        assert.ok(existsSync(image.path), "keep the source available to tools during the runtime");
        h.events.get("session_shutdown")();
        h.events.get("session_shutdown")();
        assert.equal(existsSync(image.directory), false);
        assert.deepEqual(h.subscriptions(), { active: false, unsubscribed: 1 });
    } finally { rmSync(image.directory, { recursive: true, force: true }); }
});

test("failure restarts/redraws Pi and leaves the draft unchanged", async () => {
    const h = harness(() => { throw new Error("Permission denied"); });
    await h.start();
    await h.key();
    assert.deepEqual(h.calls, ["stop", "capture", "start", "render", "render"]);
    assert.equal(h.ctx.ui.getEditorText(), h.original);
    assert.match(h.notices[0], /Permission denied/);
});

test("missing paster restores the draft and cleans up instead of inserting a dead path", async () => {
    const image = imageFile();
    const h = harness(() => image, false);
    await h.start();
    await h.key();
    assert.equal(h.ctx.ui.getEditorText(), h.original);
    assert.match(h.notices[0], /pi-paster did not attach/);
    assert.equal(existsSync(image.directory), false);
});

test("repeated paste keys cannot start overlapping clipboard requests", async () => {
    const image = imageFile();
    const h = harness(() => image);
    try {
        await h.start();
        await Promise.all([h.key(), h.key()]);
        assert.equal(h.calls.filter(value => value === "capture").length, 1);
    } finally { h.events.get("session_shutdown")(); }
});

test("slash-command fallback attaches the image too", async () => {
    const image = imageFile();
    const h = harness(() => image);
    try {
        await h.commands.get("kitty-paste").handler("", h.ctx);
        assert.match(h.ctx.ui.getEditorText(), /\[#image 1\]/);
    } finally { h.events.get("session_shutdown")(); }
});

test("non-TUI modes never access the clipboard or subscribe to input", async () => {
    const h = harness(() => { throw new Error("must not run"); });
    for (const mode of ["rpc", "json", "print"]) {
        h.ctx.mode = mode;
        await h.start();
        await h.commands.get("kitty-paste").handler("", h.ctx);
    }
    assert.deepEqual(h.calls, []);
    assert.equal(h.subscriptions().active, false);
});

test("non-Kitty terminals keep their native paste", async () => {
    process.env.TERM = "xterm-256color";
    try {
        const h = harness(() => { throw new Error("must not run"); });
        await h.start();
        assert.equal(h.subscriptions().active, false);
        await h.commands.get("kitty-paste").handler("", h.ctx);
        assert.deepEqual(h.calls, []);
        assert.match(h.notices[0], /requires a Kitty/);
    } finally { process.env.TERM = "xterm-kitty"; }
});

test("uses a remapped native image-paste key and leaves ordinary input alone", async () => {
    const image = imageFile();
    const h = harness(() => image, true, "\x1bv");
    try {
        await h.start();
        for (const key of ["\x16", "hello", "\x1b[200~text\x1b[201~"]) assert.equal(await h.key(key), undefined);
        assert.deepEqual(h.calls, []);
        assert.deepEqual(await h.key("\x1bv"), { consume: true });
        assert.match(h.ctx.ui.getEditorText(), /\[#image 1\]/);
    } finally { h.events.get("session_shutdown")(); }
});

test("dialogs and attached PTYs keep their input", async () => {
    const h = harness(() => { throw new Error("must not run"); });
    await h.start();
    for (const focus of [null, {}, { handleInput() {} }, { onPasteImage: undefined }]) {
        h.setFocus(focus);
        assert.equal(await h.key(), undefined);
    }
    assert.deepEqual(h.calls, []);
});

test("restarting a session replaces the input subscription and shutdown removes it", async () => {
    const h = harness(() => { throw new Error("must not run"); });
    await h.start();
    await h.start();
    assert.deepEqual(h.subscriptions(), { active: true, unsubscribed: 1 });
    h.events.get("session_shutdown")();
    assert.deepEqual(h.subscriptions(), { active: false, unsubscribed: 2 });
    assert.equal(h.dispatch(), undefined);
});
