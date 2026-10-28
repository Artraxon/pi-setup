import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { setup, settings, until, builtinBash } from './managed-fixture.mjs';

test('bash overrides normal execution, defaults to pipes/EOF stdin, preserves cwd, stderr and session environment', async t => {
    const s = setup(t);
    const result = await s.run({ command: 'test ! -t 0 && test ! -t 1 || exit 10; if read -r x; then exit 11; fi; pwd; echo stderr >&2; echo "$PI_SESSION_ID:$PI_PROVIDER:$PI_MODEL"', yield_after: 2 });
    assert.equal(result.structuredContent.exit_code, 0);
    assert.equal(result.structuredContent.background, undefined);
    assert.equal(result.structuredContent.tty, undefined);
    assert.equal(result.isError, undefined);
    assert.match(result.structuredContent.output, /stderr/);
    assert.ok(result.structuredContent.output.includes(s.directory));
    assert.match(result.structuredContent.output, /test-session:test:current-model/);
    assert.equal((await s.list())[0].source, 'model');
    assert.equal(s.exits().length, 0, 'foreground completion is returned only, not sent twice');
    assert.equal(result.structuredContent.full_output_path, undefined);
    assert.equal(result.details, undefined);
    const snapshot = await s.snapshot((await s.list())[0].id);
    assert.equal(statSync(snapshot.outputPath).mode & 0o777, 0o600);
});

test('ordinary foreground calls match native Bash content and structured fields, including empty output and failures', async t => {
    const s = setup(t);
    const native = builtinBash(s.directory);
    for (const command of ["printf 'hello\\n'", 'true', 'false', 'printf failure >&2; exit 7']) {
        const args = { command };
        const expected = await native.execute('native', args, undefined, undefined, s.ctx);
        const actual = await s.run(args);
        assert.deepEqual(actual.content, expected.content, command);
        assert.deepEqual({ ...actual.structuredContent, wall_time_seconds: 0 },
            { ...expected.structuredContent, wall_time_seconds: 0 }, command);
        assert.equal(actual.isError, expected.isError, command);
        assert.equal(actual.details, expected.details, command);
        assert.ok(Number.isFinite(actual.structuredContent.wall_time_seconds));
    }
    assert.equal(s.exits().length, 0);
    assert.equal(s.messages.length, 0, 'no extra context messages for ordinary foreground calls');
});

test('foreground exit errors are structured errors, with no duplicate notification', async t => {
    const s = setup(t);
    const result = await s.run({ command: 'echo failure >&2; exit 7', yield_after: 2 });
    assert.equal(result.structuredContent.exit_code, 7);
    assert.equal(result.isError, true);
    assert.equal(s.exits().length, 0);
});

test('configured foreground interval yields without killing; completion queues exactly one non-interrupting follow-up', async t => {
    const s = setup(t);
    settings.saveBackgroundAfterSeconds(0.02);
    const result = await s.run({ command: 'echo initial; sleep 0.2; echo final-marker' });
    const data = result.structuredContent;
    assert.equal(data.background, true);
    assert.equal(data.exit_code, null);
    assert.equal(data.tty, false);
    assert.ok(data.wall_time_seconds < 1);
    assert.equal((await s.snapshot(data.id)).running, true);
    await until(() => s.exits().length === 1);
    const snapshot = await s.snapshot(data.id);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.exitCode, 0);
    assert.match(snapshot.output, /final-marker/);
    const notice = s.exits()[0];
    assert.deepEqual(notice.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.ok(!notice.message.content.includes('final-marker'), 'output is not automatically injected');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(s.exits().length, 1);
});

test('explicit hard timeout remains active after background handoff', async t => {
    const s = setup(t);
    const data = (await s.run({ command: 'sleep 30', yield_after: 0.01, timeout: 0.15 })).structuredContent;
    assert.equal(data.background, true);
    await until(() => s.exits().length === 1);
    const snapshot = await s.snapshot(data.id);
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.timedOut, true);
    assert.equal(snapshot.signal, 'SIGKILL');
    assert.match(s.exits()[0].message.content, /hard timeout/);
});

