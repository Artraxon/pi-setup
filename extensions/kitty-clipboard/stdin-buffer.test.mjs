import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { KittyClipboardReader } from "./clipboard.mjs";

const executable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const require = createRequire(executable);
const root = resolve(dirname(executable), "../..");
const { StdinBuffer } = require(resolve(root, "node_modules/@earendil-works/pi-tui/dist/stdin-buffer.js"));

test("installed Pi input parser plus extension handles replies delayed beyond the keyboard timeout", async () => {
    const requests = [];
    const reader = new KittyClipboardReader(request => requests.push(request));
    const buffer = new StdinBuffer({ timeout: 10 });
    const editorInput = [];
    buffer.on("data", data => {
        const result = reader.handleInput(data);
        if (!result?.consume) editorInput.push(result?.data ?? data);
    });
    const image = reader.readImage();
    const respond = async (mime, bytes) => {
        const id = /:id=([^:;]+)/.exec(requests.at(-1))[1];
        const frames = [
            `\x1b]5522;type=read:id=${id}:status=OK\x1b\\`,
            `\x1b]5522;type=read:id=${id}:status=DATA:mime=${Buffer.from(mime).toString("base64")};${bytes.toString("base64")}\x1b\\`,
            `\x1b]5522;type=read:id=${id}:status=DONE\x1b\\`,
        ];
        for (const frame of frames) {
            buffer.process(frame.slice(0, 1));
            await delay(30); // Beyond Pi's separate lone-ESC deadline too.
            buffer.process(frame.slice(1, 18));
            await delay(30);
            buffer.process(frame.slice(18, -1));
            await delay(30);
            buffer.process(frame.slice(-1));
        }
    };
    try {
        await respond(".", Buffer.from("image/png"));
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(256)]);
        await respond("image/png", png);
        assert.equal((await image).data, png.toString("base64"));
        assert.deepEqual(editorInput, [], "no protocol headers, payload or terminators may reach the editor");
        buffer.process("typing still works");
        assert.equal(editorInput.join(""), "typing still works");
    } finally {
        buffer.destroy();
        reader.dispose();
    }
});
