import assert from "node:assert/strict";
import test from "node:test";
import { ClipboardAttachments } from "./attachments.ts";
import type { ImageContent } from "@earendil-works/pi-ai";
import { MAX_IMAGE_BYTES } from "./clipboard.mjs";

const image = (text: string): ImageContent => ({ type: "image", mimeType: "image/png", data: Buffer.from(text).toString("base64") });

test("matches draft markers in text order, deduplicating repeated markers", () => {
    const store = new ClipboardAttachments();
    const first = image("one"), second = image("two");
    const a = store.add(first, "");
    const b = store.add(second, a);
    assert.notEqual(a, b);
    assert.deepEqual(store.forText(`${b} ${a} ${b}`), [second, first]);
    assert.deepEqual(store.forText("just text"), []);
    store.remove(a);
    assert.throws(() => store.forText(a), /no longer staged/);
    store.clear();
    assert.throws(() => store.forText(b), /no longer staged/);
});

test("next paste reclaims images whose markers were deleted or already submitted", () => {
    const store = new ClipboardAttachments();
    const old = store.add(image("old"), "");
    const fresh = store.add(image("new"), "new draft without the old marker");
    assert.throws(() => store.forText(old), /no longer staged/);
    assert.deepEqual(store.forText(fresh), [image("new")]);
});

test("staged attachment count and total byte size are bounded", () => {
    const store = new ClipboardAttachments();
    let draft = "";
    for (let i = 0; i < 32; i++) draft += store.add(image("x"), draft);
    assert.throws(() => store.add(image("x"), draft), /32-image/);
    assert.doesNotThrow(() => store.add(image("x"), ""), "deleted images free the budget");
    assert.throws(() => new ClipboardAttachments().add({ type: "image", mimeType: "image/png", data: "A".repeat(Math.ceil((MAX_IMAGE_BYTES + 1) * 4 / 3)) }, ""), /64 MiB/);
});
