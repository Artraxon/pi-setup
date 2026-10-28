import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface FileReference {
	file: string;
	line?: number;
	column?: number;
	label: string;
}

/** Only offer existing files inside the current project, never directories or URLs. */
export function extractFileReferences(text: string, projectPath: string): FileReference[] {
	const root = realpathSync(projectPath);
	const references = new Map<string, FileReference>();
	const prose = text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
	const candidates = [
		// URL dispatch supplies only the target, including extensionless files
		// and paths with spaces, rather than the original Markdown link.
		[prose.trim(), prose.trim()],
		...prose.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"\n]*")?\)/g),
		...prose.matchAll(/`([^`\n]+)`/g),
		...prose.matchAll(/([^\s`<>"()[\]{}]*[/.][^\s`<>"()[\]{}]+)/g),
	];

	for (const candidate of candidates) {
		let value = candidate[1].replace(/[.,;!?]+$/, "");
		let line: number | undefined;
		let column: number | undefined;
		const position = value.match(/^(.*?)(?:#L([1-9]\d*)(?:C([1-9]\d*))?(?:-L?[1-9]\d*)?|:([1-9]\d*)(?::([1-9]\d*))?)$/);
		if (position) {
			value = position[1];
			line = Number(position[2] ?? position[4]);
			column = position[3] || position[5] ? Number(position[3] ?? position[5]) : undefined;
			if (!Number.isSafeInteger(line) || (column !== undefined && !Number.isSafeInteger(column))) continue;
		}

		try {
			if (value.startsWith("file://")) value = fileURLToPath(value);
			else if (value.includes("://")) continue;
			else value = decodeURIComponent(value);
			const absolute = realpathSync(resolve(root, value));
			const file = relative(root, absolute);
			if (!file || file === ".." || file.startsWith(`..${sep}`) || isAbsolute(file) || !statSync(absolute).isFile()) continue;
			const label = `${file}${line === undefined ? "" : `:${line}${column === undefined ? "" : `:${column}`}`}`;
			references.set(label, { file, line, column, label });
		} catch {
			// Ordinary prose, missing paths, and unsupported file URLs are not actions.
		}
	}
	return [...references.values()];
}

/** Use editor navigation in the existing project, never a CLion project launcher. */
export async function openInClion(reference: FileReference, projectPath: string): Promise<void> {
	const response = await fetch(
		process.env.NES_CLION_MCP_URL ?? "http://127.0.0.1:29177/index-mcp/streamable-http",
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "ide_open_file",
					arguments: {
						project_path: projectPath,
						file: reference.file,
						...(reference.line === undefined ? {} : { line: reference.line }),
						...(reference.column === undefined ? {} : { column: reference.column }),
					},
				},
			}),
			signal: AbortSignal.timeout(15_000),
		},
	);
	if (!response.ok) throw new Error(`CLion MCP returned HTTP ${response.status}`);
	const payload = await response.json();
	if (payload.error) throw new Error(payload.error.message ?? "CLion MCP request failed");
	const text = payload.result?.content?.filter((block: { type: string }) => block.type === "text")
		.map((block: { text: string }) => block.text).join("\n");
	if (payload.result?.isError) throw new Error(text || "CLion could not open the file");
	if (!text || JSON.parse(text).opened !== true) throw new Error("CLion did not confirm opening the file");
}
