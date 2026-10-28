import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup, until } from './managed-fixture.mjs';

function render(s, expanded = false) {
    const message = s.messages.find(entry => entry.message.customType === 'pty-preview').message;
    return s.renderers.get('pty-preview')(message, { expanded }, s.theme).render(120).join('\n');
}

test('collapsed full-screen previews suppress child startup headers, including after Ctrl+Z', async t => {
    const s = setup(t);
    const job = (await s.run({ command: `printf '\\033[?1049h\\033[HCHILD_%s_STARTUP' PI; sleep 30`, tty: true, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(job.id)).screen.includes('CHILD_PI_STARTUP'));
    assert.ok(!render(s).includes('CHILD_PI_STARTUP'));
    assert.ok(render(s).includes(job.id));
    assert.match(render(s), /Ctrl\+click to attach/);
    assert.ok(render(s, true).includes('CHILD_PI_STARTUP'));
    const write = process.stdout.write;
    process.stdout.write = () => true;
    try {
        const attachment = s.commands.get('fg').handler(job.id, s.ctx);
        await until(() => s.stopped);
        process.stdin.emit('data', Buffer.from('\x1a'));
        await attachment;
    } finally { process.stdout.write = write; process.stdin.pause(); }
    assert.equal(s.stopped, false);
    assert.equal((await s.snapshot(job.id)).running, true);
    assert.ok(!render(s).includes('CHILD_PI_STARTUP'));
    assert.ok(render(s, true).includes('CHILD_PI_STARTUP'));
    assert.ok((await s.snapshot(job.id)).screen.includes('CHILD_PI_STARTUP'));
});

test('ordinary shell output remains visible in collapsed previews', async t => {
    const s = setup(t);
    const job = (await s.run({ command: `printf 'SHELL_%s_OUTPUT\\n' NORMAL; sleep 30`, tty: true, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(job.id)).screen.includes('SHELL_NORMAL_OUTPUT'));
    assert.ok(render(s).includes('SHELL_NORMAL_OUTPUT'));
});
