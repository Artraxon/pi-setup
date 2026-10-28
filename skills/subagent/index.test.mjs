import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const sdk = resolve(dirname(executable), '../../dist');
const { loadSkillsFromDir } = await import(resolve(sdk, 'core/skills.js'));
const { loadPromptTemplates, expandPromptTemplate } = await import(resolve(sdk, 'core/prompt-templates.js'));
const root = fileURLToPath(new URL('../../', import.meta.url));

test('subagent skill is valid, small and mandates a fresh fully interactive TUI', () => {
    const result = loadSkillsFromDir({ dir: resolve(root, 'skills'), source: 'test' });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].name, 'subagent');
    const text = readFileSync(result.skills[0].filePath, 'utf8');
    assert.ok(text.split(/\s+/).length < 300);
    assert.match(text, /tty: true, yield_after: 0/);
    assert.match(text, /pty_write/);
    const command = text.split('```sh')[1].split('```')[0];
    assert.match(command, /node .*launch\.mjs/);
    assert.match(text, /subagent_result\(\{id\}\)/);
    assert.match(text, /not `pty_snapshot` or log reads/);
    assert.ok(!/--(?:print|mode|continue|resume)(?:\s|$)|\|/.test(command));
});

test('/subagent template invokes the skill and forwards task arguments', () => {
    const result = loadPromptTemplates({ cwd: root, agentDir: root, promptPaths: [resolve(root, 'prompts')], includeDefaults: false });
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.templates[0].name, 'subagent');
    const expanded = expandPromptTemplate('/subagent "Review helper CLI"', result.templates);
    assert.match(expanded, /follow the available subagent skill/);
    assert.match(expanded, /Task: Review helper CLI/);
    assert.match(expanded, /normal interactive Pi TUI/);
});
