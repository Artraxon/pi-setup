import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { linkResources, resources } from "./link-resources.mjs";

function fixture(t) {
    const temporary = mkdtempSync(join(tmpdir(), "pi-links-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const root = join(temporary, "source checkout");
    const agent = join(temporary, "agent");
    for (const resource of resources) {
        const source = join(root, resource);
        if (resource.endsWith(".md")) {
            mkdirSync(dirname(source), { recursive: true });
            writeFileSync(source, "prompt");
        } else {
            mkdirSync(source, { recursive: true });
            writeFileSync(join(source, "index.ts"), "source");
        }
    }
    return { root, agent };
}

test("links all managed resources and exposes source updates without reinstalling", t => {
    const { root, agent } = fixture(t);
    assert.equal(linkResources(root, agent), undefined);
    for (const resource of resources) {
        assert.ok(lstatSync(join(agent, resource)).isSymbolicLink());
        assert.equal(readlinkSync(join(agent, resource)), join(root, resource));
    }
    writeFileSync(join(root, "extensions/kitty-clipboard/index.ts"), "updated");
    assert.equal(readFileSync(join(agent, "extensions/kitty-clipboard/index.ts"), "utf8"), "updated");
    assert.equal(linkResources(root, agent), undefined);
    assert.equal(existsSync(join(agent, "install-backups")), false);
});

test("migrates copies and foreign/dangling links without losing local files or touching other resources", t => {
    const { root, agent } = fixture(t);
    const old = join(agent, "extensions/kitty-clipboard");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "local.ts"), "local changes");
    mkdirSync(join(agent, "prompts"), { recursive: true });
    symlinkSync(join(agent, "missing"), join(agent, "prompts/subagent.md"));
    const foreign = join(agent, "extensions/shared");
    const foreignTarget = join(root, "foreign");
    mkdirSync(foreignTarget);
    writeFileSync(join(foreignTarget, "keep"), "untouched");
    symlinkSync(foreignTarget, foreign);
    writeFileSync(join(agent, "extensions/unrelated.ts"), "custom extension");
    const backup = linkResources(root, agent);
    assert.equal(readFileSync(join(backup, "extensions/kitty-clipboard/local.ts"), "utf8"), "local changes");
    assert.equal(readlinkSync(join(backup, "prompts/subagent.md")), join(agent, "missing"));
    assert.equal(readlinkSync(join(backup, "extensions/shared")), foreignTarget);
    assert.equal(readFileSync(join(foreignTarget, "keep"), "utf8"), "untouched");
    assert.equal(readFileSync(join(agent, "extensions/unrelated.ts"), "utf8"), "custom extension");
    assert.equal(linkResources(root, agent), undefined);
    assert.equal(readdirSync(join(agent, "install-backups")).length, 1);
});

test("validates all sources before changing the installation", t => {
    const { root, agent } = fixture(t);
    rmSync(join(root, "prompts/subagent.md"));
    assert.throws(() => linkResources(root, agent), /Missing source/);
    assert.equal(existsSync(agent), false);
});

test("refuses to replace the checkout itself", t => {
    const { root } = fixture(t);
    assert.throws(() => linkResources(root, root), /Source and destination must differ/);
    assert.equal(lstatSync(join(root, "extensions/kitty-clipboard")).isDirectory(), true);
});
