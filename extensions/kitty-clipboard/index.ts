import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { captureClipboardImage, isKittySession } from "./clipboard.mjs";
import { ClipboardAttachments } from "./attachments.ts";

export default function kittyClipboard(pi: ExtensionAPI,
    captureImage: () => ImageContent | Promise<ImageContent> = captureClipboardImage) {
    const attachments = new ClipboardAttachments();
    let busy = false;
    let host: any;
    let generation = 0;
    let unsubscribe: (() => void) | undefined;

    async function paste(ctx: ExtensionContext) {
        if (ctx.mode !== "tui" || busy) return;
        if (!isKittySession()) {
            ctx.ui.notify("Kitty clipboard paste requires a Kitty terminal (also supported over SSH).", "warning");
            return;
        }
        if (!host) return;
        busy = true;
        const tui = host, started = generation;
        let image: ImageContent;
        try {
            tui.stop();
            try { image = await captureImage(); }
            finally { if (generation === started) tui.start(); }
            if (generation !== started) return;
            const before = ctx.ui.getEditorText();
            const marker = attachments.add(image, before);
            try {
                // The ordinary Pi editor already preserves the cursor and undo
                // history when inserting bracketed paste. No custom editor needed.
                ctx.ui.pasteToEditor(` ${marker} `);
                if (!ctx.ui.getEditorText().includes(marker)) throw new Error("Could not insert the image marker into the draft.");
            } catch (error) {
                attachments.remove(marker);
                ctx.ui.setEditorText(before);
                throw error;
            }
        } catch (error) {
            if (generation === started) ctx.ui.notify(`Kitty clipboard: ${error instanceof Error ? error.message : String(error)}`, "warning");
        } finally {
            if (generation === started) {
                tui.requestRender(true);
                busy = false;
            }
        }
    }

    async function start(_event: unknown, ctx: ExtensionContext) {
        if (busy) host?.start();
        generation++;
        busy = false;
        attachments.clear();
        unsubscribe?.();
        unsubscribe = undefined;
        host = undefined;
        if (ctx.mode !== "tui" || !isKittySession()) return;
        await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
            host = tui;
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
    }
    pi.on("session_start", start);
    pi.on("session_switch", start);
    pi.on("input", (event, ctx) => {
        if (ctx.mode !== "tui" || event.source !== "interactive" || event.text.trimStart().startsWith("!")) return { action: "continue" };
        try {
            const images = attachments.forText(event.text);
            if (!images.length) return { action: "continue" };
            // One user turn owns both the text and bytes, including when queued
            // while busy. Never enqueue a separate preview/follow-up message.
            return { action: "transform", text: event.text, images: [...(event.images ?? []), ...images] };
        } catch (error) {
            if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
            ctx.ui.notify(`Kitty clipboard: ${error instanceof Error ? error.message : String(error)}`, "warning");
            return { action: "handled" };
        }
    });
    pi.registerCommand("kitty-paste", {
        description: "Stage the host clipboard image in this draft without submitting it or creating a file",
        handler: async (_args, ctx) => paste(ctx),
    });
    pi.on("session_shutdown", () => {
        generation++;
        busy = false;
        host = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        attachments.clear();
    });
}
