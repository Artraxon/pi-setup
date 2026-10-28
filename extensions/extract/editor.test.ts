import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBlob, editorCommand } from './editor.ts';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

test('external editor captures the blob with private temp permissions and restores the TUI', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'extract-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const marker = join(directory, 'path');
    const script = `const fs=require('fs'),p=process.argv[1];if((fs.statSync(p).mode&511)!==384)process.exit(2);fs.writeFileSync(${JSON.stringify(marker)},p);fs.writeFileSync(p,'pasted source\\n');`;
    const events: string[] = [];
    const host = { stop: () => events.push('stop'), start: () => events.push('start'), requestRender: () => events.push('render') };
    const result = await captureBlob(host, `${quote(process.execPath)} -e ${quote(script)}`);
    assert.equal(result, 'pasted source\n');
    assert.deepEqual(events, ['stop', 'start', 'render']);
    assert.equal(existsSync(readFileSync(marker, 'utf8')), false);
});

test('external editor receives a complete prefilled file rather than simulated terminal input', async () => {
    const blob = 'large source\n'.repeat(10000);
    const script = "if(!require('fs').readFileSync(process.argv[1],'utf8').startsWith('large source'))process.exit(1)";
    const result = await captureBlob({ stop() {}, start() {}, requestRender() {} }, `${quote(process.execPath)} -e ${quote(script)}`, blob);
    assert.equal(result, blob);
});

test('nonzero editor exit cancels without input, and externalEditor setting takes priority', async t => {
    let starts = 0;
    const result = await captureBlob({ stop() {}, start() { starts++; }, requestRender() {} }, `${quote(process.execPath)} -e 'process.exit(1)'`);
    assert.equal(result, undefined);
    assert.equal(starts, 1);
    const directory = mkdtempSync(join(tmpdir(), 'extract-settings-'));
    const original = process.env.PI_CODING_AGENT_DIR;
    t.after(() => {
        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = original;
        rmSync(directory, { recursive: true, force: true });
    });
    process.env.PI_CODING_AGENT_DIR = directory;
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ externalEditor: 'vim -f' }));
    assert.equal(editorCommand(directory), 'vim -f');
});
