import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { setup, until } from './managed-fixture.mjs';

function preview(s, id, expanded = false) {
    const message = s.messages.find(entry => entry.message.customType === 'pty-preview' && entry.message.details.id === id).message;
    return s.renderers.get('pty-preview')(message, { expanded }, s.theme).render(120);
}

for (const tty of [false, true]) test(`finished preview hides output but retains expanded history and one compact exit (tty=${tty})`, async t => {
    const s = setup(t);
    const command = 'printf RETAINED_OUTPUT; sleep .15';
    const job = (await s.run({ command, tty, yield_after: 0.01 })).structuredContent;
    assert.equal(job.background, true);
    await until(() => s.exits().length === 1);
    assert.deepEqual(preview(s, job.id), []);
    assert.match(preview(s, job.id, true).join('\n'), /RETAINED_OUTPUT/);
    assert.match((await s.snapshot(job.id)).output, /RETAINED_OUTPUT/);
    const notice = s.exits()[0];
    assert.equal(notice.message.display, true);
    assert.equal(notice.message.details.command, command);
    assert.deepEqual(notice.options, { triggerTurn: true, deliverAs: 'followUp' }, 'agent lifecycle delivery stays unchanged');
    const component = s.renderers.get('process-exit')(notice.message, { expanded: false }, s.theme);
    const lines = component.render(120);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^↩ /u, 'small return arrow');
    assert.match(stripVTControlCharacters(lines[0]), new RegExp(`^↩ ${job.id} · exit 0 · `));
    assert.ok(!lines[0].includes('[process-exit]'), 'custom renderer replaces the purple fallback box');
    assert.ok(!lines[0].includes('Ctrl+O') && !lines[0].includes('Use pty_snapshot'));
    s.events.get('session_shutdown')();
    assert.deepEqual(preview(s, job.id), [], 'old previews remain hidden after process records are disposed');
    assert.match(preview(s, job.id, true).join('\n'), /unavailable/);
    assert.deepEqual(component.render(120), lines, 'exit command and status survive reload without the process map');
});

test('exit summaries distinguish failure, signal and timeout while remaining bounded and safe', async t => {
    const s = setup(t);
    const renderer = s.renderers.get('process-exit');
    const theme = { fg: (color, text) => `[${color}]${text}` };
    for (const [details, expected] of [
        [{ id: 'pty-1', exitCode: 7 }, /\[error\]exit 7/],
        [{ id: 'pty-2', signal: 'SIGTERM' }, /\[error\]signal SIGTERM/],
        [{ id: 'pty-3', exitCode: 137, signal: 'SIGKILL', timedOut: true }, /signal SIGKILL.*hard timeout/],
        [{ id: 'pty-4', exitCode: 0 }, /\[success\]exit 0/],
    ]) {
        const message = { details: { ...details, command: 'echo start\n\x1b[2J\x1b]0;bad-title\x07echo end' } };
        const component = renderer(message, { expanded: false }, theme);
        assert.match(component.render(200)[0], expected);
        assert.match(component.render(200)[0], /^\[customMessageLabel\]↩ /u, 'same themed pink arrow as process messages');
        for (const width of [1, 8, 20, 80]) {
            const lines = component.render(width);
            assert.equal(lines.length, 1);
            const text = stripVTControlCharacters(lines[0]);
            assert.ok(text.length <= width);
            assert.ok(!/[\x00-\x1f\x7f]/.test(text));
            assert.ok(!lines[0].includes('\x1b[2J') && !lines[0].includes('\x1b]0;'));
        }
    }
    // Legacy messages have no saved command; never borrow one from a newly
    // launched process with the same ID after restart.
    const job = (await s.run({ command: 'echo UNRELATED_NEW_COMMAND; sleep 30', yield_after: 0 })).structuredContent;
    const legacy = renderer({ details: { id: job.id, exitCode: 0 } }, {}, s.theme).render(120)[0];
    assert.ok(!legacy.includes('UNRELATED_NEW_COMMAND'));
    assert.doesNotThrow(() => renderer({}, {}, s.theme).render(20));
});

test('failed and timed-out jobs also suppress finished output and notify exactly once', async t => {
    const s = setup(t);
    for (const args of [
        { command: 'echo FAILURE_OUTPUT; sleep .15; exit 7', yield_after: 0.01 },
        { command: 'echo TIMEOUT_OUTPUT; sleep 30', yield_after: 0.01, timeout: 0.15 },
    ]) {
        const job = (await s.run(args)).structuredContent;
        await until(() => s.exits().some(entry => entry.message.details.id === job.id));
        assert.deepEqual(preview(s, job.id), []);
        assert.match(preview(s, job.id, true).join('\n'), /OUTPUT/);
        assert.equal(s.exits().filter(entry => entry.message.details.id === job.id).length, 1);
    }
});
