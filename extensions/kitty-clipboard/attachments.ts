import type { ImageContent } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { MAX_IMAGE_BYTES } from "./clipboard.mjs";

const markers = () => /\[#image [a-f0-9]{8}\]/g;

/** Draft attachments only: no files, editor replacement or transcript messages. */
export class ClipboardAttachments {
    private images = new Map<string, ImageContent>();

    add(image: ImageContent, draft: string): string {
        // Reclaim deleted/submitted attachments on the next paste. Queued turns
        // already own their image content; draft cancellation still works until then.
        const referenced = new Set(draft.match(markers()) ?? []);
        for (const marker of this.images.keys()) if (!referenced.has(marker)) this.images.delete(marker);
        const bytes = (value: ImageContent) => Buffer.byteLength(value.data, "base64");
        const total = [...this.images.values()].reduce((sum, value) => sum + bytes(value), bytes(image));
        if (this.images.size >= 32 || total > MAX_IMAGE_BYTES) throw new Error("Draft images exceed the 32-image / 64 MiB limit. Remove an image marker and retry.");
        let marker: string;
        do { marker = `[#image ${randomUUID().slice(0, 8)}]`; } while (this.images.has(marker) || draft.includes(marker));
        this.images.set(marker, image);
        return marker;
    }

    forText(text: string): ImageContent[] {
        const result: ImageContent[] = [];
        for (const marker of new Set(text.match(markers()) ?? [])) {
            const image = this.images.get(marker);
            if (!image) throw new Error("A clipboard image is no longer staged (for example, after reload). Remove its marker or paste the image again.");
            result.push(image);
        }
        return result;
    }

    remove(marker: string) { this.images.delete(marker); }
    clear() { this.images.clear(); }
}
