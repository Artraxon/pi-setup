import assert from "node:assert/strict";
import test from "node:test";
import { KittyClipboardReader, isKittySession, MAX_IMAGE_BYTES } from "./clipboard.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
const b64 = value => Buffer.from(value).toString("base64");
const packet = (id, status, mime, data = "") => `\x1b]5522;type=read:id=${id}:status=${status}${mime ? `:mime=${b64(mime)}` : ""}${mime ? `;${data}` : ""}\x1b\\`;

function harness(options) {
    const requests = [];
    const reader = new KittyClipboardReader(request => requests.push(request), options);
    const current = () => {
        const request = requests.at(-1);
        return { id: /:id=([^:;]+)/.exec(request)[1], mime: Buffer.from(request.split(";")[2].slice(0, -2), "base64").toString() };
    };
    const send = (status, bytes, { id = current().id, mime = current().mime, encoded } = {}) => {
        const data = packet(id, status, status === "DATA" ? mime : undefined, encoded ?? (bytes ? b64(bytes) : ""));
        const result = reader.handleInput(data);
        assert.deepEqual(result, { consume: true });
    };
    const listed = async (types = "image/png") => {
        send("OK"); send("DATA", types); send("DONE");
        await Promise.resolve();
    };
    return { reader, requests, current, send, listed };
}

test("recognizes Kitty directly and through forwarded Kitty environment", () => {
    assert.equal(isKittySession({ TERM: "xterm-kitty" }), true);
    assert.equal(isKittySession({ TERM: "screen", KITTY_WINDOW_ID: "1" }), true);
    assert.equal(isKittySession({ TERM: "xterm-256color" }), false);
    assert.equal(MAX_IMAGE_BYTES, 64 * 1024 * 1024);
});

test("lists MIME types then reads PNG through uniquely correlated terminal requests", async () => {
    const h = harness();
    const image = h.reader.readImage();
    assert.equal(h.current().mime, ".");
    const first = h.current().id;
    await h.listed("text/plain image/jpeg image/png\n");
    assert.equal(h.current().mime, "image/png");
    assert.notEqual(h.current().id, first);
    h.send("OK"); h.send("DATA", png.subarray(0, 17)); h.send("DATA", png.subarray(17)); h.send("DONE");
    assert.deepEqual(await image, { type: "image", mimeType: "image/png", data: b64(png) });
    assert.ok(h.requests.every(request => request.includes(`:name=${b64("Pi clipboard")};`)));
});

for (const [mime, bytes] of [
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
    ["image/gif", Buffer.from("GIF89a-image")],
    ["image/webp", Buffer.from("RIFFsizeWEBPimage")],
]) test(`can select ${mime} when PNG is unavailable`, async () => {
    const h = harness(); const result = h.reader.readImage();
    await h.listed(mime);
    h.send("OK"); h.send("DATA", bytes); h.send("DONE");
    assert.equal((await result).mimeType, mime);
});

for (const [status, message] of [["EPERM", /denied/], ["EBUSY", /busy/], ["ENOSYS", /unavailable/]]) {
    test(`${status} rejects without echoing terminal data`, async () => {
        const h = harness(); const result = h.reader.readImage();
        h.send(status);
        await assert.rejects(result, message);
    });
}

test("no image rejects without reading a text clipboard or disturbing normal input", async () => {
    const h = harness(); const result = h.reader.readImage();
    await h.listed("text/plain text/html");
    await assert.rejects(result, /no supported image/);
    assert.equal(h.requests.length, 1);
    for (const key of ["a", "\x1b", "\x1b]", "\x1b[A", "\x1b[200~ordinary text\x1b[201~"]) assert.equal(h.reader.handleInput(key), undefined);
});

test("foreign responses pass through; old owned replies are consumed, not attached to a new request", async () => {
    const h = harness(); const result = h.reader.readImage();
    const previous = h.current().id;
    await h.listed();
    const foreign = packet("another-client", "DONE");
    assert.deepEqual(h.reader.handleInput(foreign), { data: foreign });
    h.send("EPERM", undefined, { id: previous });
    h.send("OK"); h.send("DATA", png); h.send("DONE");
    assert.equal((await result).data, b64(png));
    h.send("DATA", Buffer.from("late"), { id: previous, mime: "." });
});

