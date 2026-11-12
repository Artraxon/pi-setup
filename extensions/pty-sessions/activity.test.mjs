import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { formatProcessElapsed, setup, until } from './managed-fixture.mjs';

const activity = (s, width = 120) => s.widgets.get('pty-host').render(width);
const withoutTime = line => line.replace(/^( *)(pty-\d+) \d+:\d{2}(?::\d{2})? /, '$1$2 ');
const mouse = (y, type = 'click', ctrl = true) => ({ type, button: 'left', ctrl, alt: false, shift: false,
    x: 2, y, width: 120, height: 20, screenX: 2, screenY: y });
const preview = (s, id) => {
    const { message } = s.messages.find(entry => entry.message.customType === 'pty-preview' && entry.message.details.id === id);
    return s.renderers.get('pty-preview')(message, { expanded: false }, s.theme);
};

test('compact view stacks actual live background jobs and restores original previews without losing output', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    const jobs = [];
    for (const name of ['builder', 'tester']) jobs.push((await s.run({
        command: `pi-process status '${name} is working'; echo CAPTURED_${name}; sleep 30`, yield_after: 0,
    })).structuredContent);
    await until(async () => (await s.list()).every(job => job.statusText));
    // Socket status acknowledgements can precede stdout delivery on another fd.
    await until(async () => (await s.snapshot(jobs[0].id)).output.includes('CAPTURED_builder'));
    assert.deepEqual(activity(s).map(withoutTime), [' pty-1 builder is working', ' pty-2 tester is working']);
    assert.match(activity(s)[0], /^ pty-1 \d+:\d{2}(?::\d{2})? builder is working$/);
    assert.ok(!activity(s)[0].includes(' · '));
    const firstPreview = preview(s, jobs[0].id);
    assert.deepEqual(firstPreview.render(120), []);
    assert.match((await s.snapshot(jobs[0].id)).output, /CAPTURED_builder/);
    s.activityDisplayMode = 'inline';
    assert.deepEqual(activity(s), []);
    assert.match(firstPreview.render(120).join('\n'), /CAPTURED_builder/);
    s.activityDisplayMode = 'compact';
    assert.deepEqual(firstPreview.render(120), []);
    await s.tools.get('pty_stop').execute('', { id: jobs[0].id, signal: 'SIGTERM' });
    await until(() => s.exits().length === 1);
    assert.deepEqual(activity(s).map(withoutTime), [' pty-2 tester is working']);
    const notice = s.exits()[0];
    assert.equal(notice.message.display, true, 'notification/context semantics must not be changed to hide UI');
    const exit = s.renderers.get('process-exit')(notice.message, { expanded: false }, s.theme);
    assert.deepEqual(exit.render(120), []);
    s.activityDisplayMode = 'inline';
    assert.match(exit.render(120)[0], /pty-1.*signal SIGTERM/);
});

test('process and overflow rows follow live output padding and omit decorative bullets', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    for (let i = 0; i < 3; i++) await s.run({ command: 'sleep 30', yield_after: 0 });
    s.tui.terminal.rows = 8;
    for (const configured of [0, 1, 3]) {
        s.outputPad = configured;
        const padding = configured === 0 ? 0 : 1;
        const lines = activity(s);
        assert.ok(withoutTime(lines[0]).startsWith(' '.repeat(padding) + 'pty-1 '));
        assert.ok(lines[2].startsWith(' '.repeat(padding) + '+1 background processes'));
        assert.ok(lines.every(line => !line.includes('●')));
    }
});

test('process timers use compact elapsed minutes or hours without dot separators', () => {
    const start = '2026-01-01T00:00:00.000Z', epoch = Date.parse(start);
    for (const [seconds, expected] of [[-2, '0:00'], [0, '0:00'], [9, '0:09'], [61, '1:01'],
        [3599, '59:59'], [3600, '1:00:00'], [3672, '1:01:12']]) {
        assert.equal(formatProcessElapsed(start, epoch + seconds * 1000), expected);
    }
});

