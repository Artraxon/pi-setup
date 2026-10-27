import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("./bridge.py", import.meta.url));
const marker = "pi-zsh:";

export function queryZsh(buffer: string, cwd: string, signal: AbortSignal): Promise<string[]> {
	return new Promise(resolve => {
		if (signal.aborted) { resolve([]); return; }
		const child = spawn("python3", [bridge], { stdio: ["pipe", "pipe", "ignore"] });
		let output = "";
		let settled = false;
		const stop = () => { child.kill("SIGTERM"); finish([]); };
		const timer = setTimeout(stop, 4000);
		const finish = (values: string[]) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", stop);
			resolve(values);
		};
		signal.addEventListener("abort", stop, { once: true });
		child.on("error", () => finish([]));
		child.stdin.on("error", () => {});
		child.stdout.on("data", chunk => {
			output += chunk;
			if (output.length > 2_000_000) stop();
		});
		child.on("close", () => {
			try {
				const parsed = JSON.parse(output);
				finish(Array.isArray(parsed) ? parsed.filter(v => typeof v === "string" && !/[\x00-\x1f\x7f]/.test(v)) : []);
			} catch { finish([]); }
		});
		// Cursor is at end of a single-line command; Zsh counts Unicode characters.
		child.stdin.end(JSON.stringify({ buffer, cursor: [...buffer].length, cwd }));
	});
}

export default function zshCompletion(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let cache: { key: string; time: number; values: string[] } | undefined;
		ctx.ui.addAutocompleteProvider(current => ({
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[0] ?? "";
				const bang = line.startsWith("!!") ? "!!" : "!";
				// Keep unsupported editing contexts on Pi's native completion path.
				if (lines.length !== 1 || cursorLine !== 0 || cursorCol !== line.length || !line.startsWith("!")) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				const buffer = line.slice(bang.length);
				const key = `${ctx.cwd}\0${buffer}`;
				const values = cache?.key === key && Date.now() - cache.time < 1500
					? cache.values : await queryZsh(buffer, ctx.cwd, options.signal);
				if (options.signal.aborted) return null;
				cache = { key, time: Date.now(), values };
				if (!values.length) return current.getSuggestions(lines, cursorLine, cursorCol, options);
				return {
					prefix: line,
					items: values.map(value => ({ value: marker + bang + value, label: value, description: "zsh" })),
				};
			},
			applyCompletion(lines, cursorLine, cursorCol, item: AutocompleteItem, prefix) {
				if (!item.value.startsWith(marker)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				const text = item.value.slice(marker.length);
				return { lines: [text], cursorLine: 0, cursorCol: text.length };
			},
			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
