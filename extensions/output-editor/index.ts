import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

type Block = { type: string; text?: string };
function textContent(content: string | Block[]): string {
	return typeof content === "string" ? content : content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n\n");
}

type Rect = { x: number; y: number; width: number; height: number };
type Box = { rect: Rect; clip: Rect; component: any; children: Box[]; lineOffset?: number };
type RawMouse = { x: number; y: number; button: number; release: boolean };
// Pi has no public transcript hit-test API. Keep the internal bridge isolated.
type Host = {
	currentLayout?: { root: Box };
	handleMouseEvent?: (event: RawMouse) => void;
	stop(): void;
	start(): void;
	requestRender(force?: boolean): void;
};

function componentText(component: any, y: number, width: number): string | undefined {
	if (typeof component.toolCallId === "string") {
		return component.result ? textContent(component.result.content) : undefined;
	}
	if (component.lastMessage?.role === "assistant") return textContent(component.lastMessage.content);
	if (component.constructor?.name === "UserMessageComponent") return component.text;
	// Ordinary Containers are opaque to Pi's layout tree. Their cached mouse
	// layout retains full-content heights, including offscreen/scrolled rows.
	const children = component.mouseLayout?.width === width
		? component.mouseLayout.children
		: (component.children ?? []).map((child: any) => ({ component: child, height: child.render(width).length }));
	let top = 0;
	for (const child of children) {
		if (y >= top && y < top + child.height) return componentText(child.component, y - top, width);
		top += child.height;
	}
}

export function clickedText(root: Box, x: number, y: number): string | undefined {
	const rect = root.clip;
	if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) return;
	if (root.children.length === 0) {
		return componentText(root.component, y - root.rect.y + (root.lineOffset ?? 0), root.rect.width);
	}
	for (const child of root.children) {
		const text = clickedText(child, x, y);
		if (text !== undefined) return text;
	}
}

export default function outputEditor(pi: ExtensionAPI) {
	let host: Host | undefined;
	let armed = false;
	let editing = false;
	let cleanup: (() => void) | undefined;

	function cancel(ctx: ExtensionContext) {
		armed = false;
		ctx.ui.setStatus("output-editor", undefined);
	}

	async function edit(text: string, ctx: ExtensionContext) {
		if (!host || editing) return;
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the agent to finish before opening the editor.", "warning");
			return;
		}
		editing = true;
		let directory: string | undefined;
		const tui = host;
		try {
			directory = await mkdtemp(join(tmpdir(), "pi-output-"));
			const path = join(directory, "response.md");
			await writeFile(path, text, { mode: 0o600 });
			tui.stop();
			try {
				const code = await new Promise<number | null>((resolve, reject) => {
					const command = process.env.VISUAL || process.env.EDITOR || "vim";
					const child = spawn(`${command} "$PI_OUTPUT_EDITOR_FILE"`, {
						shell: true, stdio: "inherit", env: { ...process.env, PI_OUTPUT_EDITOR_FILE: path },
					});
					child.on("error", reject);
					child.on("exit", resolve);
				});
				if (code === 0) ctx.ui.setEditorText(await readFile(path, "utf8"));
			} finally {
				tui.start();
				tui.requestRender(true);
			}
		} catch (error) {
			ctx.ui.notify(`Output editor: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			editing = false;
			if (directory) await rm(directory, { recursive: true, force: true });
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget("output-editor-bridge", tui => {
			cleanup?.();
			host = tui as unknown as Host;
			const target = host;
			const previous = target.handleMouseEvent;
			let press: { x: number; y: number } | undefined;
			const handler = (event: RawMouse) => {
				if (!armed || (event.button & 64) !== 0) return previous?.call(target, event);
				if ((event.button & 3) !== 0) return;
				if (!event.release && !(event.button & 32)) press = { x: event.x, y: event.y };
				if (!event.release) return;
				if (!press || press.x !== event.x || press.y !== event.y) { press = undefined; return; }
				press = undefined;
				const text = target.currentLayout && clickedText(target.currentLayout.root, event.x, event.y);
				if (text === undefined) {
					ctx.ui.notify("Click an assistant, user, or completed tool block; Escape cancels.", "info");
					return;
				}
				cancel(ctx);
				// Leave mouse dispatch before stopping the TUI for Vim.
				setTimeout(() => void edit(text, ctx), 0);
			};
			if (previous) target.handleMouseEvent = handler;
			const unsubscribe = ctx.ui.onTerminalInput(data => {
				if (armed && matchesKey(data, "escape")) { cancel(ctx); return { consume: true }; }
			});
			cleanup = () => {
				unsubscribe();
				if (target.handleMouseEvent === handler) target.handleMouseEvent = previous;
				cancel(ctx);
			};
			return { render: () => [], invalidate() {} };
		});
	});
	pi.on("session_shutdown", () => { cleanup?.(); cleanup = undefined; host = undefined; });

	pi.registerShortcut("alt+g", {
		description: "Edit the latest assistant response into the prompt",
		handler: async ctx => {
			if (ctx.mode !== "tui") return;
			cancel(ctx);
			const branch = ctx.sessionManager.getBranch();
			for (let index = branch.length - 1; index >= 0; index--) {
				const entry = branch[index];
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const text = textContent(entry.message.content);
				if (text.trim()) { await edit(text, ctx); return; }
			}
			ctx.ui.notify("No assistant response to edit yet.", "info");
		},
	});
	pi.registerShortcut("ctrl+alt+g", {
		description: "Pick a transcript block to edit into the prompt",
		handler: async ctx => {
			if (ctx.mode !== "tui" || !host?.handleMouseEvent) {
				ctx.ui.notify("Block picking requires Pi fullscreen mode.", "warning");
				return;
			}
			armed = !armed;
			ctx.ui.setStatus("output-editor", armed ? "Click a block to edit · Esc cancels" : undefined);
		},
	});
}
