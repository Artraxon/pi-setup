import assert from "node:assert/strict";
import test, { after } from "node:test";
import kittyClipboard from "./index.ts";
import type { ImageContent } from "@earendil-works/pi-ai";

const oldTerm = process.env.TERM, oldWindow = process.env.KITTY_WINDOW_ID;
process.env.TERM = "xterm-kitty";
delete process.env.KITTY_WINDOW_ID;
after(() => {
    if (oldTerm === undefined) delete process.env.TERM; else process.env.TERM = oldTerm;
    if (oldWindow === undefined) delete process.env.KITTY_WINDOW_ID; else process.env.KITTY_WINDOW_ID = oldWindow;
});
const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

function harness(capture: () => ImageContent | Promise<ImageContent> = () => image, pasteKey = "\x16") {
    const events = new Map<string, any>(), commands = new Map<string, any>();
    const calls: string[] = [], notices: string[] = [];
    let draft = "Explain this:  keep this suffix", cursor = "Explain this: ".length;
    let input: ((data: string) => unknown) | undefined;
    let focused: any = { onPasteImage() {} };
    let unsubscribed = 0;
    const original = draft;
    kittyClipboard({
        on: (event: string, handler: any) => events.set(event, handler),
        registerShortcut: () => assert.fail("must reuse the native paste action"),
        registerCommand: (name: string, value: any) => commands.set(name, value),
        sendMessage: () => assert.fail("paste must not create a preview or follow-up message"),
        sendUserMessage: () => assert.fail("paste must not submit the draft"),
    } as any, () => { calls.push("capture"); return capture(); });
    const tui = {
        stop() { calls.push("stop"); }, start() { calls.push("start"); },
        requestRender(force: boolean) { assert.equal(force, true); calls.push("render"); },
        getFocusedComponent() { return focused; },
    };
    const ctx: any = { mode: "tui", ui: {
        notify: (message: string) => notices.push(message),
        getEditorText: () => draft,
        setEditorText: (text: string) => { draft = text; calls.push("setText"); },
        onTerminalInput: (handler: any) => {
            input = handler;
            return () => { input = undefined; unsubscribed++; };
        },
        pasteToEditor: (text: string) => {
            calls.push("paste");
            draft = draft.slice(0, cursor) + text + draft.slice(cursor);
            cursor += text.length;
        },
        setEditorComponent: () => assert.fail("must keep Pi's native editor"),
        custom: (factory: any, options: any) => new Promise(resolve => {
            assert.deepEqual(options, { overlay: true });
            factory(tui, {}, { matches(data: string, action: string) {
                assert.equal(action, "app.clipboard.pasteImage");
                return data === pasteKey;
            } }, resolve);
        }),
    } };
    return {
        events, commands, ctx, calls, notices, original,
        start: () => events.get("session_start")({}, ctx),
        submit: (text = draft, source = "interactive", images?: ImageContent[]) => events.get("input")({ text, source, images }, ctx),
        setDraft(text: string) { draft = text; cursor = text.length; },
        setFocus(value: any) { focused = value; },
        subscriptions: () => ({ active: !!input, unsubscribed }),
        dispatch: (key = "\x16") => input?.(key),
        key: async (key = "\x16") => { const result = input?.(key); await new Promise(resolve => setImmediate(resolve)); return result; },
    };
}

