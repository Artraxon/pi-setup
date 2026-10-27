import { extractFileReferences, type FileReference } from "./clion.ts";

/** Pi currently exposes URL dispatch only on its fullscreen TUI implementation. */
export function installInlineFileHandler(
	tui: object,
	projectPath: string,
	open: (reference: FileReference) => void,
): () => void {
	const target = tui as { openUrl?: (url: string) => void };
	if (typeof target.openUrl !== "function") return () => {};
	const previous = target.openUrl;
	const handler = (url: string): void => {
		// Do not reinterpret web links, or navigate outside the current project.
		if (!/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("file://") || /:\d+(?::\d+)?$/.test(url)) {
			const references = extractFileReferences(url, projectPath);
			if (references.length === 1) {
				open(references[0]);
				return;
			}
		}
		previous.call(tui, url);
	};
	target.openUrl = handler;
	return () => {
		if (target.openUrl === handler) target.openUrl = previous;
	};
}
