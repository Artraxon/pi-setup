import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, until } from './managed-fixture.mjs';
import { initializeSubagent, turnFile, writeRecord } from './subagent-store.ts';

test('registered result tool is codemode-only and returns only structured final text, including after process exit', async t => {
    const s = setup(t);
    const native = await s.run({ command: 'printf "%s\\n%s\\n" "$PI_PROCESS_ID" "$PI_PROCESS_DATA_DIR"', yield_after: 2 });
    const [id, directory] = native.structuredContent.output.trim().split('\n');
    assert.match(id, /^pty-\d+$/); assert.ok(directory.startsWith(join(s.directory, 'process-data')));
    assert.equal(existsSync(directory), false, 'ordinary commands do not allocate artifact directories');
    initializeSubagent(directory, id);
    const record = { version: 1, id, turn: 1, status: 'completed', output: 'Compact handoff.', sessionFile: '/must/not/forward/session.jsonl' };
    writeRecord(directory, turnFile(1), record); writeRecord(directory, 'latest.json', record);
    const tool = s.tools.get('subagent_result'); assert.equal(tool.exposure, 'codemode');
    assert.ok(tool.outputSchema);
    const result = await tool.execute('test', { id });
    assert.deepEqual(result.structuredContent, { id, turn: 1, status: 'completed', output: 'Compact handoff.' });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.ok(!result.content[0].text.includes('session.jsonl'));
    assert.ok(!JSON.stringify(await s.list()).includes(directory));
});

test('ordinary and unknown processes have no results; interrupted children never remain falsely running', async t => {
    const s = setup(t);
    const result = await s.run({ command: 'printf "%s\\n%s\\n" "$PI_PROCESS_ID" "$PI_PROCESS_DATA_DIR"', yield_after: 2 });
    const [id, directory] = result.structuredContent.output.trim().split('\n');
    const tool = s.tools.get('subagent_result');
    await assert.rejects(tool.execute('test', { id }), /No saved/);
    await assert.rejects(tool.execute('test', { id: 'no-such-process' }), /Unknown/);
    initializeSubagent(directory, id);
    writeRecord(directory, 'latest.json', { version: 1, id, turn: 1, status: 'running', output: '' });
    const response = (await tool.execute('test', { id })).structuredContent;
    assert.equal(response.status, 'error'); assert.equal(response.output, '');
    assert.match(response.error, /exited/);
});

test('launcher starts a real normal Pi TUI and exposes an idle result without any model request', async t => {
    const s = setup(t);
    const launcher = fileURLToPath(new URL('../../skills/subagent/launch.mjs', import.meta.url));
    const data = (await s.run({ command: `node '${launcher}' --model openai/gpt-4o --thinking off`, tty: true, yield_after: 0 })).structuredContent;
    await until(async () => {
        const snapshot = await s.snapshot(data.id);
        assert.equal(snapshot.running, true, snapshot.screen);
        return snapshot.screen.includes('gpt-4o') && snapshot.screen.includes('ctrl+c');
    }, 10000);
    const result = (await s.tools.get('subagent_result').execute('test', { id: data.id })).structuredContent;
    assert.deepEqual(result, { id: data.id, turn: 0, status: 'idle', output: '' });
    assert.ok(!s.notices.some(notice => /extension|error/i.test(notice)));
});

test('launcher refuses private result persistence before creating a workspace', async t => {
    const s = setup(t);
    const launcher = fileURLToPath(new URL('../../skills/subagent/launch.mjs', import.meta.url));
    const data = (await s.run({ command: `PI_PROCESS_PRIVATE=1 node '${launcher}'`, tty: true, yield_after: 0 })).structuredContent;
    await until(async () => !(await s.snapshot(data.id)).running);
    const snapshot = await s.snapshot(data.id);
    assert.match(snapshot.screen, /private !! jobs must not be persisted/);
    assert.equal(existsSync(join(s.directory, 'process-data')), false);
});

test('private jobs get an explicit private environment and the result API denies access before reading disk', async t => {
    const s = setup(t);
    await s.events.get('user_bash')({ command: 'pi-process status "private=${PI_PROCESS_PRIVATE}"; sleep 30', cwd: s.directory, excludeFromContext: true }, s.ctx);
    const picker = s.commands.get('pty-list').handler('', s.ctx);
    await until(() => s.dialog && s.dialog.render(160).join('\n').includes('· private=1 ·'));
    const id = (await s.list()).find(record => record.private).id;
    await assert.rejects(s.tools.get('subagent_result').execute('test', { id }), /Private/);
    assert.equal(existsSync(join(s.directory, 'process-data')), false, 'private output is not persisted automatically');
    s.dialog.handleInput('\x1b'); await picker;
});
