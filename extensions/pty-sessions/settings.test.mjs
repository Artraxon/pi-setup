import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, settings, extractSettings } from './managed-fixture.mjs';

test('foreground wait defaults to 15 seconds, persists arbitrary values, and validates configuration', t => {
    const s = setup(t);
    assert.equal(settings.backgroundAfterSeconds(), 15);
    settings.saveBackgroundAfterSeconds(2.5);
    assert.equal(settings.backgroundAfterSeconds(), 2.5);
    assert.equal(JSON.parse(readFileSync(join(s.directory, 'processes.json'))).backgroundAfterSeconds, 2.5);
    settings.saveBackgroundAfterSeconds(0);
    assert.equal(settings.backgroundAfterSeconds(), 0);
    for (const value of [-1, NaN, Infinity, 86401]) assert.throws(() => settings.saveBackgroundAfterSeconds(value));
    writeFileSync(join(s.directory, 'processes.json'), '{bad');
    assert.throws(() => settings.backgroundAfterSeconds(), /Cannot read/);
});

test('native /settings exposes an editable wait interval; shared hooks coexist and restore cleanly in either order', t => {
    const s = setup(t);
    const previous = s.tui.setFocus;
    const removeExtraction = extractSettings.installSettingsRow(s.tui, s.theme, s.ctx);
    const list = { items: [{ id: 'theme' }, { id: 'tui-mode' }], applyFilter() {} };
    s.tui.setFocus(list);
    s.tui.setFocus(list);
    assert.equal(list.items.filter(item => item.id === 'bash-background-after').length, 1);
    assert.equal(list.items.filter(item => item.id === 'extract-model').length, 1);
    let selected;
    const menu = list.items.find(item => item.id === 'bash-background-after').submenu('', value => selected = value);
    menu.handleInput('\x15');
    menu.handleInput('2.5');
    menu.handleInput('\r');
    assert.equal(selected, '2.5 s');
    assert.equal(settings.backgroundAfterSeconds(), 2.5);
    // Extraction removes its contribution first while the process hook remains.
    removeExtraction();
    const fresh = { items: [{ id: 'theme' }, { id: 'tui-mode' }], applyFilter() {} };
    s.tui.setFocus(fresh);
    assert.ok(fresh.items.some(item => item.id === 'bash-background-after'));
    assert.ok(!fresh.items.some(item => item.id === 'extract-model'));
    s.events.get('session_shutdown')();
    // The fixture's initial function is the same as the saved original below
    // both shared subscriptions (not the shared wrapper itself).
    assert.notEqual(s.tui.setFocus, previous);
    assert.equal(Object.getOwnPropertySymbols(s.tui).length, 0);
    // Reverse order also preserves the remaining extension's subscription.
    const removeA = extractSettings.installSettingsRow(s.tui, s.theme, s.ctx);
    const removeB = settings.installProcessSettings(s.tui, s.theme, s.ctx);
    removeB();
    const last = { items: [{ id: 'theme' }, { id: 'tui-mode' }], applyFilter() {} };
    s.tui.setFocus(last);
    assert.ok(last.items.some(item => item.id === 'extract-model'));
    assert.ok(!last.items.some(item => item.id === 'bash-background-after'));
    removeA();
    assert.equal(Object.getOwnPropertySymbols(s.tui).length, 0);
});
