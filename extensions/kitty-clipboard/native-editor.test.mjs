import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureClipboardImage } from "./clipboard.mjs";

const executable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const require = createRequire(executable);
const root = resolve(dirname(executable), "../..");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
    "@earendil-works/pi-coding-agent": resolve(root, "dist/index.js"),
    "@earendil-works/pi-tui": resolve(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
} });

test("real native Pi editor stages a Kitty PNG and attaches it to one submitted input without paster", async () => {
    const { CustomEditor } = await jiti.import(resolve(root, "dist/index.js"));
    const { KeybindingsManager } = await jiti.import(resolve(root, "dist/core/keybindings.js"));
    const { default: kittyClipboard } = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
    const events = new Map(), commands = new Map();
    let stopped = false;
    const tui = { terminal: { rows: 30, columns: 100 }, requestRender() {},
        stop() { stopped = true; }, start() { stopped = false; } };
    const keys = new KeybindingsManager({});
    const editor = new CustomEditor(tui, { borderColor: text => text }, keys);
    editor.setText("Explain this: ");
    // Move to end just as typing would; setText need not place the cursor there.
    editor.handleInput("\x05");
    const env = { TERM: process.env.TERM, KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID };
    process.env.TERM = "xterm-kitty";
    const ctx = { mode: "tui", ui: {
        notify: assert.fail,
        getEditorText: () => editor.getText(), setEditorText: text => editor.setText(text),
        pasteToEditor: text => editor.handleInput(`\x1b[200~${text}\x1b[201~`),
        onTerminalInput: () => () => {},
        setEditorComponent: () => assert.fail("native editor must not be replaced"),
        custom: factory => new Promise(done => factory(tui, {}, keys, done)),
    } };
    try {
        kittyClipboard({
            on: (event, handler) => events.set(event, handler),
            registerCommand: (name, value) => commands.set(name, value),
            sendMessage: () => assert.fail("no preview/follow-up messages"),
            sendUserMessage: () => assert.fail("no automatic submission"),
        }, () => captureClipboardImage((_command, args, options) => {
            assert.equal(stopped, true);
            assert.deepEqual(args, ["clipboard", "--get-clipboard", "--mime", "image/png", "/dev/stdout"]);
            assert.deepEqual(options.stdio, ["inherit", "pipe", "pipe"]);
            return { status: 0, stdout: png };
        }));
        await events.get("session_start")({}, ctx);
        await commands.get("kitty-paste").handler("", ctx);
        assert.equal(stopped, false);
        assert.match(editor.getText(), /^Explain this:  \[#image [a-f0-9]{8}\] $/);
        for (const streamingBehavior of [undefined, "steer", "followUp"]) {
            const result = events.get("input")({ text: editor.getText(), source: "interactive", streamingBehavior }, ctx);
            assert.equal(result.action, "transform");
            assert.equal(result.text, editor.getText());
            assert.deepEqual(result.images, [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
            assert.ok(!result.text.includes("/tmp/") && !result.text.includes("Attached image paths"));
        }
    } finally {
        events.get("session_shutdown")?.();
        for (const [name, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
});
