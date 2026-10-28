import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup } from './managed-fixture.mjs';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const require = createRequire(executable), { createJiti } = require('jiti');
const source = fileURLToPath(new URL('./', import.meta.url));

test('two Pi-style loads refresh both backend helpers despite a cached legacy native-ESM module', async t => {
    const directory = mkdtempSync('/tmp/pi-reload-test-');
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    symlinkSync(join(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
    copyFileSync(join(source, 'pi-process.mjs'), join(directory, 'pi-process.mjs'));
    const legacy = join(directory, 'sessions.mjs');
    writeFileSync(legacy, 'export class Sessions { legacy = true; }');
    const old = await import(pathToFileURL(legacy).href);
    assert.equal(new old.Sessions().channel, undefined, 'the formerly cached backend has no channel');
    const backend = readFileSync(join(source, 'sessions.ts'), 'utf8');
    const ipc = readFileSync(join(source, 'ipc.ts'), 'utf8');
    const entry = join(directory, 'index.ts');
    writeFileSync(entry, `export { Sessions } from './sessions.ts';`);
    function version(number) {
        writeFileSync(join(directory, 'sessions.ts'), `${backend}\nSessions.prototype.reloadVersion = ${number};\n`);
        writeFileSync(join(directory, 'ipc.ts'), `${ipc}\nProcessChannel.prototype.reloadVersion = ${number};\n`);
    }
    version(1);
    // Match Pi's loader: a new Jiti instance with moduleCache:false, same paths.
    const first = await createJiti(import.meta.url, { moduleCache: false }).import(entry);
    const initial = new first.Sessions(); t.after(() => initial.dispose());
    assert.equal(initial.reloadVersion, 1);
    assert.equal(initial.channel.reloadVersion, 1);
    version(2);
    const second = await createJiti(import.meta.url, { moduleCache: false }).import(entry);
    const reloaded = new second.Sessions(); t.after(() => reloaded.dispose());
    assert.equal(reloaded.reloadVersion, 2);
    assert.equal(reloaded.channel.reloadVersion, 2);
    assert.equal(typeof reloaded.channel.scheduleFlush, 'function');
    assert.equal(typeof reloaded.write, 'function');
    assert.notEqual(initial.constructor, reloaded.constructor);
    assert.notEqual(initial.channel.constructor, reloaded.channel.constructor);
});

test('agent_end is safe before any process launch and after runtime shutdown', t => {
    const s = setup(t);
    assert.doesNotThrow(() => s.events.get('agent_end')({}, s.ctx));
    assert.deepEqual(s.messages, []);
    s.events.get('session_shutdown')();
    assert.doesNotThrow(() => s.events.get('agent_end')({}, s.ctx));
});
