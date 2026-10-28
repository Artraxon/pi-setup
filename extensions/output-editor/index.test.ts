import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";

// Exercise hit testing without loading Pi's interactive runtime.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
	.replace(/^import .*;\n/gm, "")
	.replace("export function clickedText", "function clickedText")
	.replace("export default function", "function");
const clickedText = new Function(`${stripTypeScriptTypes(source)}\nreturn clickedText;`)();
const rect = { x: 0, y: 0, width: 80, height: 10 };
const latestCompleteResponse = new Function(`${stripTypeScriptTypes(source)}\nreturn latestCompleteResponse;`)();

const assistant = (text: string, stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });

test("latest response skips streaming, aborted, truncated and tool-call preambles", () => {
	const complete = assistant("Last full response");
	assert.equal(latestCompleteResponse([complete, assistant("Preamble", "toolUse"), assistant("Streaming", "pending"), assistant("Partial", "aborted"), assistant("Cut off", "length")]), "Last full response");
	assert.equal(latestCompleteResponse([assistant("Streaming", "pending")]), undefined);
	assert.equal(latestCompleteResponse([complete, { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }]), "Last full response");
});

test("Alt+G opens the last full response while busy, pauses only the TUI and prefills without submission", async () => {
	const events = new Map(), shortcuts = new Map(), notices: string[] = [];
	let stopped = 0, started = 0, rendered = 0, draft = "", opened = "";
	const factory = new Function("mkdtemp", "readFile", "rm", "writeFile", "tmpdir", "join", "spawn", `${stripTypeScriptTypes(source)}\nreturn outputEditor;`)(
		mkdtemp, readFile, rm, writeFile, tmpdir, join, (_command: string, options: any) => {
			const child = new EventEmitter();
			setImmediate(async () => {
				opened = await readFile(options.env.PI_OUTPUT_EDITOR_FILE, "utf8");
				await writeFile(options.env.PI_OUTPUT_EDITOR_FILE, "Edited draft");
				child.emit("exit", 0);
			});
			return child;
		});
	factory({ on: (name: string, fn: any) => events.set(name, fn), registerShortcut: (name: string, value: any) => shortcuts.set(name, value) });
	const host = { stop() { stopped++; }, start() { started++; }, requestRender() { rendered++; } };
	const ctx = { mode: "tui", isIdle: () => false, sessionManager: { getBranch: () => [assistant("Last full response"), assistant("Still streaming", "pending")] },
		ui: { setStatus() {}, setWidget(_key: string, factory: any) { factory(host); }, onTerminalInput: () => () => {},
			notify(message: string) { notices.push(message); }, setEditorText(text: string) { draft = text; } } };
	events.get("session_start")({}, ctx);
	await shortcuts.get("alt+g").handler(ctx);
	assert.equal(opened, "Last full response");
	assert.equal(draft, "Edited draft");
	assert.equal(stopped, 1); assert.equal(started, 1); assert.equal(rendered, 1);
	assert.deepEqual(notices, []);
	events.get("session_shutdown")();
});

test("selects complete tool output through an opaque, scrolled Container", () => {
	const tool = { toolCallId: "call-1", result: { content: [{ type: "text", text: "full\noutput\nnot just the summary" }] } };
	const component = { mouseLayout: { width: 80, children: [
		{ component: {}, height: 20 }, { component: tool, height: 2 },
	] } };
	const box = { rect: { ...rect, y: -20, height: 22 }, clip: rect, component, children: [] };
	assert.equal(clickedText(box, 3, 1), "full\noutput\nnot just the summary");
	assert.equal(clickedText(box, 90, 1), undefined);
});

test("selects assistant prose without thinking or tool calls", () => {
	const component = { lastMessage: { role: "assistant", content: [
		{ type: "thinking", text: "hidden" }, { type: "text", text: "response" },
	] } };
	assert.equal(clickedText({ rect, clip: rect, component, children: [] }, 1, 1), "response");
});
