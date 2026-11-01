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

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
function imageFile() {
    const directory = mkdtempSync(join(tmpdir(), "pi-kitty-test-"));
    const path = join(directory, "clipboard.png");
    writeFileSync(path, png);
    return { directory, path };
}

function harness(capture: () => { directory: string; path: string }, attach = true) {
    const events = new Map<string, any>(), shortcuts = new Map<string, any>(), commands = new Map<string, any>();
    const calls: string[] = [], notices: string[] = [];
    let draft = "Explain this: | keep this suffix", cursor = draft.indexOf("|");
    draft = draft.replace("|", "");
    const original = draft;
    kittyClipboard({
        on: (event: string, handler: any) => events.set(event, handler),
        registerShortcut: (key: string, value: any) => shortcuts.set(key, value),
        registerCommand: (name: string, value: any) => commands.set(name, value),
    } as any, () => { calls.push("capture"); return capture(); });
    const ctx: any = {
        mode: "tui",
        ui: {
            notify: (message: string) => notices.push(message),
            getEditorText: () => draft,
            setEditorText: (text: string) => { draft = text; calls.push("setText"); },
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
                }, {}, {}, resolve);
            }),
        },
    };
    return { events, shortcuts, commands, ctx, calls, notices, original };
}

test("Ctrl+V suspends the terminal, attaches at the cursor, and never submits", async () => {
    const image = imageFile();
    const h = harness(() => image);
    try {
        await h.shortcuts.get("ctrl+v").handler(h.ctx);
        assert.deepEqual(h.calls, ["stop", "capture", "start", "render", "paste", "render"]);
        assert.equal(h.ctx.ui.getEditorText(), "Explain this:  [#image 1]  keep this suffix");
        assert.deepEqual(h.notices, []);
        assert.ok(existsSync(image.path), "keep the source available to tools during the runtime");
        h.events.get("session_shutdown")();
        h.events.get("session_shutdown")();
        assert.equal(existsSync(image.directory), false);
    } finally { rmSync(image.directory, { recursive: true, force: true }); }
});

test("failure restarts/redraws Pi and leaves the draft unchanged", async () => {
    const h = harness(() => { throw new Error("Permission denied"); });
    await h.shortcuts.get("ctrl+v").handler(h.ctx);
    assert.deepEqual(h.calls, ["stop", "capture", "start", "render", "render"]);
    assert.equal(h.ctx.ui.getEditorText(), h.original);
    assert.match(h.notices[0], /Permission denied/);
});

test("missing paster restores the draft and cleans up instead of inserting a dead path", async () => {
    const image = imageFile();
    const h = harness(() => image, false);
    await h.shortcuts.get("ctrl+v").handler(h.ctx);
    assert.equal(h.ctx.ui.getEditorText(), h.original);
    assert.match(h.notices[0], /pi-paster did not attach/);
    assert.equal(existsSync(image.directory), false);
});

test("repeated Ctrl+V cannot start overlapping clipboard requests", async () => {
    const image = imageFile();
    const h = harness(() => image);
    try {
        await Promise.all([h.shortcuts.get("ctrl+v").handler(h.ctx), h.shortcuts.get("ctrl+v").handler(h.ctx)]);
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

test("non-TUI modes never access the clipboard", async () => {
    const h = harness(() => { throw new Error("must not run"); });
    for (const mode of ["rpc", "json", "print"]) {
        h.ctx.mode = mode;
        await h.commands.get("kitty-paste").handler("", h.ctx);
    }
    assert.deepEqual(h.calls, []);
});

test("non-Kitty terminals keep their original Ctrl+V", async () => {
    process.env.TERM = "xterm-256color";
    try {
        const h = harness(() => { throw new Error("must not run"); });
        assert.equal(h.shortcuts.has("ctrl+v"), false);
        await h.commands.get("kitty-paste").handler("", h.ctx);
        assert.deepEqual(h.calls, []);
        assert.match(h.notices[0], /requires a Kitty/);
    } finally { process.env.TERM = "xterm-kitty"; }
});
