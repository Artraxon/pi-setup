import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureClipboardImage, isKittySession, MAX_IMAGE_BYTES } from "./clipboard.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");

test("recognizes Kitty directly and through forwarded Kitty environment", () => {
    assert.equal(isKittySession({ TERM: "xterm-kitty" }), true);
    assert.equal(isKittySession({ TERM: "screen", KITTY_WINDOW_ID: "1" }), true);
    assert.equal(isKittySession({ TERM: "xterm-256color" }), false);
});

test("captures PNG bytes in memory, with piped binary stdout/stderr and a bounded deadline", () => {
    const image = captureClipboardImage((command, args, options) => {
        assert.equal(command, "kitten");
        assert.deepEqual(args, ["clipboard", "--get-clipboard", "--mime", "image/png", "/dev/stdout"]);
        assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe"]);
        assert.equal(options.encoding, undefined, "never decode binary PNG bytes as UTF-8");
        assert.equal(options.maxBuffer, MAX_IMAGE_BYTES);
        assert.equal(options.timeout, 30_000);
        assert.equal(options.killSignal, "SIGKILL");
        return { status: 0, stdout: png };
    });
    assert.deepEqual(image, { type: "image", mimeType: "image/png", data: png.toString("base64") });
    assert.equal(image.path, undefined);
});

for (const [name, result, message] of [
    ["missing executable", { error: { code: "ENOENT" } }, /remote PATH/],
    ["timeout", { error: { code: "ETIMEDOUT" } }, /timed out/],
    ["bounded capture overflow", { error: { code: "ENOBUFS" } }, /64 MiB/],
    ["unexpected subprocess failure", { error: new Error("do not echo clipboard bytes") }, /Could not read/],
    ["permission denial or no image", { status: 1 }, /Copy an image/],
    ["signal", { status: null, signal: "SIGTERM" }, /Could not read/],
    ["missing output", { status: 0 }, /empty/],
    ["empty output", { status: 0, stdout: Buffer.alloc(0) }, /empty/],
    ["decoded text instead of bytes", { status: 0, stdout: "not binary" }, /PNG/],
    ["non-image bytes", { status: 0, stdout: Buffer.from("not an image") }, /PNG/],
]) test(`${name} fails clearly without echoing helper output`, () => {
    assert.throws(() => captureClipboardImage(() => ({ ...result, stderr: Buffer.from("sensitive helper output") })), message);
});

test("oversized output is rejected even if a runner failed to enforce maxBuffer", () => {
    assert.throws(() => captureClipboardImage(() => ({ status: 0, stdout: Buffer.alloc(MAX_IMAGE_BYTES + 1) })), /64 MiB/);
});

test("real subprocess returns bytes, not an image file, and captures helper diagnostics", () => {
    const bin = mkdtempSync(join(tmpdir(), "pi-fake-kitten-"));
    const oldPath = process.env.PATH;
    try {
        const command = join(bin, "kitten");
        writeFileSync(command, `#!/usr/bin/env node\nprocess.stderr.write('helper diagnostic must not reach Pi'); process.stdout.write(Buffer.from('${png.toString("base64")}', 'base64'));\n`);
        chmodSync(command, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        assert.deepEqual(captureClipboardImage(), { type: "image", mimeType: "image/png", data: png.toString("base64") });
        assert.deepEqual(readdirSync(bin), ["kitten"], "no clipboard image file created");
    } finally {
        process.env.PATH = oldPath;
        rmSync(bin, { recursive: true, force: true });
    }
});
