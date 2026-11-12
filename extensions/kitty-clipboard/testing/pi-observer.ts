// Test-only observer: real Pi editor/input pipeline, with all model calls intercepted.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";

export default function observer(pi: ExtensionAPI) {
    const submissions: Array<{ text: string; images: Array<{ mimeType: string; bytes: number; sha256: string }> }> = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    let restoreWrite: (() => void) | undefined;
    let reads = 0, altExits = 0;
    const statePath = process.env.PI_CLIPBOARD_TEST_STATE!;
    let snapshot = () => {};

    pi.on("session_start", async (_event, ctx) => {
        if (ctx.mode !== "tui") throw new Error("Clipboard integration tests require a real Pi TUI");
        await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
            const terminal = tui.terminal;
            const write = terminal.write;
            terminal.write = function(data: string) {
                if (data.includes("\x1b]5522;type=read")) reads++;
                if (data.includes("\x1b[?1049l")) altExits++;
                write.call(this, data);
            };
            restoreWrite = () => { terminal.write = write; };
            done(undefined);
            return { render: () => [], invalidate() {} };
        }, { overlay: true });
        ctx.ui.setEditorText("Explain this: ");
        snapshot = () => {
            const state = {
                draft: ctx.ui.getEditorText(), submissions, reads, altExits,
                path: process.env.PATH, display: process.env.DISPLAY ?? null,
                wayland: process.env.WAYLAND_DISPLAY ?? null, isTTY: process.stdin.isTTY,
                ssh: Boolean(process.env.SSH_CONNECTION),
            };
            writeFileSync(`${statePath}.tmp`, JSON.stringify(state));
            renameSync(`${statePath}.tmp`, statePath);
        };
        snapshot();
        timer = setInterval(snapshot, 25);
    });

    // Loaded after kitty-clipboard: this sees the transformed input, then handles
    // it locally. No provider, credentials, network request or paid tokens needed.
    pi.on("input", event => {
        submissions.push({ text: event.text, images: (event.images ?? []).map(image => {
            const bytes = Buffer.from(image.data, "base64");
            return { mimeType: image.mimeType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        }) });
        snapshot();
        return { action: "handled" };
    });
    pi.on("before_agent_start", () => { throw new Error("Test attempted to call a model"); });
    pi.on("session_shutdown", () => {
        clearInterval(timer);
        restoreWrite?.();
    });
}
