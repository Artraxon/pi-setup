import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rmSync } from "node:fs";
import { captureClipboardImage, isKittySession } from "./clipboard.mjs";

export default function kittyClipboard(pi: ExtensionAPI, captureImage = captureClipboardImage) {
    const directories = new Set<string>();
    let busy = false;
    let unsubscribe: (() => void) | undefined;

    async function paste(ctx: ExtensionContext) {
        if (ctx.mode !== "tui" || busy) return;
        if (!isKittySession()) {
            ctx.ui.notify("Kitty clipboard paste requires a Kitty terminal (also supported over SSH).", "warning");
            return;
        }
        busy = true;
        let image: { directory: string; path: string } | undefined;
        let redraw: (() => void) | undefined;
        try {
            await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
                redraw = () => tui.requestRender(true);
                tui.stop();
                try {
                    image = captureImage();
                } finally {
                    tui.start();
                    tui.requestRender(true);
                }
                done(undefined);
                return { render: () => [], invalidate() {} };
            }, { overlay: true }); // Do not reset the draft or cursor on completion.
            if (!image) return;
            const before = ctx.ui.getEditorText();
            // Paste handling in PasterEditor reads the file synchronously into
            // its attachment store, replacing this path with [#image N].
            ctx.ui.pasteToEditor(` "${image.path}" `);
            const after = ctx.ui.getEditorText();
            if (after.includes(image.path) || after === before) {
                ctx.ui.setEditorText(before);
                throw new Error("pi-paster did not attach the image. Ensure npm:pi-paster@0.2.3 is enabled, then restart Pi.");
            }
            // Keep the source available for pi-paster's image-path metadata and
            // tools during this runtime; embedded image content survives cleanup.
            directories.add(image.directory);
            image = undefined;
        } catch (error) {
            ctx.ui.notify(`Kitty clipboard: ${error instanceof Error ? error.message : String(error)}`, "warning");
        } finally {
            if (image) rmSync(image.directory, { recursive: true, force: true });
            // pasteToEditor does not schedule a render; the resume render can
            // finish before the await continuation inserts the attachment.
            redraw?.();
            busy = false;
        }
    }

    pi.on("session_start", async (_event, ctx) => {
        unsubscribe?.();
        unsubscribe = undefined;
        if (ctx.mode !== "tui" || !isKittySession()) return;
        await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
            // Use the configured native paste action rather than registering a
            // competing shortcut. Only app editors expose an image-paste handler;
            // ordinary dialogs and attached PTYs retain their own input.
            unsubscribe = ctx.ui.onTerminalInput(data => {
                if (!keybindings.matches(data, "app.clipboard.pasteImage")) return;
                const focused = tui.getFocusedComponent() as { onPasteImage?: unknown } | null;
                if (typeof focused?.onPasteImage !== "function") return;
                void paste(ctx);
                return { consume: true };
            });
            done(undefined);
            return { render: () => [], invalidate() {} };
        }, { overlay: true });
    });
    pi.registerCommand("kitty-paste", {
        description: "Attach the host clipboard image through Kitty without submitting the prompt",
        handler: async (_args, ctx) => paste(ctx),
    });
    pi.on("session_shutdown", () => {
        unsubscribe?.();
        unsubscribe = undefined;
        for (const directory of directories) rmSync(directory, { recursive: true, force: true });
        directories.clear();
    });
}
