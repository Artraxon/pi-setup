import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { linkProjectReferences } from './references.ts';
import { installInlineFileHandler } from './inline.ts';

function setup(t: any) {
    const directory = mkdtempSync(join(tmpdir(), 'clion-links-'));
    const root = join(directory, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const file of ['src/Foo.cpp', 'src/has spaces.cpp', 'README.md', 'LICENSE']) writeFileSync(join(root, file), '');
    writeFileSync(join(directory, 'outside.cpp'), '');
    symlinkSync(join(directory, 'outside.cpp'), join(root, 'escape.cpp'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return root;
}

test('project-file prose and inline references become coordinate-preserving CLion-compatible links', t => {
    const root = setup(t);
    const input = 'See `src/Foo.cpp:42:8`, README.md and `src/has spaces.cpp#L7`. Also `LICENSE`.';
    const expected = 'See [src/Foo.cpp:42:8](src/Foo.cpp#L42C8), [README.md](README.md) and [src/has spaces.cpp:7](src/has%20spaces.cpp#L7). Also [LICENSE](LICENSE).';
    assert.equal(linkProjectReferences(input, root), expected);
    assert.equal(linkProjectReferences(expected, root), expected, 'transform is idempotent');
    assert.equal(linkProjectReferences(`See \`${root}/src/Foo.cpp:3\`.`, root), 'See [src/Foo.cpp:3](src/Foo.cpp#L3).');
});

test('commands, fenced/indented code, unfinished streaming code, existing links and URLs remain literal', t => {
    const root = setup(t);
    const unchanged = [
        '`bash src/Foo.cpp`',
        '```sh\ncat src/Foo.cpp\n```',
        '~~~diff\n+src/Foo.cpp\n~~~',
        '```sh\ncat src/Foo.cpp',
        '    cat src/Foo.cpp',
        '\tcat src/Foo.cpp',
        'Run `cat src/Foo.cpp',
        '[source](src/Foo.cpp#L2) ![image](README.md)',
        '[web](https://example.org/src/Foo.cpp) https://example.org/README.md',
        '<https://example.org/src/Foo.cpp>',
    ];
    for (const text of unchanged) assert.equal(linkProjectReferences(text, root), text);
});

test('generated targets, including extensionless files, dispatch through CLion rather than the browser', t => {
    const root = setup(t);
    const opened: any[] = [], browser: string[] = [];
    const tui = { openUrl(url: string) { browser.push(url); } };
    const remove = installInlineFileHandler(tui, root, reference => opened.push(reference));
    for (const input of ['`LICENSE`', '`src/has spaces.cpp:7:2`']) {
        const rendered = linkProjectReferences(input, root);
        const target = rendered.match(/\]\(([^)]+)\)/)![1];
        tui.openUrl(target);
    }
    assert.equal(browser.length, 0);
    assert.deepEqual(opened.map(({file, line, column}) => ({file, line, column})), [
        {file: 'LICENSE', line: undefined, column: undefined},
        {file: 'src/has spaces.cpp', line: 7, column: 2},
    ]);
    remove();
});

test('never creates links for missing files, directories, traversal, outside files or escaping symlinks', t => {
    const root = setup(t);
    const input = '`missing.cpp` `src/` `../outside.cpp` `escape.cpp`';
    assert.equal(linkProjectReferences(input, root), input);
    assert.equal(linkProjectReferences('src/Foo.cpp', join(root, 'missing-root')), 'src/Foo.cpp');
});
