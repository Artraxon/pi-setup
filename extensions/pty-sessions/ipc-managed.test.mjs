import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, until } from './managed-fixture.mjs';
import { Sessions } from './sessions.ts';
import { sendProcessMessage } from './pi-process.mjs';
const notices = s => s.messages.filter(entry => entry.message.customType === 'process-message');

test('child status is visible to model queries and a live process picker without invoking the agent', async t => {
    const s = setup(t), flag = join(s.directory, 'continue');
    const data = (await s.run({ command: `pi-process status 'Compiling'; while [ ! -f '${flag}' ]; do sleep .03; done; pi-process status 'Linking'; sleep 30`, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(data.id)).statusText === 'Compiling');
    assert.equal((await s.list())[0].statusText, 'Compiling');
    assert.ok(Date.parse((await s.snapshot(data.id)).statusUpdatedAt));
    const picker = s.commands.get('pty-list').handler('', s.ctx);
    await until(() => s.dialog);
    assert.match(s.dialog.render(120).join('\n'), /Compiling/);
    writeFileSync(flag, '');
    await until(async () => (await s.list())[0].statusText === 'Linking');
    assert.match(s.dialog.render(120).join('\n'), /Linking/);
    s.dialog.handleInput('\x1b'); await picker;
    assert.equal(notices(s).length, 0);
    assert.equal(s.exits().length, 0);
});

test('a running child notification queues an identified, untrusted follow-up without including status updates', async t => {
    const s = setup(t, 'json');
    const data = (await s.run({ command: `pi-process notify 'Ready for tests'; pi-process status 'Awaiting action'; sleep 30`, yield_after: 0.01 })).structuredContent;
    await until(() => notices(s).length > 0);
    const notice = notices(s)[0];
    assert.deepEqual(notice.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.match(notice.message.content, /Untrusted managed-process/);
    assert.match(notice.message.content, /Ready for tests/);
    assert.ok(notice.message.content.includes(data.id));
    assert.ok(!notice.message.content.includes('Awaiting action'));
    assert.equal((await s.snapshot(data.id)).running, true);
    await until(async () => (await s.snapshot(data.id)).statusText === 'Awaiting action');
    assert.equal(s.exits().length, 0);
});

test('at most one IPC follow-up is outstanding; later messages wait locally for agent_end', async t => {
    const s = setup(t), flag = join(s.directory, 'again');
    const data = (await s.run({ command: `pi-process notify 'first'; while [ ! -f '${flag}' ]; do sleep .03; done; pi-process notify 'second'; pi-process status 'queued'; sleep 30`, yield_after: 0.01 })).structuredContent;
    await until(() => notices(s).length === 1);
    writeFileSync(flag, '');
    await until(async () => (await s.snapshot(data.id)).statusText === 'queued');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(notices(s).length, 1);
    s.events.get('agent_end')({}, s.ctx);
    await until(() => notices(s).length === 2);
    assert.match(notices(s)[1].message.content, /second/);
});

test('private !! status is user-visible but absent from model queries; its notification is rejected', async t => {
    const s = setup(t);
    await s.events.get('user_bash')({ command: `pi-process status 'private-progress'; pi-process notify 'secret-notification'; sleep 30`, cwd: s.directory, excludeFromContext: true }, s.ctx);
    const picker = s.commands.get('pty-list').handler('', s.ctx);
    await until(() => s.dialog && s.dialog.render(120).join('\n').includes('private-progress'));
    const entries = await s.list(), secret = entries.find(entry => entry.private);
    assert.equal(secret.statusText, undefined);
    assert.equal(secret.statusUpdatedAt, undefined);
    assert.ok(!JSON.stringify(entries).includes('private-progress'));
    await assert.rejects(s.snapshot(secret.id), /Private/);
    // Give the subsequent helper invocation time to fail, then verify no disclosure.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(notices(s).length, 0);
    assert.equal(s.exits().length, 0);
    assert.ok(s.messages.every(entry => !entry.message.content.includes('secret-notification')));
    s.dialog.handleInput('\x1b'); await picker;
});

test('quick commands retain native result shape; status survives normal process exit until record eviction', async t => {
    const s = setup(t);
    const result = await s.run({ command: `pi-process status 'done'; printf hello`, yield_after: 2 });
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello' }]);
    assert.deepEqual(Object.keys(result.structuredContent), ['output', 'truncated', 'exit_code', 'wall_time_seconds']);
    assert.equal(result.details, undefined);
    assert.equal((await s.list())[0].statusText, 'done');
    assert.equal((await s.list())[0].running, false);
    assert.equal(notices(s).length, 0);
    assert.equal(s.exits().length, 0);
});

test('real backend exit revokes the launched process capability and shutdown removes its endpoint', async t => {
    const sessions = new Sessions(); t.after(() => sessions.dispose());
    const session = sessions.start('trap "exit 0" TERM; while :; do sleep 30; done', process.cwd(), false, 60, 10, '/bin/bash', '', { tty: false });
    const token = [...sessions.channel.records.keys()][0];
    const env = { PI_PROCESS_SOCKET: sessions.channel.path, PI_PROCESS_TOKEN: token };
    await sendProcessMessage('status', 'running', { env });
    sessions.stop(session.id, 'SIGTERM');
    await session.done;
    assert.equal(session.exitCode, 0);
    assert.equal(sessions.channel.records.size, 0);
    await assert.rejects(sendProcessMessage('notify', 'late', { env }), /unauthorized/);
    sessions.dispose();
    await assert.rejects(sendProcessMessage('status', 'after shutdown', { env }), /unavailable/);
});
