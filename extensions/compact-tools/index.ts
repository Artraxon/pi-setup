import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { installCompactSettings, loadCompactActivityEnabled } from "./settings.ts";

type ActivityUI = ExtensionContext["ui"] & {
	setCompactActivityEnabled?(enabled: boolean): void;
	setActivityDisplayMode?(mode: "compact" | "inline" | "expanded"): void;
};

function singleLine(value: unknown): string {
	return stripTerminalSequences(String(value ?? "")).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function tokenLabel(count: unknown): string {
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return "  –";
	const units = ["", "k", "M", "B", "T", "Q"];
	let scaled = count, unit = 0;
	// Promote before rounding would turn 99k into the four-character 100k.
	while (scaled >= (unit === 0 ? 1000 : 99.5) && unit < units.length - 1) {
		scaled /= 1000;
		unit++;
	}
	// Whole units above 1; below 1 omit the leading zero (800k -> .8M).
	const value = String(scaled < 1 ? Math.round(scaled * 10) / 10 : Math.round(scaled)).replace(/^0\./, ".");
	const label = unit === 0 ? String(count) : `${value}${units[unit]}`;
	return label.padStart(3);
}

export default function compactTools(pi: ExtensionAPI) {
	let removeSettings: (() => void) | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const apply = (enabled: boolean) => {
			const ui = ctx.ui as ActivityUI;
			if (ui.setCompactActivityEnabled) ui.setCompactActivityEnabled(enabled);
			else if (!enabled) ui.setActivityDisplayMode?.("inline");
		};
		try { apply(loadCompactActivityEnabled()); }
		catch (error) { ctx.ui.notify(`Compact activity settings: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
		ctx.ui.setWidget("compact-settings-host", (tui, theme) => {
			removeSettings?.();
			removeSettings = installCompactSettings(tui, theme, ctx, apply);
			return { render: () => [], invalidate() {} };
		});
	});
	pi.on("session_shutdown", () => { removeSettings?.(); removeSettings = undefined; });
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
						const counts = `↑${tokenLabel(inputTokens)} ↓${tokenLabel(outputTokens)}`;
						const line = `${theme.fg(statusColor, status)} ${theme.fg("muted", `${counts} ${name} ${summary}`)}`;
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
