import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { captureClipboardImage } from "./clipboard.mjs";

// Exercise the real installed pi-paster editor and its attachment store, not a
// substitute path-replacement implementation. No terminal or model calls.
const executable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
const require = createRequire(executable);
const root = resolve(dirname(executable), "../..");
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { alias: {
    "@earendil-works/pi-coding-agent": resolve(root, "dist/index.js"),
    "@earendil-works/pi-tui": resolve(root, "node_modules/@earendil-works/pi-tui/dist/index.js"),
} });
const paster = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "npm/node_modules/pi-paster/src");

test("Kitty clipboard image becomes an actual pi-paster attachment without submission", {
    skip: !existsSync(paster) && "install pi-paster before running its integration test",
}, async () => {
    const { PasterEditor } = await jiti.import(join(paster, "editor.ts"));
    const { AttachmentStore } = await jiti.import(join(paster, "store.ts"));
    const { imagesForText } = await jiti.import(join(paster, "image-utils.ts"));
    const { KeybindingsManager } = await jiti.import(resolve(root, "dist/core/keybindings.js"));
    const { default: kittyClipboard } = await jiti.import(fileURLToPath(new URL("./index.ts", import.meta.url)));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
    const store = new AttachmentStore();
    const events = new Map(), commands = new Map();
    let stopped = false;
    const tui = {
        terminal: { rows: 30, columns: 100 }, requestRender() {},
        stop() { stopped = true; }, start() { stopped = false; },
    };
    const editor = new PasterEditor(tui, { borderColor: text => text }, new KeybindingsManager({}), {
        cwd: process.cwd(), store, notify: assert.fail,
        deletePlaceholderAsBlock: true, setCursorPreview() {},
    });
    editor.setText("Explain this: ");
    const env = { TERM: process.env.TERM, KITTY_WINDOW_ID: process.env.KITTY_WINDOW_ID };
    process.env.TERM = "xterm-kitty";
    let sourcePath;
    try {
        kittyClipboard({
            on: (event, handler) => events.set(event, handler), registerShortcut() {},
            registerCommand: (name, value) => commands.set(name, value),
        }, () => captureClipboardImage((_command, args) => {
            assert.equal(stopped, true, "Pi must release terminal input before Kitty reads");
            sourcePath = args[2];
            writeFileSync(sourcePath, png);
            return { status: 0 };
        }));
        await commands.get("kitty-paste").handler("", {
            mode: "tui", ui: {
                notify: assert.fail,
                getEditorText: () => editor.getText(), setEditorText: text => editor.setText(text),
                pasteToEditor: text => editor.handleInput(`\x1b[200~${text}\x1b[201~`),
                custom: (factory, options) => new Promise(resolve => {
                    assert.equal(options.overlay, true);
                    factory(tui, {}, {}, resolve);
                }),
            },
        });
        assert.equal(stopped, false);
        assert.match(editor.getText(), /^Explain this:  \[#image 1\] $/);
        assert.deepEqual(imagesForText(store, editor.getText()), [{ type: "image", mimeType: "image/png", data: png.toString("base64") }]);
        assert.ok(existsSync(sourcePath));
    } finally {
        events.get("session_shutdown")?.();
        for (const [name, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    }
    assert.equal(existsSync(sourcePath), false);
});
