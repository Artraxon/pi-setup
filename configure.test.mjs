import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { configure, configureModels, configureSettings } from "./configure.mjs";

test("API limits override only the two models' context windows", () => {
    const config = { providers: {
        custom: { baseUrl: "http://localhost:8000" },
        openai: { modelOverrides: {
            "gpt-6.1-sol": { contextWindow: 272000, maxTokens: 128000 },
            "other": { contextWindow: 8192 },
        } },
    } };
    const expected = structuredClone(config);
    expected.providers.openai.modelOverrides["gpt-6.1-sol"].contextWindow = 1050000;
    expected.providers.openai.modelOverrides["gpt-6-astra"] = { contextWindow: 1050000 };
    assert.deepEqual(configureModels(config), expected);
    assert.deepEqual(configureModels(config), expected);
});

test("disables codemode while preserving unrelated settings and tool selections", () => {
    for (const defaultTools of [undefined, ["+codemode"], ["read", "bash", "codemode"], ["+edit", "-codemode"]]) {
        const settings = { theme: "dark", extensions: ["custom", "+builtin:codemode"], defaultTools };
        const result = configureSettings(settings);
        assert.equal(result.theme, "dark");
        assert.deepEqual(result.extensions, ["custom", "-builtin:codemode"]);
        assert.deepEqual(result.defaultTools, [...(defaultTools ?? []).filter((v) => !v.includes("codemode")), "-codemode"]);
        const once = structuredClone(result);
        assert.deepEqual(configureSettings(result), once);
    }
});

test("CLI honors PI_CODING_AGENT_DIR and installation is repeatable", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-config-test-"));
    try {
        writeFileSync(join(dir, "settings.json"), JSON.stringify({ externalEditor: "vim", defaultTools: ["+codemode"] }));
        const run = () => spawnSync(process.execPath, [new URL("./configure.mjs", import.meta.url).pathname], {
            env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: "utf8",
        });
        assert.equal(run().status, 0);
        const models = readFileSync(join(dir, "models.json"), "utf8");
        const settings = readFileSync(join(dir, "settings.json"), "utf8");
        assert.equal(JSON.parse(models).providers.openai.modelOverrides["gpt-6-astra"].contextWindow, 1050000);
        assert.equal(JSON.parse(settings).externalEditor, "vim");
        assert.equal(run().status, 0);
        assert.equal(readFileSync(join(dir, "models.json"), "utf8"), models);
        assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), settings);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("malformed configuration fails without overwriting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-config-invalid-"));
    try {
        writeFileSync(join(dir, "models.json"), "invalid JSON");
        assert.throws(() => configure(dir), SyntaxError);
        assert.equal(readFileSync(join(dir, "models.json"), "utf8"), "invalid JSON");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
