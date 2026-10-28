import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Sessions } from './sessions.ts';

async function until(predicate, timeout = 6000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('Process test timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}
function start(sessions, command, options = {}) {
    return sessions.start(command, process.cwd(), false, 60, 10, '/bin/bash', '', { tty: false, source: 'model', ...options });
}

test('pipe process handles split UTF-8 and sanitizes snapshots without a TTY', async t => {
    const sessions = new Sessions(); t.after(() => sessions.dispose());
    const session = start(sessions, `python3 -c 'import os,time; b="€".encode(); os.write(1,b[:1]); time.sleep(.02); os.write(1,b[1:]); os.write(2,b" error\\n")'`);
    await session.done;
    const snapshot = await sessions.snapshot(session.id);
    assert.equal(snapshot.exitCode, 0);
    assert.match(snapshot.output, /€/);
    assert.doesNotMatch(snapshot.output, /�/);
    assert.match(snapshot.output, /error/);
    assert.equal(snapshot.tty, false);
});

test('disk capture is capped at 16 MiB and reports incompleteness; shutdown removes logs', async t => {
    const sessions = new Sessions(); t.after(() => sessions.dispose());
    const session = start(sessions, 'head -c 16777217 /dev/zero');
    await session.done;
    assert.equal(statSync(session.outputPath).size, 16 * 1024 * 1024);
    assert.equal(session.outputFileTruncated, true);
    assert.ok(session.log.length <= 1_000_000);
    const file = session.outputPath;
    sessions.dispose();
    assert.equal(existsSync(file), false);
});

test('spawn errors become exited records and are delivered once', async t => {
    let exits = 0;
    const sessions = new Sessions(() => {}, () => exits++); t.after(() => sessions.dispose());
    const session = sessions.start('true', process.cwd(), false, 60, 10, '/not/a/shell', '', { tty: false });
    await session.done;
    await until(() => exits === 1);
    assert.equal(session.exitCode, 127);
    assert.match(session.log, /spawn failed/i);
});

test('private PTY output has no log file, model stop is denied, and the shared registry enforces a 16-process limit', async t => {
    const sessions = new Sessions(); t.after(() => sessions.dispose());
    const secret = sessions.start('echo secret; sleep 30', process.cwd(), true, 60, 10);
    assert.equal(secret.outputPath, undefined);
    assert.throws(() => sessions.stop(secret.id), /Private/);
    for (let i = 0; i < 15; i++) start(sessions, 'sleep 30');
    assert.throws(() => start(sessions, 'true'), /16 running/);
    assert.equal(sessions.sessions.size, 16);
});

test('group stop terminates a normal descendant job, not an unrelated session', async t => {
    const sessions = new Sessions(); t.after(() => sessions.dispose());
    const session = start(sessions, 'sleep 30 & echo "$!"; wait');
    const unrelated = start(sessions, 'sleep 30');
    await until(() => /\d+/.test(session.log));
    const child = Number(session.log.trim());
    sessions.stop(session.id, 'SIGKILL');
    await session.done;
    await until(() => {
        try { return readFileSync(`/proc/${child}/stat`, 'utf8').split(') ')[1].startsWith('Z'); }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    });
    assert.equal(unrelated.running, true);
});
