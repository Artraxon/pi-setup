import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup } from './managed-fixture.mjs';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable), { createJiti } = require('jiti');
const source = fileURLToPath(new URL('./', import.meta.url));

test('two Pi-style loads refresh process, inbox and endpoint helpers despite a cached legacy native-ESM module', async t => {
    const directory = mkdtempSync('/tmp/pi-reload-test-');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    symlinkSync(join(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const legacy = join(directory, 'sessions.mjs');
    writeFileSync(legacy, 'export class Sessions { legacy = true; }');
    const old = await import(pathToFileURL(legacy).href);
    assert.equal(new old.Sessions().channel, undefined, 'the formerly cached backend has no channel');
    const backend = readFileSync(join(source, 'sessions.ts'), 'utf8');
    const ipc = readFileSync(new URL('../notifications/channel.ts', import.meta.url), 'utf8');
    const endpoint = readFileSync(new URL('../notifications/endpoint.ts', import.meta.url), 'utf8');
    const entry = join(directory, 'index.ts');
    writeFileSync(entry, `export { Sessions } from './sessions.ts'; export { NotificationChannel } from './channel.ts';`);
    function version(number) {
        writeFileSync(join(directory, 'sessions.ts'), `${backend}\nSessions.prototype.reloadVersion = ${number};\n`);
        writeFileSync(join(directory, 'channel.ts'), `${ipc}\nNotificationChannel.prototype.reloadVersion = ${number};\n`);
        writeFileSync(join(directory, 'endpoint.ts'), `${endpoint}\nNotificationEndpoint.prototype.reloadVersion = ${number};\n`);
    }
    version(1);
    // Match Pi's loader: a new Jiti instance with moduleCache:false, same paths.
    const first = await createJiti(import.meta.url, { moduleCache: false }).import(entry);
    const initial = new first.Sessions(); t.after(() => initial.dispose());
    assert.equal(initial.reloadVersion, 1);
    const initialChannel = new first.NotificationChannel(); t.after(() => initialChannel.close());
    assert.equal(initialChannel.reloadVersion, 1);
    const firstEndpoint = initialChannel.create('first'); assert.equal(firstEndpoint.reloadVersion, 1);
    assert.equal(initial.notifications, undefined, 'process backend does not create a notification service');
    version(2);
    const second = await createJiti(import.meta.url, { moduleCache: false }).import(entry);
    const reloaded = new second.Sessions(); t.after(() => reloaded.dispose());
    assert.equal(reloaded.reloadVersion, 2);
    const reloadedChannel = new second.NotificationChannel(); t.after(() => reloadedChannel.close());
    assert.equal(reloadedChannel.reloadVersion, 2);
    const secondEndpoint = reloadedChannel.create('second'); assert.equal(secondEndpoint.reloadVersion, 2);
    assert.notEqual(firstEndpoint.constructor, secondEndpoint.constructor);
    assert.equal(typeof reloadedChannel.scheduleFlush, 'function');
    assert.equal(typeof reloaded.write, 'function');
    assert.notEqual(initial.constructor, reloaded.constructor);
    assert.notEqual(initialChannel.constructor, reloadedChannel.constructor);
});

test('agent_end is safe before any process launch and after runtime shutdown', t => {
    const s = setup(t);
    assert.doesNotThrow(() => s.events.get('agent_end')({}, s.ctx));
    assert.deepEqual(s.messages, []);
    s.events.get('session_shutdown')();
    assert.doesNotThrow(() => s.events.get('agent_end')({}, s.ctx));
});
