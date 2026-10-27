import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";

function singleLine(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function tokenLabel(count: number): string {
	return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

export default function compactTools(pi: ExtensionAPI) {
	pi.registerToolRenderer((name, next) => {
		const original = next();
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				if (context.expanded) {
					if (original?.renderCall) return original.renderCall(args, theme, context);
					return new Text(`${name}\n${JSON.stringify(args, null, 2)}`, 0, 0);
				}
				const input = (args ?? {}) as Record<string, unknown>;
				const summary = singleLine(input.command ?? input.path ?? input.file ?? input.pattern ?? JSON.stringify(args));
				const status = context.isError ? "✗" : context.isPartial ? "…" : "✓";
				const statusColor = context.isError ? "error" : context.isPartial ? "muted" : "success";
				const inputTokens = estimateTokens(JSON.stringify(args ?? {}) ?? "");
				return {
					render(width: number) {
						const outputTokens = context.state.outputTokens;
						const counts = `↑~${tokenLabel(inputTokens)} ↓${typeof outputTokens === "number" ? `~${tokenLabel(outputTokens)}` : "–"}`;
						const line = `${theme.fg(statusColor, status)} ${theme.fg("muted", `${counts} · ${name} ${summary}`)}`;
						return [truncateToWidth(line, width, "…")];
					},
					invalidate() {},
				};
			},
			renderResult(result, options, theme, context) {
				// Approximate text tokens only; tool execution itself has no model usage.
				context.state.outputTokens = estimateTokens(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
				if (!options.expanded) return { render: () => [], invalidate() {} };
				if (original?.renderResult) return original.renderResult(result, options, theme, context);
				return new Text(result.content.filter(block => block.type === "text").map(block => block.text).join("\n"), 0, 0);
			},
		};
	});
}
