// Deterministic local model and gated tools for real-terminal compact-view tests.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, Type } from "@earendil-works/pi-ai";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export default function scenario(pi: ExtensionAPI) {
	const root = process.env.PI_COMPACT_TEST_ROOT!;
	const record = (name: string, value: unknown) => {
		const path = join(root, name);
		writeFileSync(`${path}.tmp`, JSON.stringify(value));
		renameSync(`${path}.tmp`, path);
	};
	const wait = async (name: string, signal?: AbortSignal) => {
		while (!existsSync(join(root, name))) await delay(30, undefined, { signal });
	};
	let requests = 0;
	pi.registerProvider("compact-e2e", {
		baseUrl: "http://127.0.0.1:1/not-used",
		apiKey: "local-test-only",
		api: "openai-completions",
		models: [{ id: "scenario", name: "Local TUI scenario", reasoning: true, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple(model, _context, options) {
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
				timestamp: Date.now(), stopReason: "stop", content: [], usage: { input: 0, output: 0, cacheRead: 0,
					cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			const request = ++requests;
			record("requests.json", { requests });
			void (async () => {
				try {
					stream.push({ type: "start", partial: message });
					if (request === 1) {
						if (process.env.PI_COMPACT_TEST_WAIT_FOR_PROVIDER) {
							record("phase.json", { phase: "waiting" });
							await wait("begin-thinking", options?.signal);
						}
						const title = process.env.PI_COMPACT_TEST_MARKDOWN_REASONING
							? "**E2E inspecting the workspace** and `formatting`" : "E2E inspecting the workspace";
						const thinking = title + (process.env.PI_COMPACT_TEST_LONG_REASONING ? ` ${"界🙂".repeat(60)}` : "");
						message.content.push({ type: "thinking", thinking });
						stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: thinking, partial: message });
						record("phase.json", { phase: "thinking" });
						await wait("continue-thinking", options?.signal);
						const second = "\n\nE2E preparing the changes";
						message.content[0].thinking += second;
						stream.push({ type: "thinking_delta", contentIndex: 0, delta: second, partial: message });
						record("phase.json", { phase: "thinking-second" });
						await wait("continue-tools", options?.signal);
						stream.push({ type: "thinking_end", contentIndex: 0, content: message.content[0].thinking, partial: message });
						const text = "E2E response before tools.";
						message.content.push({ type: "text", text });
						stream.push({ type: "text_start", contentIndex: 1, partial: message });
						stream.push({ type: "text_delta", contentIndex: 1, delta: text, partial: message });
						stream.push({ type: "text_end", contentIndex: 1, content: text, partial: message });
						for (const name of ["alpha", "beta"]) {
							const index = message.content.length;
							const toolCall = { type: "toolCall" as const, id: `e2e-${name}`, name: "e2e_work", arguments: { name } };
							message.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
							stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
						}
						message.stopReason = "toolUse";
					} else {
						const text = "E2E final response.";
						message.content.push({ type: "text", text });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
					}
					stream.push({ type: "done", reason: message.stopReason, message });
					stream.end();
				} catch (error) {
					message.stopReason = options?.signal?.aborted ? "aborted" : "error";
					message.errorMessage = String(error);
					stream.push({ type: "error", reason: message.stopReason, error: message });
					stream.end();
				}
			})();
			return stream;
		},
	});
	pi.registerTool({ name: "e2e_work", label: "E2E work", description: "Gated local test work",
		parameters: Type.Object({ name: Type.String() }),
		async execute(_id, { name }, signal, update) {
			update?.({ content: [{ type: "text", text: `E2E detailed output ${name}\nE2E more detail ${name}` }], details: {} });
			record(`started-${name}.json`, { name });
			await wait(`finish-${name}`, signal);
			if (process.env.PI_COMPACT_TEST_TOOL_ERROR && name === "alpha") {
				throw new Error("E2E_HIDDEN_FAILURE_DETAILS\n".repeat(50));
			}
			return { content: [{ type: "text", text: `E2E detailed output ${name}\nE2E more detail ${name}` }], details: {} };
		},
	});
	pi.on("session_start", (event) => {
		// Same ownership marker as the shared real-Kitty cleanup helper.
		record("state.json", { ready: true, reason: event.reason });
	});
	pi.on("agent_settled", (_event, ctx) => {
		record("history.json", ctx.sessionManager.getBranch());
		record("phase.json", { phase: "settled", mode: ctx.ui.getActivityDisplayMode?.() ?? "inline" });
	});
	pi.registerCommand("e2e-dialog", { description: "Open a test dialog", async handler(_args, ctx) {
		await ctx.ui.select("E2E focused dialog", ["first", "second"]);
	} });
}
