import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions, screenLines } from './sessions.ts';

async function until(predicate, timeout = 4000) {
    const end = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() > end) throw new Error('PTY test timed out');
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}

function manager(t) {
    const sessions = new Sessions();
    t.after(() => sessions.dispose());
    return sessions;
}

test('commands see a TTY and screen snapshots apply carriage-return animations', async t => {
    const sessions = manager(t);
    const session = sessions.start(`test -t 0 && test -t 1 && echo tty; printf '\\033[31mold\\rnew\\033[0m\\n'`, process.cwd(), false, 40, 8);
    await until(() => !session.running);
    const snapshot = await sessions.snapshot(session.id);
    assert.equal(snapshot.exitCode, 0);
    assert.equal(snapshot.cols, 40);
    assert.match(snapshot.screen, /^tty\nnew\n/);
    assert.doesNotMatch(snapshot.screen, /old|\x1b/);
    assert.match(screenLines(session).join('\n'), /\x1b\[0;38;5;1mnew/);
});

test('expanded rendering includes retained scrollback rather than only the viewport', async t => {
    const sessions = manager(t);
    const session = sessions.start('seq 1 50', process.cwd(), false, 40, 8);
    await until(() => !session.running);
    await session.ready;
    const collapsed = screenLines(session);
    const expanded = screenLines(session, true);
    assert.equal(collapsed.length, 8);
    assert.ok(expanded.length > 8);
    const plain = expanded.join('\n').replace(/\x1b\[[0-9;:]*m/g, '');
    assert.match(plain, /^1\s*\n/);
    assert.match(plain, /\n50\s*\n/);
});

test('private snapshots are denied and model lists redact private commands', async t => {
    const sessions = manager(t);
    const session = sessions.start('printf secret', process.cwd(), true, 40, 8);
    await until(() => !session.running);
    await assert.rejects(sessions.snapshot(session.id), /Private/);
    assert.equal(sessions.list()[0].command, '[private !! session]');
    assert.equal(sessions.list(false)[0].command, 'printf secret');
    assert.match((await sessions.snapshot(session.id, false)).screen, /secret/);
});

test('interactive stdin and Ctrl+C target only the session receiving input', async t => {
    const sessions = manager(t);
    const foreground = sessions.start('read -r name; echo "hello:$name"; sleep 30', process.cwd(), false, 40, 8);
    const background = sessions.start('sleep 30', process.cwd(), false, 40, 8);
    foreground.process.write('world\r');
    await until(() => foreground.log.includes('hello:world'));
    foreground.process.write('\x03');
    await until(() => !foreground.running);
    assert.equal(background.running, true);
    assert.match((await sessions.snapshot(foreground.id)).screen, /hello:world/);
});

test('alternate screen and cursor addressing are interpreted, not exposed as controls', async t => {
    const sessions = manager(t);
    const session = sessions.start(`printf '\\033[?1049h\\033[2J\\033[3;5Hpanel'; sleep 0.15`, process.cwd(), false, 40, 8);
    await until(() => !session.running);
    const snapshot = await sessions.snapshot(session.id);
    assert.equal(snapshot.screen.split('\n')[2], '    panel');
    assert.equal(snapshot.cursor.y, 2);
    assert.equal(snapshot.cursor.x, 9);
});
