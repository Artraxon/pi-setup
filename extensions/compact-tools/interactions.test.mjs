import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { jiti } from '../pty-sessions/managed-fixture.mjs';

const executable = realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim());
const root = resolve(dirname(executable), '../..'), require = createRequire(executable);
const { Text } = await import(pathToFileURL(require.resolve('@earendil-works/pi-tui')).href);
const { initTheme } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/theme/theme.js')).href);
const { ToolExecutionComponent } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/components/tool-execution.js')).href);
const { CustomMessageComponent } = await import(pathToFileURL(resolve(root, 'dist/modes/interactive/components/custom-message.js')).href);
const { default: compactTools } = await jiti.import(fileURLToPath(new URL('./index.ts', import.meta.url)));
initTheme('dark');
const mouse = (type, ctrl) => ({ type, ctrl, button: 'left', alt: false, shift: false,
    x: 3, y: 1, width: 120, height: 20, screenX: 3, screenY: 1 });

test('one-line tool summaries expand only on Ctrl-click, preserving plain selection', () => {
    let resolver;
    compactTools({ on() {}, registerToolRenderer(fn) { resolver = fn; } });
    const renderers = resolver('read', () => ({
        renderCall: () => new Text('FULL_CALL', 0, 0),
        renderResult: () => new Text('FULL_RESULT', 0, 0),
    }));
    const tool = new ToolExecutionComponent('read', 'call-1', { path: 'demo.txt' },
        { showImages: false }, renderers, { requestRender() {} }, process.cwd());
    tool.updateResult({ content: [{ type: 'text', text: 'result' }], isError: false });
    assert.ok(!tool.render(120).join('\n').includes('FULL_RESULT'));
    assert.equal(tool.handleMouse(mouse('press', false)), undefined);
    assert.equal(tool.handleMouse(mouse('click', false)), undefined);
    assert.ok(!tool.render(120).join('\n').includes('FULL_RESULT'));
    assert.equal(tool.handleMouse(mouse('press', true)).handled, true);
    assert.equal(tool.handleMouse(mouse('click', true)).handled, true);
    assert.match(tool.render(120).join('\n'), /FULL_CALL.*\n.*FULL_RESULT/s);
    tool.handleMouse(mouse('press', true));
    tool.handleMouse(mouse('click', true));
    assert.ok(!tool.render(120).join('\n').includes('FULL_RESULT'));
});

test('custom process/report summaries use the same Ctrl-click expansion gesture', () => {
    const message = new CustomMessageComponent({ role: 'custom', customType: 'demo', content: 'demo',
        display: true, timestamp: Date.now() }, (_message, { expanded }) =>
        new Text(expanded ? 'FULL_CUSTOM_DETAILS' : 'CUSTOM_SUMMARY', 0, 0));
    assert.match(message.render(120).join('\n'), /CUSTOM_SUMMARY/);
    assert.equal(message.handleMouse(mouse('press', false)), undefined);
    assert.equal(message.handleMouse(mouse('click', false)), undefined);
    assert.equal(message.handleMouse(mouse('press', true)).handled, true);
    message.handleMouse(mouse('click', true));
    assert.match(message.render(120).join('\n'), /FULL_CUSTOM_DETAILS/);
    message.handleMouse(mouse('press', true));
    message.handleMouse(mouse('click', true));
    assert.match(message.render(120).join('\n'), /CUSTOM_SUMMARY/);
});
