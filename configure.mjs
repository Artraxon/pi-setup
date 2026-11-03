import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// API context windows, not the 272K long-context pricing threshold.
// https://developers.openai.com/api/docs/models
export function configureModels(config) {
    config.providers ??= {};
    config.providers.openai ??= {};
    const provider = config.providers.openai;
    provider.modelOverrides ??= {};
    for (const id of ["gpt-6.1-sol", "gpt-6-astra"]) {
        provider.modelOverrides[id] = {
            ...provider.modelOverrides[id],
            contextWindow: 1_050_000,
        };
    }
    return config;
}

export function configureSettings(settings) {
    // Clipboard staging now uses Pi's native editor/input pipeline. Remove the
    // formerly installed paster package so its editor and preview hooks cannot
    // run alongside ours. Unrelated package declarations/resources are retained.
    if (Array.isArray(settings.packages)) settings.packages = settings.packages.filter(entry => {
        const source = typeof entry === "string" ? entry : entry?.source;
        return typeof source !== "string" || !(/^npm:pi-paster(?:@[^/]*)?$/.test(source)
            || /^git:(?:https:\/\/)?github\.com\/beowulf11\/pi-paster(?:\.git)?(?:@.*)?$/.test(source));
    });
    settings.extensions = (settings.extensions ?? []).filter(
        (entry) => !["builtin:codemode", "+builtin:codemode", "-builtin:codemode"].includes(entry),
    );
    settings.extensions.push("-builtin:codemode");
    settings.defaultTools = (settings.defaultTools ?? []).filter(
        (entry) => !["codemode", "+codemode", "-codemode"].includes(entry),
    );
    settings.defaultTools.push("-codemode");
    return settings;
}

export function configure(agentDir) {
    mkdirSync(agentDir, { recursive: true });
    for (const [name, update] of [
        ["models.json", configureModels],
        ["settings.json", configureSettings],
    ]) {
        const path = join(agentDir, name);
        let config;
        try {
            config = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            config = {};
        }
        writeFileSync(path, `${JSON.stringify(update(config), null, 2)}\n`, { mode: 0o600 });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    configure(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}
