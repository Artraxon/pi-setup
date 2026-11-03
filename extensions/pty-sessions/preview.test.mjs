import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
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

test('background previews are passive, not deferred to the next user/model turn', async t => {
    const s = setup(t);
    const job = (await s.run({ command: 'sleep 30', yield_after: 0 })).structuredContent;
    const previews = s.messages.filter(entry => entry.message.customType === 'pty-preview');
    assert.equal(previews.length, 1);
    assert.equal(previews[0].message.details.id, job.id);
    assert.deepEqual(previews[0].options, { triggerTurn: false },
        'Pi should append after the current tool batch, without steering or waiting for another prompt');
    assert.equal(s.exits().length, 0);
});

for (const tty of [false, true]) test(`startup output and parser errors never write to Pi stdout/stderr (tty=${tty})`, () => {
    // Run outside node:test's worker protocol so both native/inherited fd writes
    // and console diagnostics are observed without intercepting test-runner IPC.
    const fixture = new URL('./managed-fixture.mjs', import.meta.url).href;
    const command = `printf '\\033[2J\\033[H\\033]0;CHILD_TITLE\\007\\033[31mCHILD_START\\033[0m\\rprogress\\n';
        printf '\\033[1\\302\\240m';
        for n in $(seq 1 40); do printf 'startup-line-%s\\n' "$n"; done;
        printf 'child-stderr\\n' >&2; sleep .25; printf 'CHILD_READY\\n'; sleep 30`;
    const script = String.raw`
        import assert from 'node:assert/strict';
        import { stripVTControlCharacters } from 'node:util';
        import { setup, until } from ${JSON.stringify(fixture)};
        const cleanup = [], updates = [];
        const s = setup({ after(fn) { cleanup.push(fn); } });
        try {
            const job = (await s.run(${JSON.stringify({ command, tty, yield_after: 0.15 })},
                undefined, update => updates.push(update))).structuredContent;
            await until(async () => (await s.snapshot(job.id)).output.includes('CHILD_READY'));
            assert.equal(job.background, true);
            assert.ok(updates.length > 0, 'foreground streaming exercised');
            assert.match((await s.snapshot(job.id)).output, /child-stderr/);
            const message = s.messages.find(entry => entry.message.customType === 'pty-preview').message;
            for (const width of [20, 40, 120]) {
                const lines = s.renderers.get('pty-preview')(message, { expanded: false }, s.theme).render(width);
                assert.ok(lines.length <= 10, 'collapsed preview stays bounded');
                for (const line of lines) {
                    assert.ok(stripVTControlCharacters(line).length <= width, 'preview must fit the Pi layout');
                    assert.ok(!/[\x00-\x1f\x7f]/.test(line.replace(/\x1b\[[0-9;]*m/g, '')),
                        'child terminal controls must not escape through preview lines');
                }
            }
            // The same parser also captures private !! sessions: malformed
            // private output must never appear in console diagnostics either.
            await s.events.get('user_bash')({ command: ${JSON.stringify(command.replace('sleep 30', 'true'))},
                cwd: s.directory, excludeFromContext: true }, s.ctx);
            await until(async () => (await s.list()).some(entry => entry.private && !entry.running));
        } finally { for (const fn of cleanup.reverse()) fn(); }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '', 'child output must remain captured');
    assert.equal(child.stderr, '', 'xterm parser diagnostics must not bypass Pi rendering');
});

test('ordinary shell output remains visible in collapsed previews', async t => {
    const s = setup(t);
    const job = (await s.run({ command: `printf 'SHELL_%s_OUTPUT\\n' NORMAL; sleep 30`, tty: true, yield_after: 0.01 })).structuredContent;
    await until(async () => (await s.snapshot(job.id)).screen.includes('SHELL_NORMAL_OUTPUT'));
    assert.ok(render(s).includes('SHELL_NORMAL_OUTPUT'));
});
