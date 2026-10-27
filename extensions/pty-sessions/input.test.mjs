import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForegroundInput, interruptForeground } from './input.mjs';
import { Sessions } from './sessions.mjs';

test('legacy, Kitty and modifyOtherKeys shortcuts, including split sequences', () => {
    let output = '', interrupts = 0, detaches = 0;
    const input = new ForegroundInput(data => output += data.toString(), () => interrupts++, () => detaches++);
    input.feed(Buffer.from('hello\x03'));
    input.feed(Buffer.from('\x1b[99;'));
    input.feed(Buffer.from('5u'));
    input.feed(Buffer.from('\x1b[99;5:3u')); // Key release must not interrupt twice.
    input.feed(Buffer.from('\x1b[27;5;99~'));
    input.feed(Buffer.from('\x1b[122;5u'));
    assert.equal(output, 'hello');
    assert.equal(interrupts, 3);
    assert.equal(detaches, 1);
    input.feed(Buffer.from('\x1b'));
    input.flush();
    assert.equal(output, 'hello\x1b');
});

test('encoded Ctrl+C interrupts real top; unrelated detached PTY stays alive', async t => {
    const sessions = new Sessions();
    t.after(() => sessions.dispose());
    const top = sessions.start('top', process.cwd(), false, 80, 24);
    const background = sessions.start('sleep 30', process.cwd(), false, 80, 24);
    const until = async predicate => {
        const end = Date.now() + 4000;
        while (!predicate()) {
            if (Date.now() > end) throw new Error('top regression timed out');
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    };
    await until(() => top.log.includes('Tasks:'));
    const decoder = new ForegroundInput(data => top.process.write(data), () => interruptForeground(top), () => {});
    decoder.feed(Buffer.from('\x1b[99;5u'));
    await until(() => !top.running);
    assert.equal(background.running, true);
});
