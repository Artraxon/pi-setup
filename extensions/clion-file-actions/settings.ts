import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SettingsList } from "@earendil-works/pi-tui";
import { contributeSettings } from "../shared/settings-hook.mjs";
import { ideLabel, type IdeEndpoint, type IdeSelection } from "./ide.ts";

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "ide-file-links.json");
}

function readConfig(): Record<string, unknown> {
	try {
		const config = JSON.parse(readFileSync(configPath(), "utf8"));
		if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Expected a JSON object.");
		return config;
	} catch (error: any) {
		if (error.code === "ENOENT") return {};
		throw new Error(`Cannot read ide-file-links.json: ${error.message}`);
	}
}

export function preferredIdeUrl(): string | undefined {
	const url = readConfig().preferredUrl;
	if (url !== undefined && (typeof url !== "string" || !url.trim())) {
		throw new Error("ide-file-links.json preferredUrl must be a nonempty URL.");
	}
	return url as string | undefined;
}

export function savePreferredIdeUrl(url: string): void {
	const config = { ...readConfig(), preferredUrl: url };
	const destination = configPath();
	const temp = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	mkdirSync(dirname(destination), { recursive: true });
	try {
		writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
		renameSync(temp, destination);
	} finally { rmSync(temp, { force: true }); }
}

export function installIdeSettings(host: any, theme: any, ctx: any, selection: IdeSelection,
	onSelect: (endpoint: IdeEndpoint) => void): () => void {
	return contributeSettings(host, (list: any) => {
		if (list.items.some((item: any) => item.id === "ide-file-links")) return;
		list.items.unshift({
			id: "ide-file-links", label: "IDE file links",
			description: "Backend for project-file links. Discovered at startup and /reload; Enter selects an available IDE.",
			currentValue: selection.selected ? ideLabel(selection.selected) : "None found — /reload to retry",
			...(selection.available.length ? {
				submenu: (_current: string, done: (value?: string) => void) => {
					const menu = new SettingsList(selection.available.map(endpoint => ({
						id: endpoint.url, label: ideLabel(endpoint), description: endpoint.url,
						currentValue: endpoint.url === selection.selected?.url ? "selected" : "", values: ["use"],
					})), 10, {
						label: (value, selected) => theme.fg(selected ? "accent" : "text", value),
						value: value => theme.fg("muted", value), description: value => theme.fg("muted", value),
						cursor: theme.fg("accent", "› "), hint: value => theme.fg("muted", value),
					}, url => {
						const endpoint = selection.available.find(candidate => candidate.url === url);
						if (!endpoint) return;
						try { onSelect(endpoint); done(ideLabel(endpoint)); }
						catch (error) { ctx.ui.notify(`IDE settings: ${error instanceof Error ? error.message : String(error)}`, "error"); }
					}, () => done(), { enableSearch: true });
					if (selection.selected) menu.selectItem(selection.selected.url);
					return menu;
				},
			} : {}),
		});
	});
}
