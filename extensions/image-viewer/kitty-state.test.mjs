import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KittyState } from './kitty-state.mjs';

test('protocol oracle distinguishes retained graphics deletes from ED 2 freeing orphaned data', () => {
    const state = new KittyState();
    state.consume('\x1b_Ga=T,f=100,i=7;YWJj\x1b\\');
    assert.ok(state.images.has('7')); assert.ok(state.placements.has('7'));
    state.consume('\x1b_Ga=d,d=a,q=2\x1b\\');
    assert.ok(state.images.has('7')); assert.equal(state.placements.size, 0);
    state.consume('\x1b_Ga=p,i=7,q=2\x1b\\');
    assert.ok(state.placements.has('7')); assert.deepEqual(state.missingPlacements, []);
    // This is precisely Pi's old full-redraw ordering: remove placements,
    // clear the text screen, then try to place an image whose data was freed.
    state.consume('\x1b_Ga=d,d=a,q=2\x1b\\\x1b[2J\x1b_Ga=p,i=7,q=2\x1b\\');
    assert.equal(state.images.size, 0); assert.equal(state.placements.size, 0);
    assert.deepEqual(state.missingPlacements, ['7']);
});

test('protocol oracle waits for final chunk before displaying a transmitted image', () => {
    const state = new KittyState();
    state.consume('\x1b_Ga=T,f=100,i=8,m=1;YWJj\x1b\\');
    assert.equal(state.images.size, 0); assert.equal(state.placements.size, 0);
    state.consume('\x1b_Gm=0;ZA==\x1b\\');
    assert.ok(state.images.has('8')); assert.ok(state.placements.has('8'));
    state.consume('\x1b_Ga=d,d=I,i=8,q=2\x1b\\');
    assert.equal(state.images.size, 0); assert.equal(state.placements.size, 0);
});