test('Ctrl-click expands and collapses live output; plain clicks stay available for copying', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    await s.run({ command: 'echo CLICK_OUTPUT; sleep 30', yield_after: 0 });
    await until(async () => (await s.snapshot('pty-1')).output.includes('CLICK_OUTPUT'));
    const widget = s.widgets.get('pty-host');
    assert.equal(activity(s).length, 1);
    const initial = widget.getActivityRevision();
    assert.equal(widget.handleMouse(mouse(0, 'press', false)), undefined);
    assert.equal(widget.handleMouse(mouse(0, 'click', false)), undefined);
    assert.equal(activity(s).length, 1);
    assert.equal(widget.handleMouse(mouse(0, 'press')).handled, true);
    assert.equal(widget.handleMouse(mouse(0)).handled, true);
    assert.ok(widget.getActivityRevision() > initial);
    assert.match(activity(s).join('\n'), /CLICK_OUTPUT/);
    assert.match(activity(s).join('\n'), /Ctrl\+click to collapse/);
    widget.handleMouse(mouse(0, 'press'));
    widget.handleMouse(mouse(0));
    assert.equal(activity(s).length, 1);
});

test('/fg still opens the live process viewer independently of row expansion', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    await s.run({ command: 'echo VIEW_OUTPUT; sleep 30', yield_after: 0 });
    activity(s);
    const viewing = s.commands.get('fg').handler('pty-1', s.ctx);
    await until(() => s.dialog);
    assert.match(s.dialog.render(120).join('\n'), /pty-1.*no TTY/);
    s.dialog.handleInput('\x1b');
    await viewing;
});

test('a press stays bound to its original process when rows change before the click', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    for (const name of ['FIRST_OUTPUT', 'SECOND_OUTPUT']) await s.run({ command: `echo ${name}; sleep 30`, yield_after: 0 });
    await until(async () => (await s.snapshot('pty-2')).output.includes('SECOND_OUTPUT'));
    const widget = s.widgets.get('pty-host');
    activity(s);
    widget.handleMouse(mouse(1, 'press'));
    await s.tools.get('pty_stop').execute('', { id: 'pty-1', signal: 'SIGTERM' });
    await until(() => s.exits().length === 1);
    activity(s);
    widget.handleMouse(mouse(1));
    assert.match(activity(s).join('\n'), /SECOND_OUTPUT/);
    assert.match(activity(s).join('\n'), /Ctrl\+click to collapse/);
});

test('foreground work is not duplicated as a background activity row', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    const pending = s.run({ command: 'echo foreground; sleep .3', yield_after: 2 });
    await until(async () => (await s.list()).length === 1);
    assert.deepEqual(activity(s), []);
    await pending;
    assert.deepEqual(activity(s), []);
});

test('private metadata and terminal controls cannot escape into compact activity', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    await s.events.get('user_bash')({ command: "pi-process status 'PRIVATE_STATUS'; echo PRIVATE_OUTPUT; sleep 30",
        cwd: s.directory, excludeFromContext: true }, s.ctx);
    const publicJob = (await s.run({ command: "printf 'captured'; pi-process status 'Public status'; sleep 30", yield_after: 0 })).structuredContent;
    await until(async () => (await s.list()).some(job => job.id === publicJob.id && job.statusText));
    const lines = activity(s);
    assert.match(lines[0], /private !! session/);
    assert.ok(!lines.join('\n').includes('PRIVATE_'));
    assert.match(lines[1], /Public status/);
    for (const width of [1, 8, 20, 80]) {
        for (const line of activity(s, width)) {
            assert.ok(stripVTControlCharacters(line).length <= width);
            assert.ok(!/[\x00-\x1f\x7f]/.test(stripVTControlCharacters(line)));
        }
    }
});

test('background activity is bounded on short terminals and absent on legacy Pi', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    for (let i = 0; i < 5; i++) await s.run({ command: `sleep 30 # job ${i}`, yield_after: 0 });
    s.tui.terminal.rows = 8;
    const lines = activity(s);
    assert.equal(lines.length, 3);
    assert.match(lines[2], /\+3 background processes.*\/top/);
    delete s.ctx.ui.getActivityDisplayMode;
    assert.deepEqual(activity(s), []);
    assert.ok(preview(s, 'pty-1').render(120).length > 0, 'stock Pi keeps its existing previews');
});

test('session shutdown removes all active process rows', async t => {
    const s = setup(t);
    s.activityDisplayMode = 'compact';
    await s.run({ command: 'sleep 30', yield_after: 0 });
    assert.equal(activity(s).length, 1);
    s.events.get('session_shutdown')();
    assert.deepEqual(activity(s), []);
});
