import { spawnSync } from "node:child_process";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export function isKittySession(env = process.env) {
    return env.TERM === "xterm-kitty" || Boolean(env.KITTY_WINDOW_ID);
}

// Kitty exchanges protocol messages through the controlling TTY. Pi must be
// stopped, but the image bytes and helper diagnostics must never reach its UI.
/** @returns {import('@earendil-works/pi-ai').ImageContent} */
export function captureClipboardImage(run = spawnSync) {
    const result = run("kitten", ["clipboard", "--get-clipboard", "--mime", "image/png", "/dev/stdout"], {
        stdio: ["inherit", "pipe", "pipe"],
        maxBuffer: MAX_IMAGE_BYTES,
        timeout: 30_000,
        killSignal: "SIGKILL",
    });
    if (result.error?.code === "ENOENT") {
        throw new Error("kitten is not on the remote PATH. Connect using Kitty's SSH kitten or install kitten remotely.");
    }
    if (result.error?.code === "ETIMEDOUT") {
        throw new Error("Clipboard request timed out. Allow the clipboard request in Kitty and try again.");
    }
    if (result.error?.code === "ENOBUFS") throw new Error("Clipboard image exceeds the 64 MiB attachment limit.");
    if (result.error) throw new Error("Could not read the clipboard image.");
    if (result.status !== 0) {
        throw new Error("Could not read a clipboard image. Copy an image on the host and allow Kitty's clipboard-access prompt, then retry Ctrl+V.");
    }
    const bytes = result.stdout;
    if (!Buffer.isBuffer(bytes) || bytes.length <= PNG_SIGNATURE.length) throw new Error("Clipboard image is empty or not a PNG image.");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Clipboard image exceeds the 64 MiB attachment limit.");
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error("Kitty did not return a PNG image.");
    return { type: "image", mimeType: "image/png", data: bytes.toString("base64") };
}