test("Ctrl+V stages bytes at the cursor in the native editor without files, previews or submission", async () => {
    const h = harness();
    await h.start();
    assert.deepEqual(await h.key(), { consume: true });
    assert.deepEqual(h.calls, ["stop", "capture", "start", "paste", "render"]);
    const text = h.ctx.ui.getEditorText();
    assert.match(text, /^Explain this:  \[#image [a-f0-9]{8}\]  keep this suffix$/);
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.submit(), { action: "transform", text, images: [image] });
    assert.deepEqual(h.submit(), { action: "transform", text, images: [image] }, "retry/cancel does not lose bytes");
    h.events.get("session_shutdown")();
    h.events.get("session_shutdown")();
    assert.deepEqual(h.subscriptions(), { active: false, unsubscribed: 1 });
});

test("failure restarts/redraws Pi and leaves the draft unchanged", async () => {
    const h = harness(() => { throw new Error("Permission denied"); });
    await h.start(); await h.key();
    assert.deepEqual(h.calls, ["stop", "capture", "start", "render"]);
    assert.equal(h.ctx.ui.getEditorText(), h.original);
    assert.match(h.notices[0], /Permission denied/);
});

test("deleting the marker prevents attachment; literal text and extension/RPC prompts never acquire images", async () => {
    const h = harness();
    await h.start(); await h.key();
    const text = h.ctx.ui.getEditorText();
    assert.deepEqual(h.submit(text, "extension"), { action: "continue" });
    assert.deepEqual(h.submit(text, "rpc"), { action: "continue" });
    assert.deepEqual(h.submit(`!echo ${text}`), { action: "continue" });
    h.setDraft("just text");
    assert.deepEqual(h.submit(), { action: "continue" });
    h.events.get("session_shutdown")();
});

test("multiple images follow marker order and preserve images already supplied by Pi", async () => {
    let i = 0;
    const values = [{ ...image, data: "b25l" }, { ...image, data: "dHdv" }];
    const h = harness(() => values[i++]); await h.start(); await h.key();
    const a = h.ctx.ui.getEditorText().match(/\[#image [a-f0-9]{8}\]/)![0];
    await h.key();
    const b = h.ctx.ui.getEditorText().match(/\[#image [a-f0-9]{8}\]/g)![1];
    const native = { ...image, data: "bmF0aXZl" };
    const result = h.submit(`${b} ${a} ${b}`, "interactive", [native]);
    assert.deepEqual(result.images, [native, values[1], values[0]]);
    assert.ok(!result.text.includes("Attached image paths"));
    h.events.get("session_shutdown")();
});

test("marker insertion failure rolls back the staged attachment and preserves the draft", async () => {
    const h = harness(); await h.start();
    h.ctx.ui.pasteToEditor = () => {};
    await h.key();
    assert.equal(h.ctx.ui.getEditorText(), h.original);
    assert.match(h.notices[0], /Could not insert/);
    assert.deepEqual(h.submit(), { action: "continue" });
    h.events.get("session_shutdown")();
});

test("stale markers after reload block submission rather than silently losing an image", async () => {
    const h = harness();
    await h.start(); await h.key();
    const text = h.ctx.ui.getEditorText();
    await h.start();
    h.setDraft("");
    assert.deepEqual(h.submit(text), { action: "handled" });
    assert.equal(h.ctx.ui.getEditorText(), text);
    assert.match(h.notices[0], /no longer staged/);
    h.events.get("session_shutdown")();
});

test("session switching clears staged bytes and reinstalls the input handler", async () => {
    const h = harness();
    await h.start(); await h.key();
    const text = h.ctx.ui.getEditorText();
    await h.events.get("session_switch")({}, h.ctx);
    assert.deepEqual(h.subscriptions(), { active: true, unsubscribed: 1 });
    assert.equal(h.submit(text).action, "handled");
    h.events.get("session_shutdown")();
});

test("busy clipboard requests cannot overlap and shutdown discards a late result", async () => {
    let resolve!: (value: ImageContent) => void;
    const h = harness(() => new Promise<ImageContent>(done => { resolve = done; }));
    await h.start();
    h.dispatch(); h.dispatch();
    assert.equal(h.calls.filter(value => value === "capture").length, 1);
    h.events.get("session_shutdown")();
    resolve(image);
    await new Promise(done => setImmediate(done));
    assert.ok(!h.calls.includes("paste") && !h.calls.includes("start"));
    assert.equal(h.ctx.ui.getEditorText(), h.original);
});

test("slash-command fallback stages an image too", async () => {
    const h = harness(); await h.start();
    await h.commands.get("kitty-paste").handler("", h.ctx);
    assert.equal(h.submit().images.length, 1);
    h.events.get("session_shutdown")();
});

test("non-TUI modes never access the clipboard or subscribe to input", async () => {
    const h = harness(() => { throw new Error("must not run"); });
    for (const mode of ["rpc", "json", "print"]) {
        h.ctx.mode = mode; await h.start();
        await h.commands.get("kitty-paste").handler("", h.ctx);
        assert.deepEqual(h.submit(), { action: "continue" });
    }
    assert.deepEqual(h.calls, []);
    assert.equal(h.subscriptions().active, false);
});

test("non-Kitty terminals retain their native paste action", async () => {
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

test("remapped native paste keys work; dialogs, attached PTYs and ordinary input are untouched", async () => {
    const h = harness(() => image, "\x1bv"); await h.start();
    for (const key of ["\x16", "hello", "\x1b[200~text\x1b[201~"]) assert.equal(await h.key(key), undefined);
    assert.deepEqual(h.calls, []);
    for (const focus of [null, {}, { handleInput() {} }, { onPasteImage: undefined }]) {
        h.setFocus(focus); assert.equal(await h.key("\x1bv"), undefined);
    }
    h.setFocus({ onPasteImage() {} });
    assert.deepEqual(await h.key("\x1bv"), { consume: true });
    h.events.get("session_shutdown")();
});
