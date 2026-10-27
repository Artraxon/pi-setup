import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { preserveShellColors } from "./sgr.js";

test("preserves regular, 256-color and truecolor SGR", () => {
    const text = "\x1b[31mred\x1b[0m \x1b[38;5;123m256\x1b[0m \x1b[38:2::1:2:3mrgb\x1b[m";
    assert.equal(preserveShellColors(text), text);
});

test("removes cursor, clipboard, title, device and binary controls", () => {
    assert.equal(preserveShellColors("a\x1b[2J\x1b[H\x1b]52;c;payload\x07\x1b]0;title\x1b\\\x1bPdata\x1b\\\x00b"), "ab");
    assert.equal(preserveShellColors("a\x1b]52;c;\x1b[31msecret\x07b"), "ab");
});

test("patched executor streams colors across chunk boundaries but stores plain output", async () => {
    const executable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
    const dist = resolve(dirname(realpathSync(executable)), "..");
    const { executeBashWithOperations } = await import(pathToFileURL(resolve(dist, "core/bash-executor.js")).href);
    const chunks = [];
    const result = await executeBashWithOperations("unused", process.cwd(), {
        async exec(_command, _cwd, { onData }) {
            for (const text of ["\x1b[3", "1m", "red", "\x1b[0m\n\x1b]52;c;bad\x07"]) onData(Buffer.from(text));
            return { exitCode: 0 };
        },
    }, { onChunk: chunk => chunks.push(chunk) });
    assert.equal(chunks.join(""), "\x1b[31mred\x1b[0m\n");
    assert.equal(result.output, "red\n");
});
