import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable);
const { createJiti } = require('jiti');
const root = resolve(dirname(executable), '../..');
const jiti = createJiti(import.meta.url, { alias: {
    '@earendil-works/pi-tui': resolve(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
const { default: extension } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));

test('CLion guidance is contributed every turn without replacing existing instructions; only assistant prose is transformed', t => {
    const directory = mkdtempSync(join(tmpdir(), 'clion-extension-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'File.cpp'), '');
    const events = new Map();
    let transform;
    extension({ on(name, handler) { events.set(name, handler); }, registerCommand() {}, registerMarkdownTransformer(value) { transform = value; } });
    const ctx = { cwd: directory, mode: 'json', sessionManager: { getBranch: () => [] } };
    events.get('session_start')({}, ctx);
    const options = { sections: { existing: 'keep me' } };
    events.get('before_agent_start')({ systemPromptOptions: options }, ctx);
    assert.equal(options.sections.existing, 'keep me');
    assert.match(options.sections.clion_file_references, /CLion-compatible Markdown links/);
    const first = options.sections.clion_file_references;
    events.get('before_agent_start')({ systemPromptOptions: options }, ctx);
    assert.equal(options.sections.clion_file_references, first);
    assert.equal(transform('See `File.cpp:7`.', { messageType: 'assistant', isStreaming: true }), 'See [File.cpp:7](File.cpp#L7).');
    for (const messageType of ['user', 'assistant-thinking']) assert.equal(transform('See `File.cpp:7`.', { messageType }), 'See `File.cpp:7`.');
});
