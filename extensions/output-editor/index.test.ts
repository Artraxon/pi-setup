import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

// Exercise hit testing without loading Pi's interactive runtime.
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
	.replace(/^import .*;\n/gm, "")
	.replace("export function clickedText", "function clickedText")
	.replace("export default function", "function");
const clickedText = new Function(`${stripTypeScriptTypes(source)}\nreturn clickedText;`)();
const rect = { x: 0, y: 0, width: 80, height: 10 };

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
