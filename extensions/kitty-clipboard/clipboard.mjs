import { randomUUID } from "node:crypto";

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const OSC_PREFIX = "\x1b]5522;";
const ST = "\x1b\\";
const ID_PREFIX = "pi-clipboard.";
const MAX_FRAME_CHARS = 8192;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function isKittySession(env = process.env) {
    return env.TERM === "xterm-kitty" || Boolean(env.KITTY_WINDOW_ID);
}

function decodeBase64(value) {
    // Terminal replies are a wire boundary. Node's decoder otherwise silently
    // accepts corrupt characters, missing padding and non-canonical encodings.
    if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Invalid base64 in Kitty clipboard response.");
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("Invalid base64 in Kitty clipboard response.");
    return bytes;
}

function matchesImageType(bytes, mime) {
    if (mime === "image/png") return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (mime === "image/jpeg") return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (mime === "image/gif") return bytes.length > 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
    return bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

/** OSC 5522 read transport. All I/O uses Pi's terminal and input hook, never a subprocess. */
export class KittyClipboardReader {
    constructor(write, { timeoutMs = 30_000, maxBytes = MAX_IMAGE_BYTES } = {}) {
        this.write = write;
        this.timeoutMs = timeoutMs;
        this.maxBytes = maxBytes;
        this.prefix = `${ID_PREFIX}${randomUUID()}.`;
        this.nextId = 0;
        this.pending = undefined;
        this.reading = false;
        this.disposed = false;
        this.frame = "";
        this.discardingFrame = false;
    }

    /**
     * Read one supported image, choosing PNG first. Only invoked by a user action.
     * @returns {Promise<{ type: "image", mimeType: string, data: string }>}
     */
    async readImage() {
        if (this.reading) throw new Error("A Kitty clipboard request is already in progress.");
        this.reading = true;
        try {
            const types = (await this.request(".", 16 * 1024)).toString("utf8").trim().split(/\s+/);
            const mimeType = IMAGE_TYPES.find(type => types.includes(type));
            if (!mimeType) throw new Error("Clipboard has no supported image. Copy an image, rather than text or a file reference.");
            const bytes = await this.request(mimeType, this.maxBytes);
            if (!bytes.length || !matchesImageType(bytes, mimeType)) throw new Error("Clipboard image is empty or does not match its MIME type.");
            return { type: "image", mimeType, data: bytes.toString("base64") };
        } finally {
            this.reading = false;
        }
    }

    /** @returns {Promise<Buffer>} */
    request(mime, limit) {
        if (this.disposed) return Promise.reject(new Error("Kitty clipboard request cancelled."));
        return new Promise((resolve, reject) => {
            const id = `${this.prefix}${this.nextId++}`;
            const timer = setTimeout(() => this.finish(new Error("Clipboard request timed out. Allow Kitty's clipboard request, or check OSC 5522 support.")), this.timeoutMs);
            this.pending = { id, mime, limit, chunks: [], bytes: 0, started: false, resolve, reject, timer };
            try {
                this.write(`${OSC_PREFIX}type=read:id=${id}:name=${Buffer.from("Pi clipboard").toString("base64")};${Buffer.from(mime).toString("base64")}${ST}`);
            } catch {
                this.finish(new Error("Could not send the Kitty clipboard request."));
            }
        });
    }

    finish(error) {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (error) pending.reject(error);
        else pending.resolve(Buffer.concat(pending.chunks, pending.bytes));
    }

    /** Filter only clipboard packets; return other input unchanged, including other clients' replies. */
    handleInput(data) {
        if (this.disposed) return undefined;
        // Pi frames complete OSC strings, but can flush a slow, unrecognised OSC
        // as Alt+] followed by characters. Reassemble that path as well, without
        // adding a competing stdin listener or extending Pi's keyboard timeout.
        if (!this.frame && !this.discardingFrame) {
            const partialReply = this.pending && data.length >= 1 && OSC_PREFIX.startsWith(data);
            if (!data.startsWith(OSC_PREFIX) && !partialReply) return undefined;
        }
        const combined = this.frame + data;
        this.frame = "";
        if (!this.discardingFrame && !combined.startsWith(OSC_PREFIX)) {
            if (OSC_PREFIX.startsWith(combined)) {
                this.frame = combined;
                return { consume: true };
            }
            return { data: combined };
        }
        const terminator = /\x1b\\|\x07/.exec(combined);
        if (!terminator) {
            if (combined.length > MAX_FRAME_CHARS) {
                this.discardingFrame = true;
                this.finish(new Error("Kitty clipboard response packet is too large."));
            }
            this.frame = this.discardingFrame ? (combined.endsWith("\x1b") ? "\x1b" : "") : combined;
            return { consume: true };
        }
        const end = terminator.index + terminator[0].length;
        const rest = combined.slice(end);
        let owned = this.discardingFrame;
        this.discardingFrame = false;
        if (!owned) owned = this.receive(combined.slice(OSC_PREFIX.length, terminator.index));
        let forwarded = owned ? "" : combined.slice(0, end);
        if (rest) {
            const result = this.handleInput(rest);
            if (!result?.consume) forwarded += result?.data ?? rest;
        }
        return forwarded ? { data: forwarded } : { consume: true };
    }

    receive(body) {
        const separator = body.indexOf(";");
        const header = separator < 0 ? body : body.slice(0, separator);
        const payload = separator < 0 ? "" : body.slice(separator + 1);
        const pairs = header.split(":").map(pair => {
            const equal = pair.indexOf("=");
            return [pair.slice(0, equal), pair.slice(equal + 1)];
        });
        const metadata = new Map(pairs);
        // Also swallow late replies from earlier requests or extension instances.
        // The namespace is ours, but a response ID is correlation, not authentication.
        const id = metadata.get("id");
        const pending = this.pending;
        if (!id && pending && metadata.get("type") === "read") {
            this.finish(new Error("Kitty clipboard response is missing its request ID."));
            return true;
        }
        if (!id?.startsWith(ID_PREFIX)) return false;
        if (!pending || id !== pending.id) return true;
        try {
            if (metadata.get("type") !== "read" || body.length > MAX_FRAME_CHARS || pairs.length !== metadata.size ||
                header.split(":").some(pair => !/^[a-z]+=[^\x00-\x20\x7f]*$/.test(pair))) {
                throw new Error("Malformed Kitty clipboard response.");
            }
            const status = metadata.get("status");
            if (status !== "DATA" && payload) throw new Error("Unexpected payload in Kitty clipboard response.");
            if (status === "OK" && !pending.started) {
                pending.started = true;
            } else if (status === "DATA" && pending.started) {
                if (decodeBase64(metadata.get("mime") ?? "").toString("utf8") !== pending.mime) throw new Error("Unexpected clipboard MIME type.");
                const chunk = decodeBase64(payload);
                if (chunk.length > 4096) throw new Error("Kitty clipboard response chunk exceeds 4096 bytes.");
                pending.bytes += chunk.length;
                if (pending.bytes > pending.limit) throw new Error("Clipboard data exceeds the attachment size limit.");
                pending.chunks.push(chunk);
            } else if (status === "DONE" && pending.started) {
                this.finish();
            } else {
                const errors = {
                    EPERM: "Permission to read the clipboard was denied.",
                    ENOSYS: "Kitty clipboard access is unavailable.",
                    EBUSY: "The terminal clipboard is busy. Try again.",
                };
                throw new Error(Object.hasOwn(errors, status) ? errors[status] : "Unexpected Kitty clipboard response.");
            }
        } catch (error) {
            this.finish(error);
        }
        return true;
    }

    /** Cancel outstanding work when the session is replaced or the extension is unloaded. */
    dispose() {
        this.disposed = true;
        this.finish(new Error("Kitty clipboard request cancelled."));
        this.frame = "";
    }
}
