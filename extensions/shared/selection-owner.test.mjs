import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { claimSelection, releaseSelection, cancelSelection } from './selection-owner.mjs';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const root = resolve(dirname(executable), '../..');
const { createInteractiveTuiReference } = await import(resolve(root, 'dist/modes/interactive/tui-renderer.js'));
const cancelKey = Symbol.for('pi.transcript-selection.cancel');

test('ownership works through real Pi function wrappers and non-forwarded delete operations', () => {
    const target = {}, host = createInteractiveTuiReference(() => target), token = {};
    let calls = 0;
    const callback = () => calls++;
    claimSelection(host, token, callback);
    assert.notEqual(host[cancelKey], callback, 'Pi returns a fresh callable wrapper');
    releaseSelection(host, {});
    assert.equal(typeof target[cancelKey], 'function', 'another owner cannot clear this one');
    releaseSelection(host, token);
    assert.equal(target[cancelKey], undefined);
    claimSelection(host, token, callback);
    cancelSelection(host);
    assert.equal(calls, 1);
    assert.equal(target[cancelKey], undefined);
});

test('handoff clears the old slot before cancellation and old cleanup preserves the new owner', () => {
    const target = {}, host = createInteractiveTuiReference(() => target), old = {}, current = {};
    let calls = 0;
    claimSelection(host, old, () => {
        assert.equal(target[cancelKey], undefined);
        releaseSelection(host, old);
    });
    cancelSelection(host);
    claimSelection(host, current, () => calls++);
    releaseSelection(host, old);
    cancelSelection(host);
    assert.equal(calls, 1);
});

test('legacy stale-context callbacks are recovered but unrelated failures are not hidden', () => {
    const target = {}, host = createInteractiveTuiReference(() => target);
    target[cancelKey] = () => { throw new Error('This extension ctx is stale after session replacement or reload.'); };
    assert.doesNotThrow(() => cancelSelection(host));
    assert.equal(target[cancelKey], undefined);
    target[cancelKey] = () => { throw new Error('Unexpected selection failure'); };
    assert.throws(() => cancelSelection(host), /Unexpected selection failure/);
    assert.equal(target[cancelKey], undefined);
});
