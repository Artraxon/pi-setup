export interface IdeEndpoint {
	name: string;
	url: string;
}

export interface IdeSelection {
	available: IdeEndpoint[];
	selected?: IdeEndpoint;
}

// IDE Index MCP Server's documented defaults, in deterministic discovery order:
// https://github.com/hechtcarmel/jetbrains-index-mcp-plugin#ide-specific-defaults
export const DEFAULT_IDE_ENDPOINTS: readonly IdeEndpoint[] = [
	"IntelliJ IDEA", "Android Studio", "PyCharm", "WebStorm", "GoLand", "PhpStorm",
	"RubyMine", "CLion", "RustRover", "DataGrip", "Aqua", "DataSpell",
].map((name, index) => ({ name, url: `http://127.0.0.1:${29170 + index}/index-mcp/streamable-http` }));

export function ideCandidates(overrideUrl = process.env.NES_CLION_MCP_URL): IdeEndpoint[] {
	if (!overrideUrl) return [...DEFAULT_IDE_ENDPOINTS];
	const custom = DEFAULT_IDE_ENDPOINTS.find(endpoint => endpoint.url === overrideUrl)
		?? { name: "Custom IDE", url: overrideUrl };
	return [custom, ...DEFAULT_IDE_ENDPOINTS.filter(endpoint => endpoint.url !== overrideUrl)];
}

interface RequestOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Stateless JSON-RPC, shared by read-only discovery and explicit editor navigation. */
export async function requestIde<T>(url: string, method: string, params: object, options: RequestOptions = {}): Promise<T> {
	try {
		const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
		const response = await (options.fetchImpl ?? fetch)(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const payload = await response.json();
		if (payload.error) throw new Error(payload.error.message ?? "MCP request failed");
		if (payload.jsonrpc !== "2.0" || !payload.result || typeof payload.result !== "object") {
			throw new Error("Invalid MCP response");
		}
		return payload.result as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const cause = error instanceof Error ? error.cause as { code?: string; message?: string } | undefined : undefined;
		const detail = cause?.code ?? cause?.message;
		throw new Error(`IDE request to ${url} failed: ${message}${detail ? ` (${detail})` : ""}`, { cause: error });
	}
}

/** Probe in parallel, but retain candidate order rather than response-speed order. Never opens a file. */
export async function discoverIdeEndpoints(options: RequestOptions & { candidates?: readonly IdeEndpoint[] } = {}): Promise<IdeEndpoint[]> {
	const results = await Promise.all((options.candidates ?? ideCandidates()).map(async endpoint => {
		try {
			const result = await requestIde<{ tools?: { name: string }[] }>(endpoint.url, "tools/list", {}, {
				...options, timeoutMs: options.timeoutMs ?? 1_500,
			});
			return Array.isArray(result.tools) && result.tools.some(tool => tool?.name === "ide_open_file") ? endpoint : undefined;
		} catch {
			// Missing plugins, disabled navigation, unrelated servers and timeouts are unavailable.
			return undefined;
		}
	}));
	return results.filter((endpoint): endpoint is IdeEndpoint => endpoint !== undefined);
}

export function selectIdeEndpoint(available: IdeEndpoint[], preferredUrl?: string): IdeEndpoint | undefined {
	return available.find(endpoint => endpoint.url === preferredUrl) ?? available[0];
}

export function ideLabel(endpoint: IdeEndpoint): string {
	return `${endpoint.name} (${new URL(endpoint.url).host})`;
}
