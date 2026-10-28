import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
	.replace(/^import .*;\n/gm, "")
	.replace("export default function", "function");
class Text {
	text: string;
	constructor(text: string) { this.text = text; }
	render() { return [this.text]; }
}
const { tokenLabel, compactTools } = new Function("stripTerminalSequences", "Text", "truncateToWidth",
	`${stripTypeScriptTypes(source)}\nreturn { tokenLabel, compactTools };`)(
	stripVTControlCharacters, Text, (text: string, width: number, suffix: string) => text.length <= width ? text : text.slice(0, Math.max(0, width - suffix.length)) + suffix.slice(0, width));

const theme = { fg: (_token: string, text: string) => text };
function renderer(name: string, original?: any) {
	let resolver: any;
	compactTools({ registerToolRenderer(fn: any) { resolver = fn; } });
	return resolver(name, () => original);
}

test("token estimates occupy three right-aligned characters without tildes", () => {
	for (const [count, expected] of [
		[0, "  0"], [5, "  5"], [29, " 29"], [679, "679"], [999, "999"],
		[1000, " 1k"], [1200, " 1k"], [2000, " 2k"], [23000, "23k"],
		[99499, "99k"], [99500, ".1M"], [123456, ".1M"], [800000, ".8M"],
		[949999, ".9M"], [950000, " 1M"], [999999, " 1M"],
		[1200000, " 1M"], [20200000, "20M"], [99500000, ".1B"],
		[800000000000, ".8T"], [1200000000000, " 1T"], [Number.MAX_SAFE_INTEGER, " 9Q"],
	] as const) {
		assert.equal(tokenLabel(count), expected, String(count));
		assert.equal(tokenLabel(count).length, 3);
	}
	for (const value of [undefined, null, NaN, Infinity, -1, 1.5, Number.MAX_VALUE]) assert.equal(tokenLabel(value), "  –");
});

test("unit and decimal rounding boundaries never widen the estimate columns", () => {
	for (const scale of [1, 1000, 1000000, 1000000000, 1000000000000]) {
		for (const boundary of [999, 1000, 1500, 99499, 99500, 100000, 800000, 949999, 950000, 999999]) {
			for (const delta of [-1, 0, 1]) {
				const count = Math.floor(boundary * scale) + delta;
				if (!Number.isSafeInteger(count)) continue;
				const label = tokenLabel(count);
				assert.equal(label.length, 3, String(count));
				assert.match(label.trim(), /^(?:\d{1,3}|\d{1,2}[kMBTQ]|\.\d[MBTQ])$/);
			}
		}
	}
});

test("tool names align vertically regardless of input/output estimate size and status", () => {
	const names = ["edit", "bash", "codemode", "read", "write"];
	const inputs = [395, 74, 155, 1200, 20200], outputs = [25, 22, 66, 1200, 20200];
	for (let index = 0; index < names.length; index++) {
		const args = { path: "x".repeat(inputs[index] * 4 - 11) };
		assert.equal(Math.ceil(JSON.stringify(args).length / 4), inputs[index]);
		const context = { expanded: false, isError: index === 1, isPartial: index === 2, state: { outputTokens: outputs[index] } };
		const line = renderer(names[index]).renderCall(args, theme, context).render(120)[0];
		assert.match(line, /^[✓✗…] ↑.{3} ↓.{3} /u);
		assert.equal(line.indexOf(names[index]), 12);
		assert.equal(line.slice(3, 6), tokenLabel(inputs[index]));
		assert.equal(line.slice(8, 11), tokenLabel(outputs[index]));
		assert.ok(!line.includes("~") && !line.includes("·"));
	}
});

test("pending output and live result updates preserve the same tool-name column", () => {
	const tool = renderer("read"), state: Record<string, unknown> = {};
	const call = tool.renderCall({ path: "test.ts" }, theme, { expanded: false, isPartial: true, state });
	assert.equal(call.render(120)[0].slice(8, 11), "  –");
	assert.equal(call.render(120)[0].indexOf("read"), 12);
	const result = tool.renderResult({ content: [{ type: "text", text: "x".repeat(4800) }] }, { expanded: false }, theme, { state });
	assert.deepEqual(result.render(120), []);
	assert.equal(call.render(120)[0].slice(8, 11), " 1k");
	assert.equal(call.render(120)[0].indexOf("read"), 12);
	assert.equal(call.render(10)[0].length, 10);
});

test("expanded calls/results continue using the original renderer", () => {
	const originalCall = { render: () => ["Original call"] }, originalResult = { render: () => ["Original result"] };
	const tool = renderer("edit", { renderCall: () => originalCall, renderResult: () => originalResult });
	assert.equal(tool.renderCall({}, theme, { expanded: true }), originalCall);
	assert.equal(tool.renderResult({ content: [] }, { expanded: true }, theme, { state: {} }), originalResult);
});
