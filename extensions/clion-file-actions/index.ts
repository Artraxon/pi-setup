import type {
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { extractFileReferences, openInClion, type FileReference } from "./clion.ts";

import { installInlineFileHandler } from "./inline.ts";
import { installLinkNavigation } from "./link-navigation.ts";
import { CLION_REFERENCE_GUIDANCE, linkProjectReferences } from "./references.ts";

const WIDGET_KEY = "clion-file-actions";

function displayLabel(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function assistantText(message: MessageEndEvent["message"]): string | undefined {
	if (message.role !== "assistant" || message.stopReason === "aborted" || message.stopReason === "error") {
		return undefined;
	}
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export default function clionFileActions(pi: ExtensionAPI) {
	let references: FileReference[] = [];
	let projectPath: string | undefined;
	pi.on("before_agent_start", (event, ctx) => {
		projectPath = ctx.cwd;
		event.systemPromptOptions.sections.clion_file_references = CLION_REFERENCE_GUIDANCE;
	});
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "assistant" && projectPath ? linkProjectReferences(markdown, projectPath) : markdown,
	);
	let removeInlineHandler: (() => void) | undefined;
	let removeLinkNavigation: (() => void) | undefined;
	pi.on("session_shutdown", () => {
		removeInlineHandler?.();
		removeInlineHandler = undefined;
		removeLinkNavigation?.();
		removeLinkNavigation = undefined;
	});

	async function open(reference: FileReference, ctx: ExtensionContext): Promise<void> {
		try {
			await openInClion(reference, ctx.cwd);
			ctx.ui.notify(`Opened in CLion: ${displayLabel(reference.label)}`, "info");
		} catch (error) {
			ctx.ui.notify(`CLion: ${displayLabel(error instanceof Error ? error.message : String(error))}`, "error");
		}
	}

	function installInlineNavigation(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		// The component factory provides access to Pi's TUI. Render no rows:
		// navigation is exclusively inline, with /clion as the keyboard fallback.
		ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
			removeLinkNavigation?.();
			removeLinkNavigation = installLinkNavigation(tui, theme, ctx, (reference) => void open(reference, ctx));
			removeInlineHandler?.();
			removeInlineHandler = installInlineFileHandler(tui, ctx.cwd, (reference) => void open(reference, ctx));
			return { render: () => [], invalidate() {} };
		}, { placement: "aboveEditor" });
	}

	function restore(ctx: ExtensionContext): void {
		projectPath = ctx.cwd;
		references = [];
		const branch = ctx.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "message") continue;
			const text = assistantText(entry.message);
			if (!text) continue;
			const discovered = extractFileReferences(text, ctx.cwd);
			if (discovered.length === 0) continue;
			references = discovered;
			break;
		}
		installInlineNavigation(ctx);
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("message_end", (event, ctx) => {
		const text = assistantText(event.message);
		if (!text) return;
		const discovered = extractFileReferences(text, ctx.cwd);
		if (discovered.length === 0) return;
		references = discovered;
		installInlineNavigation(ctx);
	});

	pi.registerCommand("clion", {
		description: "Open an assistant-referenced file in CLion, or /clion path[:line[:column]]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const target = args.trim();
			const choices = target ? extractFileReferences(target, ctx.cwd) : references;
			if (choices.length === 0) {
				ctx.ui.notify(target ? "CLion: no existing project file found." : "CLion: no assistant file references yet.", "warning");
				return;
			}
			if (target && choices.length === 1) {
				await open(choices[0], ctx);
				return;
			}
			const labels = choices.map((reference, index) => `${index + 1}. ${displayLabel(reference.label)}`);
			const selected = await ctx.ui.select("Open file in CLion", labels);
			if (selected === undefined) return;
			const index = labels.indexOf(selected);
			if (index >= 0) await open(choices[index], ctx);
		},
	});
}
