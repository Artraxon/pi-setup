import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_IDE_ENDPOINTS, discoverIdeEndpoints, ideCandidates, requestIde, selectIdeEndpoint } from "./ide.ts";
import { openInClion } from "./clion.ts";

const response = (result: object) => Response.json({ jsonrpc: "2.0", id: 1, result });
const tools = () => response({ tools: [{ name: "ide_open_file" }] });

// All network behavior in these tests is mocked; no IDE is contacted or file opened.
test("discovery covers every documented port and puts an explicit override first without duplicates", () => {
	assert.equal(DEFAULT_IDE_ENDPOINTS.length, 12);
	assert.equal(DEFAULT_IDE_ENDPOINTS[2].name, "PyCharm");
	assert.match(DEFAULT_IDE_ENDPOINTS[2].url, /:29172\//);
	assert.equal(DEFAULT_IDE_ENDPOINTS[7].name, "CLion");
	assert.match(DEFAULT_IDE_ENDPOINTS[7].url, /:29177\//);
	assert.deepEqual(ideCandidates(""), DEFAULT_IDE_ENDPOINTS);
	const known = ideCandidates(DEFAULT_IDE_ENDPOINTS[7].url);
	assert.equal(known.length, 12);
	assert.equal(known[0].name, "CLion");
	const custom = ideCandidates("http://127.0.0.1:30000/index-mcp/streamable-http");
	assert.equal(custom.length, 13);
	assert.equal(custom[0].name, "Custom IDE");
});

test("discovery is parallel but first available means candidate order, not fastest response", async () => {
	const candidates = DEFAULT_IDE_ENDPOINTS.slice(0, 4);
	const requests: string[] = [];
	const available = await discoverIdeEndpoints({ candidates, fetchImpl: async (url, init) => {
		requests.push(String(url));
		assert.deepEqual(JSON.parse(init!.body as string), { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
		if (url === candidates[0].url) throw new TypeError("fetch failed");
		if (url === candidates[1].url) {
			await new Promise(resolve => setTimeout(resolve, 10));
			assert.equal(requests.length, candidates.length, "probes start concurrently");
		}
		return tools();
	} });
	assert.deepEqual(available, candidates.slice(1));
	assert.equal(selectIdeEndpoint(available), candidates[1]);
	assert.equal(selectIdeEndpoint(available, candidates[3].url), candidates[3]);
	assert.equal(selectIdeEndpoint(available, "http://offline"), candidates[1]);
	assert.equal(selectIdeEndpoint([]), undefined);
});

test("discovery ignores HTTP/RPC errors, malformed responses and disabled editor navigation", async () => {
	const candidates = DEFAULT_IDE_ENDPOINTS.slice(0, 8);
	const replies = [
		new Response("Forbidden", { status: 403 }),
		Response.json({ jsonrpc: "2.0", error: { message: "disabled" } }),
		new Response("not JSON"),
		Response.json({ result: { tools: [{ name: "ide_open_file" }] } }),
		response({ tools: [{ name: "ide_find_file" }] }),
		response({ tools: {} }),
		response({ tools: [null] }),
		tools(),
	];
	let index = 0;
	const available = await discoverIdeEndpoints({ candidates, fetchImpl: async () => replies[index++] });
	assert.deepEqual(available, [candidates[7]]);
});

test("slow discovery probes time out and shutdown aborts pending requests", async () => {
	let signal: AbortSignal | undefined;
	const slowFetch: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
		signal = init!.signal as AbortSignal;
		// Keep the fake transport alive until timeout, just as a real socket would.
		const timer = setTimeout(() => reject(new Error("test transport did not abort")), 500);
		const abort = () => { clearTimeout(timer); reject(signal!.reason); };
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	});
	assert.deepEqual(await discoverIdeEndpoints({ candidates: DEFAULT_IDE_ENDPOINTS.slice(0, 1), timeoutMs: 10, fetchImpl: slowFetch }), []);
	assert.equal(signal?.aborted, true);
	const controller = new AbortController();
	const discovery = discoverIdeEndpoints({ candidates: DEFAULT_IDE_ENDPOINTS.slice(0, 1), signal: controller.signal, fetchImpl: slowFetch });
	controller.abort();
	assert.deepEqual(await discovery, []);
	assert.equal(signal?.aborted, true);
});

test("request failures report the attempted endpoint and underlying connection error", async () => {
	await assert.rejects(requestIde("http://127.0.0.1:29177/test", "tools/list", {}, {
		fetchImpl: async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); },
	}), /29177\/test.*fetch failed.*ECONNREFUSED/);
});

test("explicit navigation uses the selected URL and preserves project, line and column", async t => {
	const original = globalThis.fetch;
	t.after(() => { globalThis.fetch = original; });
	let request: any;
	globalThis.fetch = async (url, init) => {
		request = { url, body: JSON.parse(init!.body as string) };
		return response({ content: [{ type: "text", text: JSON.stringify({ opened: true }) }] });
	};
	await openInClion({ file: "README.md", line: 7, column: 2, label: "README.md:7:2" }, "/project", DEFAULT_IDE_ENDPOINTS[2].url);
	assert.equal(request.url, DEFAULT_IDE_ENDPOINTS[2].url);
	assert.deepEqual(request.body.params, { name: "ide_open_file", arguments: { project_path: "/project", file: "README.md", line: 7, column: 2 } });
	globalThis.fetch = async () => response({ isError: true, content: [{ type: "text", text: "file not found" }] });
	await assert.rejects(openInClion({ file: "README.md", label: "README.md" }, "/project", request.url), /file not found/);
	globalThis.fetch = async () => response({ content: [{ type: "text", text: JSON.stringify({ opened: false }) }] });
	await assert.rejects(openInClion({ file: "README.md", label: "README.md" }, "/project", request.url), /did not confirm/);
});
