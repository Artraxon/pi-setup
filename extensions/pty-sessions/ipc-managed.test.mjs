import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, until } from './managed-fixture.mjs';
import { Sessions } from './sessions.ts';
import { sendProcessMessage } from './pi-process.mjs';
import { NotificationChannel } from '../notifications/channel.ts';
import { sendNotification } from '../notifications/pi-notify.mjs';
const notices = s => s.messages.filter(entry => entry.message.customType === 'process-message');

test('/top, /stop and /kill replace the old commands while model tool names remain unchanged', async t => {
    const s = setup(t);
    assert.ok(s.commands.has('top')); assert.ok(s.commands.has('stop')); assert.ok(s.commands.has('kill'));
    assert.equal(s.commands.has('pty-list'), false); assert.equal(s.commands.has('pty-stop'), false);
    assert.ok(s.tools.has('pty_list')); assert.ok(s.tools.has('pty_stop'));
    const data = (await s.run({ command: 'sleep 30', yield_after: 0.01 })).structuredContent;
    await s.commands.get('kill').handler(`${data.id} INVALID`, s.ctx);
    assert.match(s.notices.at(-1), /Usage: \/kill/);
    assert.equal((await s.snapshot(data.id)).running, true);
    await s.commands.get('kill').handler(data.id, s.ctx);
    assert.match(s.notices.at(-1), /^Sent SIGKILL/);
    await until(async () => !(await s.snapshot(data.id)).running);
    assert.equal((await s.snapshot(data.id)).signal, 'SIGKILL');
});

test('/stop uses catchable SIGTERM while /kill forcefully terminates a process ignoring SIGTERM', async t => {
    const s = setup(t);
    const graceful = (await s.run({ command: `trap 'exit 0' TERM; pi-notify status ready; while :; do sleep 30; done`, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(graceful.id)).statusText === 'ready');
    await s.commands.get('stop').handler(`${graceful.id} SIGKILL`, s.ctx);
    assert.match(s.notices.at(-1), /Usage: \/stop id/);
    await s.commands.get('stop').handler(graceful.id, s.ctx);
    assert.match(s.notices.at(-1), /^Sent SIGTERM/);
    await until(async () => !(await s.snapshot(graceful.id)).running);
    assert.equal((await s.snapshot(graceful.id)).exitCode, 0);
    const stubborn = (await s.run({ command: `trap '' TERM; pi-notify status ready; while :; do sleep 30; done`, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(stubborn.id)).statusText === 'ready');
    await s.commands.get('stop').handler(stubborn.id, s.ctx);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal((await s.snapshot(stubborn.id)).running, true);
    await s.commands.get('kill').handler(stubborn.id, s.ctx);
    await until(async () => !(await s.snapshot(stubborn.id)).running);
    assert.equal((await s.snapshot(stubborn.id)).signal, 'SIGKILL');
});

test('child status is visible to model queries and a live process picker without invoking the agent', async t => {
    const s = setup(t), flag = join(s.directory, 'continue');
    const data = (await s.run({ command: `pi-process status 'Compiling'; while [ ! -f '${flag}' ]; do sleep .03; done; pi-process status 'Linking'; sleep 30`, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(data.id)).statusText === 'Compiling');
    assert.equal((await s.list())[0].statusText, 'Compiling');
    assert.ok(Date.parse((await s.snapshot(data.id)).statusUpdatedAt));
    const picker = s.commands.get('top').handler('', s.ctx);
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
    assert.match(notice.message.content, /Untrusted notifications/);
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
    const picker = s.commands.get('top').handler('', s.ctx);
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

test('managed environments replace ancestor metadata; each private endpoint enforces its own notification policy', async t => {
    const channel = new NotificationChannel(); t.after(() => channel.close());
    const sessions = new Sessions(undefined, undefined, channel); t.after(() => sessions.dispose());
    const outer = { PATH: process.env.PATH, PI_PROCESS_TOKEN: 'obsolete', PI_NOTIFY_TOKEN: 'obsolete', PI_NOTIFY_SOCKET: '/ancestor/socket',
        PI_PROCESS_SOCKET: '/ancestor/socket', PI_PROCESS_ID: 'ancestor', PI_PROCESS_PRIVATE: '1', PI_NOTIFY_SOURCE: 'ancestor' };
    const env = sessions.environment({ id: 'pty-1', privateOutput: false }, outer);
    const endpoint = sessions.endpoints.get('pty-1');
    assert.equal(env.PI_PROCESS_SOCKET, endpoint.path); assert.equal(env.PI_NOTIFY_SOCKET, endpoint.path);
    assert.equal(env.PI_PROCESS_ID, 'pty-1'); assert.equal(env.PI_PROCESS_PRIVATE, '0'); assert.equal(env.PI_NOTIFY_SOURCE, undefined);
    assert.equal(env.PI_PROCESS_TOKEN, undefined); assert.equal(env.PI_NOTIFY_TOKEN, undefined);
    const privateEnv = sessions.environment({ id: 'pty-2', privateOutput: true }, env);
    assert.notEqual(privateEnv.PI_NOTIFY_SOCKET, env.PI_NOTIFY_SOCKET);
    assert.equal(privateEnv.PI_PROCESS_ID, 'pty-2');
    delete privateEnv.PI_PROCESS_PRIVATE; delete privateEnv.PI_PROCESS_ID;
    await assert.rejects(sendProcessMessage('notify', 'private', { env: privateEnv }), /private_process/);
    await assert.rejects(sendNotification('notify', 'private', { env: privateEnv }), /private_process/);
    assert.equal(channel.queue.length, 0);
});

test('each launched process owns a separate mapped socket; identity-free status cannot update another process', async t => {
    const messages = [], channel = new NotificationChannel({ onNotify: batch => messages.push(...batch) });
    t.after(() => channel.close());
    const sessions = new Sessions(undefined, undefined, channel); t.after(() => sessions.dispose());
    const external = channel.create('existing-worker');
    const start = () => sessions.start('trap "exit 0" TERM; while :; do sleep 30; done', process.cwd(), false, 60, 10, '/bin/bash', '', { tty: false });
    const first = start(), second = start();
    const a = sessions.endpoints.get(first.id), b = sessions.endpoints.get(second.id);
    assert.equal(new Set([a.path, b.path, external.path]).size, 3);
    await sendProcessMessage('status', 'First running', { env: { PI_PROCESS_SOCKET: a.path } });
    await sendProcessMessage('status', 'Second running', { env: { PI_PROCESS_SOCKET: b.path, PI_PROCESS_ID: first.id } });
    assert.equal(first.statusText, 'First running'); assert.equal(second.statusText, 'Second running');
    sessions.stop(first.id, 'SIGTERM'); await first.done;
    assert.equal(sessions.endpoints.has(first.id), false); assert.equal(a.closed, true); assert.equal(b.closed, false);
    await assert.rejects(sendProcessMessage('status', 'Late', { env: { PI_PROCESS_SOCKET: a.path } }), /unavailable/);
    await sendProcessMessage('notify', 'Second ready', { env: { PI_PROCESS_SOCKET: b.path } });
    sessions.dispose(); assert.equal(sessions.endpoints.size, 0); assert.equal(b.closed, true);
    await sendNotification('notify', 'External still works', { socket: external.path });
    await until(() => messages.length === 2);
    assert.deepEqual(messages.map(({ id, text }) => [id, text]), [[second.id, 'Second ready'], ['existing-worker', 'External still works']]);
    channel.close(); await assert.rejects(sendNotification('notify', 'Closed', { socket: external.path }), /unavailable/);
});