for (const [name, respond, message] of [
    ["data before OK", h => h.send("DATA", png), /Unexpected/],
    ["duplicate OK", h => { h.send("OK"); h.send("OK"); }, /Unexpected/],
    ["unexpected MIME", h => { h.send("OK"); h.send("DATA", png, { mime: "text/plain" }); }, /MIME/],
    ["bad base64", h => { h.send("OK"); h.send("DATA", undefined, { encoded: "a!b=" }); }, /base64/],
    ["unpadded base64", h => { h.send("OK"); h.send("DATA", undefined, { encoded: "YQ" }); }, /base64/],
    ["noncanonical base64", h => { h.send("OK"); h.send("DATA", undefined, { encoded: "YR==" }); }, /base64/],
    ["oversized chunk", h => { h.send("OK"); h.send("DATA", Buffer.alloc(4097)); }, /4096/],
    ["MIME does not match image", h => { h.send("OK"); h.send("DATA", Buffer.from("not image bytes")); h.send("DONE"); }, /MIME type/],
    ["empty image", h => { h.send("OK"); h.send("DONE"); }, /empty/],
    ["signature without image data", h => { h.send("OK"); h.send("DATA", png.subarray(0, 8)); h.send("DONE"); }, /MIME type/],
]) test(`${name} fails closed`, async () => {
    const h = harness(); const result = h.reader.readImage();
    await h.listed();
    respond(h);
    await assert.rejects(result, message);
    h.reader.dispose();
});

for (const [name, body] of [
    ["missing ID", () => "type=read:status=OK"],
    ["wrong type", id => `type=write:id=${id}:status=OK`],
    ["duplicate metadata", id => `type=read:id=${id}:status=OK:status=OK`],
    ["malformed metadata", id => `type=read:id=${id}:status=OK:broken`],
    ["unexpected control payload", id => `type=read:id=${id}:status=OK;private-data`],
]) test(`${name} cannot escape into the editor`, async () => {
    const h = harness(); const result = h.reader.readImage();
    const frame = `\x1b]5522;${body(h.current().id)}\x1b\\`;
    assert.deepEqual(h.reader.handleInput(frame), { consume: true });
    await assert.rejects(result);
});

test("limits decoded aggregate bytes even when every chunk is small", async () => {
    const h = harness({ maxBytes: 10 }); const result = h.reader.readImage();
    await h.listed();
    h.send("OK"); h.send("DATA", png.subarray(0, 8)); h.send("DATA", png.subarray(8, 12));
    await assert.rejects(result, /size limit/);
});

test("timeouts and disposal reject pending work; concurrent reads are rejected", async () => {
    const h = harness({ timeoutMs: 10 }); const result = h.reader.readImage();
    await assert.rejects(h.reader.readImage(), /already in progress/);
    await assert.rejects(result, /timed out/);
    const second = h.reader.readImage();
    h.reader.dispose(); h.reader.dispose();
    await assert.rejects(second, /cancelled/);
    await assert.rejects(h.reader.readImage(), /cancelled/);
});

test("failed writes reject without leaking write error details", async () => {
    const reader = new KittyClipboardReader(() => { throw new Error("private terminal output"); });
    await assert.rejects(reader.readImage(), { message: "Could not send the Kitty clipboard request." });
});

test("reassembles slow OSC fragments, split terminators and several frames in one input", async () => {
    const h = harness(); const result = h.reader.readImage();
    const id = h.current().id;
    for (const part of ["\x1b]", "55", "22;", `type=read:id=${id}:status=OK`, "\x1b", "\\"]) {
        assert.deepEqual(h.reader.handleInput(part), { consume: true });
    }
    const remaining = packet(id, "DATA", ".", b64("image/png")) + packet(id, "DONE");
    assert.deepEqual(h.reader.handleInput(remaining), { consume: true });
    await Promise.resolve();
    h.send("OK"); h.send("DATA", png); h.send("DONE");
    assert.equal((await result).data, b64(png));
    assert.equal(h.reader.handleInput("\x1b]"), undefined, "idle Alt+] input is left alone");
    const next = h.reader.readImage();
    assert.deepEqual(h.reader.handleInput("\x1b]"), { consume: true });
    assert.deepEqual(h.reader.handleInput("x"), { data: "\x1b]x" }, "unrelated Alt+] input during a read is returned");
    h.reader.dispose();
    await assert.rejects(next, /cancelled/);
});

test("batched foreign and owned packets are filtered independently without leaking payloads", async () => {
    const h = harness(); const result = h.reader.readImage();
    await h.listed();
    const id = h.current().id;
    const foreign = packet("other-client", "DONE");
    const batch = foreign + packet(id, "OK") + packet(id, "DATA", "image/png", b64(png)) + packet(id, "DONE") + "z";
    assert.deepEqual(h.reader.handleInput(batch), { data: foreign + "z" });
    assert.equal((await result).data, b64(png));
});

test("oversized unterminated frames are bounded and drained through the terminator", async () => {
    const h = harness(); const result = h.reader.readImage();
    assert.deepEqual(h.reader.handleInput("\x1b]5522;" + "x".repeat(9000)), { consume: true });
    await assert.rejects(result, /packet is too large/);
    assert.ok(h.reader.frame.length <= 1);
    assert.deepEqual(h.reader.handleInput("still draining\x1b"), { consume: true });
    assert.deepEqual(h.reader.handleInput("\\z"), { data: "z" });
});
