import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 64 * 1024 * 1024; // pi-paster's input limit

export function isKittySession(env = process.env) {
    return env.TERM === "xterm-kitty" || Boolean(env.KITTY_WINDOW_ID);
}

// Must run with Pi's terminal stopped: kitten needs exclusive access to the
// controlling TTY to exchange clipboard protocol messages with the host Kitty.
export function captureClipboardImage(run = spawnSync) {
    const directory = mkdtempSync(join(tmpdir(), "pi-kitty-clipboard-"));
    const path = join(directory, "clipboard.png");
    try {
        const result = run("kitten", ["clipboard", "--get-clipboard", path], {
            stdio: "inherit",
            timeout: 30_000,
            killSignal: "SIGKILL",
        });
        if (result.error?.code === "ENOENT") {
            throw new Error("kitten is not on the remote PATH. Connect using Kitty's SSH kitten or install kitten remotely.");
        }
        if (result.error?.code === "ETIMEDOUT") {
            throw new Error("Clipboard request timed out. Allow the clipboard request in Kitty and try again.");
        }
        if (result.error) throw result.error;
        if (result.status !== 0) {
            throw new Error("Could not read a clipboard image. Copy an image on the host and allow Kitty's clipboard-access prompt, then retry Ctrl+V.");
        }
        const info = statSync(path);
        if (!info.isFile() || info.size <= PNG_SIGNATURE.length || info.size > MAX_IMAGE_BYTES) {
            throw new Error("Clipboard image is empty or exceeds the 64 MiB attachment limit.");
        }
        const header = Buffer.alloc(PNG_SIGNATURE.length);
        const fd = openSync(path, "r");
        try {
            readSync(fd, header, 0, header.length, 0);
        } finally {
            closeSync(fd);
        }
        if (!header.equals(PNG_SIGNATURE)) throw new Error("Kitty did not return a PNG image.");
        chmodSync(path, 0o600);
        return { directory, path };
    } catch (error) {
        rmSync(directory, { recursive: true, force: true });
        throw error;
    }
}
