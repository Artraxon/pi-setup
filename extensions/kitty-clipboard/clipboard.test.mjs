import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, openSync, closeSync, ftruncateSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { captureClipboardImage, isKittySession } from "./clipboard.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");

test("recognizes Kitty directly and through forwarded Kitty environment", () => {
    assert.equal(isKittySession({ TERM: "xterm-kitty" }), true);
    assert.equal(isKittySession({ TERM: "screen", KITTY_WINDOW_ID: "1" }), true);
    assert.equal(isKittySession({ TERM: "xterm-256color" }), false);
});

test("uses the working Kitty image command, inherited terminal, and a hard timeout", () => {
    const image = captureClipboardImage((command, args, options) => {
        assert.equal(command, "kitten");
        assert.deepEqual(args.slice(0, 2), ["clipboard", "--get-clipboard"]);
        assert.equal(options.stdio, "inherit");
        assert.equal(options.timeout, 30_000);
        assert.equal(options.killSignal, "SIGKILL");
        writeFileSync(args[2], png);
        return { status: 0 };
    });
    try {
        assert.equal(statSync(image.directory).mode & 0o777, 0o700);
        assert.equal(statSync(image.path).mode & 0o777, 0o600);
    } finally {
        rmSync(image.directory, { recursive: true, force: true });
    }
});

for (const [name, prepare, result, message] of [
    ["missing executable", () => {}, { error: { code: "ENOENT" } }, /remote PATH/],
    ["timeout", () => {}, { error: { code: "ETIMEDOUT" } }, /timed out/],
    ["permission denial or no image", () => {}, { status: 1 }, /Copy an image/],
    ["signal", () => {}, { status: null, signal: "SIGTERM" }, /Could not read/],
    ["missing output", () => {}, { status: 0 }, /ENOENT/],
    ["empty output", path => writeFileSync(path, ""), { status: 0 }, /empty/],
    ["non-image output", path => writeFileSync(path, "not an image"), { status: 0 }, /PNG/],
    ["oversized output", path => {
        const fd = openSync(path, "w");
        try { ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { closeSync(fd); }
    }, { status: 0 }, /64 MiB/],
]) {
    test(`${name} fails clearly and removes temporary files`, () => {
        let directory;
        assert.throws(() => captureClipboardImage((_command, args) => {
            directory = dirname(args[2]);
            prepare(args[2]);
            return result;
        }), message);
        assert.ok(directory);
        assert.equal(existsSync(directory), false);
    });
}

test("real subprocess invocation works with a fake kitten, without reading the host clipboard", () => {
    const bin = mkdtempSync(join(tmpdir(), "pi-fake-kitten-"));
    const oldPath = process.env.PATH;
    let image;
    try {
        const command = join(bin, "kitten");
        writeFileSync(command, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[4], Buffer.from('${png.toString("base64")}', 'base64'));\n`);
        chmodSync(command, 0o700);
        process.env.PATH = `${bin}:${oldPath}`;
        image = captureClipboardImage();
        assert.equal(statSync(image.path).size, png.length);
    } finally {
        process.env.PATH = oldPath;
        if (image) rmSync(image.directory, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
    }
});