test('hard timeout before foreground handoff is an error result, not an extra wakeup', async t => {
    const s = setup(t);
    const result = await s.run({ command: 'sleep 30', yield_after: 2, timeout: 0.05 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.background, undefined);
    assert.equal(result.structuredContent.exit_code, 137);
    assert.equal(result.structuredContent.timed_out, true);
    assert.equal(s.exits().length, 0);
});

test('public ! exits notify once but private !! exits never wake or disclose output to the model', async t => {
    const s = setup(t);
    await s.events.get('user_bash')({ command: 'echo public-marker', cwd: s.directory, excludeFromContext: false }, s.ctx);
    await s.events.get('user_bash')({ command: 'echo private-marker', cwd: s.directory, excludeFromContext: true }, s.ctx);
    await until(async () => (await s.list()).every(entry => !entry.running));
    await until(() => s.exits().length === 1);
    assert.ok(s.messages.every(entry => !entry.message.content.includes('private-marker')));
    assert.equal(s.exits()[0].message.details.id, 'pty-1');
});

test('foreground cancellation kills only that process group; background ownership survives subsequent caller abort', async t => {
    const s = setup(t);
    const controller = new AbortController();
    const run = s.run({ command: 'sleep 30', yield_after: 2 }, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(run);
    await until(async () => !(await s.list())[0].running);
    assert.equal(s.exits().length, 0);
    const later = new AbortController();
    const data = (await s.run({ command: 'sleep 30', yield_after: 0.01 }, later.signal)).structuredContent;
    later.abort();
    assert.equal((await s.snapshot(data.id)).running, true);
    await s.tools.get('pty_stop').execute('', { id: data.id, signal: 'SIGKILL' });
    await until(async () => !(await s.snapshot(data.id)).running);
});

test('TTY mode is opt-in and remains interactively attachable through /fg', async t => {
    const s = setup(t);
    const data = (await s.run({ command: 'test -t 0 && test -t 1 || exit 12; read -r name; echo "hello:$name"; sleep 30', tty: true, yield_after: 0.01 })).structuredContent;
    assert.equal(data.tty, true);
    assert.equal(data.background, true);
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
        const attachment = s.commands.get('fg').handler(data.id, s.ctx);
        await until(() => s.stopped);
        process.stdin.emit('data', Buffer.from('world\r'));
        await until(async () => (await s.snapshot(data.id)).output.includes('hello:world'));
        process.stdin.emit('data', Buffer.from('\x1a'));
        await attachment;
        assert.equal(s.stopped, false);
        assert.equal((await s.snapshot(data.id)).running, true);
    } finally { process.stdout.write = write; process.stdin.pause(); }
    await s.tools.get('pty_stop').execute('', { id: data.id, signal: 'SIGKILL' });
    await until(async () => !(await s.snapshot(data.id)).running);
});

test('pipe /fg is a read-only live viewer, and private !! output and control remain denied to model tools', async t => {
    const s = setup(t);
    const data = (await s.run({ command: 'echo visible; sleep 30', yield_after: 0.02 })).structuredContent;
    const attachment = s.commands.get('fg').handler(data.id, s.ctx);
    await until(() => s.dialog);
    assert.match(s.dialog.render(70).join('\n'), /read-only/);
    assert.match(s.dialog.render(70).join('\n'), /visible/);
    s.dialog.handleInput('text that must never become stdin');
    s.dialog.handleInput('\x1b');
    await attachment;
    assert.equal((await s.snapshot(data.id)).running, true);
    await s.events.get('user_bash')({ command: 'echo private-content; sleep 30', cwd: s.directory, excludeFromContext: true }, s.ctx);
    const secret = (await s.list()).find(entry => entry.private);
    assert.equal(secret.command, '[private !! session]');
    await assert.rejects(s.snapshot(secret.id), /Private/);
    await assert.rejects(s.tools.get('pty_stop').execute('', { id: secret.id }), /Private/);
    assert.ok(s.exits().every(entry => entry.message.details.id !== secret.id));
});

test('large foreground output is bounded with a private full log; logs are removed on shutdown without completion wakeups', async t => {
    const s = setup(t);
    const result = await s.run({ command: 'seq 1 5000', yield_after: 2 });
    const data = result.structuredContent;
    assert.equal(data.truncated, true);
    assert.ok(result.content[0].text.length < 52000);
    assert.match(readFileSync(data.full_output_path, 'utf8'), /^1\n/);
    assert.match(data.output, /5000/);
    const background = (await s.run({ command: 'sleep 30', yield_after: 0.01 })).structuredContent;
    assert.equal(background.full_output_path, undefined);
    const backgroundLog = (await s.snapshot(background.id)).outputPath;
    s.events.get('session_shutdown')();
    assert.equal(existsSync(data.full_output_path), false);
    assert.equal(existsSync(backgroundLog), false);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(s.exits().length, 0);
});

test('works without a TUI and registers Pi Web liveness to protect active jobs from idle eviction', async t => {
    const key = Symbol.for('@agegr/pi-web/session-liveness/v1'), previous = globalThis[key];
    let lease, released = 0;
    globalThis[key] = { version: 1, register(value) { lease = value; return () => released++; } };
    t.after(() => { if (previous === undefined) delete globalThis[key]; else globalThis[key] = previous; });
    const s = setup(t, 'json');
    const data = (await s.run({ command: 'sleep 30', yield_after: 0.01 })).structuredContent;
    assert.equal(lease.sessionId, 'test-session');
    assert.equal(lease.isActive(), true);
    await s.tools.get('pty_stop').execute('', { id: data.id, signal: 'SIGKILL' });
    await until(() => !lease.isActive());
    s.events.get('session_shutdown')();
    assert.equal(released, 1);
});
