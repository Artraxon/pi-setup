import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractFileReferences } from "./clion.ts";

test("file controls retain coordinates and decode Markdown paths without scanning code fences", (t) => {
	const root = mkdtempSync(join(tmpdir(), "clion-refs-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, "src"));
	for (const file of ["Header.hpp", "has spaces.cpp", "Other.cpp", "example.cpp"]) {
		writeFileSync(join(root, "src", file), "");
	}
	const text = [
		"See `src/Header.hpp:53:8`.",
		"[implementation](src/has%20spaces.cpp#L12)",
		"Also src/Other.cpp:7.",
		"```cpp",
		"src/example.cpp:9",
		"```",
	].join("\n");
	const references = extractFileReferences(text, root).sort((a, b) => a.file.localeCompare(b.file));
	assert.deepEqual(references, [
		{ file: "src/has spaces.cpp", line: 12, column: undefined, label: "src/has spaces.cpp:12" },
		{ file: "src/Header.hpp", line: 53, column: 8, label: "src/Header.hpp:53:8" },
		{ file: "src/Other.cpp", line: 7, column: undefined, label: "src/Other.cpp:7" },
	]);
});

test("file controls exclude missing files, directories, traversal, and escaping symlinks", (t) => {
	const root = mkdtempSync(join(tmpdir(), "clion-boundary-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const project = join(root, "project");
	mkdirSync(project);
	writeFileSync(join(root, "outside.cpp"), "");
	symlinkSync(join(root, "outside.cpp"), join(project, "escape.cpp"));
	assert.deepEqual(extractFileReferences(
		"`missing.cpp` `../outside.cpp` `escape.cpp` `.` [website](https://example.org/source.cpp)",
		project,
	), []);
});
