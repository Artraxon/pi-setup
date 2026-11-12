import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { KittyClipboardReader, isKittySession } from "./clipboard.mjs";
import { ClipboardAttachments } from "./attachments.ts";

export default function kittyClipboard(pi: ExtensionAPI,
    captureImage?: () => ImageContent | Promise<ImageContent>) {
    const attachments = new ClipboardAttachments();
    let busy = false;
    let host: TUI | undefined;
    let reader: KittyClipboardReader | undefined;
    let generation = 0;
    let unsubscribe: (() => void) | undefined;

    async function paste(ctx: ExtensionContext) {
        if (ctx.mode !== "tui" || busy) return;
        if (!isKittySession()) {
            ctx.ui.notify("Kitty clipboard paste requires a Kitty terminal (also supported over SSH).", "warning");
            return;
        }
        if (!host || !reader) return;
        busy = true;
        const tui = host, activeReader = reader, started = generation, focused = tui.getFocusedComponent();
        let image: ImageContent;
        try {
            image = await (captureImage ? captureImage() : activeReader.readImage());
            if (generation !== started) return;
            if (tui.getFocusedComponent() !== focused) throw new Error("Editor focus changed while reading the clipboard. Paste again in the editor.");
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
                tui.requestRender();
                busy = false;
            }
        }
    }

    async function start(_event: unknown, ctx: ExtensionContext) {
        generation++;
        reader?.dispose();
        reader = undefined;
        busy = false;
        attachments.clear();
        unsubscribe?.();
        unsubscribe = undefined;
        host = undefined;
        if (ctx.mode !== "tui" || !isKittySession()) return;
        await ctx.ui.custom<void>((tui, _theme, keybindings, done) => {
            host = tui;
            reader = new KittyClipboardReader(data => tui.terminal.write(data));
            unsubscribe = ctx.ui.onTerminalInput(data => {
                const response = reader?.handleInput(data);
                if (response) return response;
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
        if (busy) {
            if (!ctx.ui.getEditorText()) ctx.ui.setEditorText(event.text);
            ctx.ui.notify("Wait for the clipboard image before submitting the draft.", "warning");
            return { action: "handled" };
        }
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
        reader?.dispose();
        reader = undefined;
        busy = false;
        host = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        attachments.clear();
    });
}
