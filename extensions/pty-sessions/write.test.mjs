import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions } from './sessions.ts';
import { setup, until } from './managed-fixture.mjs';

test('pty_write sends terminal input and an optional Enter without echoing the prompt in its result', async t => {
    const s = setup(t);
    const job = (await s.run({ command: 'read -r line; printf "received:%s\\n" "$line"; sleep 30', tty: true, yield_after: 0.01 })).structuredContent;
    const result = await s.tools.get('pty_write').execute('', { id: job.id, data: 'follow-up', submit: true });
    assert.equal(result.content[0].text, `Sent input to ${job.id}.`);
    assert.ok(!JSON.stringify(result).includes('follow-up'));
    await until(async () => (await s.snapshot(job.id)).output.includes('received:follow-up'));
    assert.equal((await s.snapshot(job.id)).running, true);
});

test('PTY input rejects private, non-TTY, exited, attached, oversized and unknown targets', async t => {
    const sessions = new Sessions(); t.after(() => sessions.dispose());
    const tty = sessions.start('sleep 30', process.cwd(), false);
    const secret = sessions.start('sleep 30', process.cwd(), true);
    const pipe = sessions.start('sleep 30', process.cwd(), false, 60, 10, '/bin/bash', '', { tty: false });
    assert.throws(() => sessions.write(secret.id, 'secret'), /Private/);
    assert.throws(() => sessions.write(pipe.id, 'input'), /no TTY/);
    assert.throws(() => sessions.write('absent', 'input'), /Unknown/);
    assert.throws(() => sessions.write(tty.id, 'é'.repeat(9000)), /16384 bytes/);
    tty.attached = true;
    assert.throws(() => sessions.write(tty.id, 'input'), /attached by the user/);
    tty.attached = false;
    sessions.stop(tty.id, 'SIGKILL'); await tty.done;
    assert.throws(() => sessions.write(tty.id, 'input'), /no longer running/);
});

test('user can enter and leave a normal TTY while the parent agent is busy', async t => {
    const s = setup(t);
    s.ctx.isIdle = () => false;
    const job = (await s.run({ command: 'read -r line; printf "user-input:%s\\n" "$line"; sleep 30', tty: true, yield_after: 0.01 })).structuredContent;
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
        const attachment = s.commands.get('fg').handler(job.id, s.ctx);
        await until(() => s.stopped || s.notices.length);
        assert.equal(s.stopped, true, s.notices.join('\n'));
        await assert.rejects(s.tools.get('pty_write').execute('', { id: job.id, data: 'model input' }), /attached by the user/);
        process.stdin.emit('data', Buffer.from('hello\r'));
        await until(async () => (await s.snapshot(job.id)).output.includes('user-input:hello'));
        process.stdin.emit('data', Buffer.from('\x1a'));
        await attachment;
        assert.equal(s.stopped, false);
        assert.equal((await s.snapshot(job.id)).running, true);
        assert.deepEqual(s.notices, []);
    } finally { process.stdout.write = originalWrite; process.stdin.pause(); }
});

test('tool cannot inject input into private !! or a user-attached TTY', async t => {
    const s = setup(t);
    await s.events.get('user_bash')({ command: 'sleep 30', cwd: s.directory, excludeFromContext: true }, s.ctx);
    const secret = (await s.list()).find(entry => entry.private);
    await assert.rejects(s.tools.get('pty_write').execute('', { id: secret.id, data: 'unsafe' }), /Private/);
    const job = (await s.run({ command: 'sleep 30', tty: true, yield_after: 0.01 })).structuredContent;
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
        const attachment = s.commands.get('fg').handler(job.id, s.ctx);
        await until(() => s.stopped);
        await assert.rejects(s.tools.get('pty_write').execute('', { id: job.id, data: 'unsafe' }), /attached by the user/);
        process.stdin.emit('data', Buffer.from('\x1a'));
        await attachment;
    } finally { process.stdout.write = originalWrite; process.stdin.pause(); }
});
