import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const resources = [
    ...[
        "clion-file-actions", "compact-tools", "output-editor", "kitty-clipboard",
        "shared", "extract", "zsh-completion", "shell-colors", "notifications",
        "pty-sessions", "message-selection",
    ].map(name => `extensions/${name}`),
    "skills/subagent",
    "prompts/subagent.md",
];

// Keep old copies (including local changes and node_modules) outside discovery.
// Do not copy through or remove files inside an existing symlink destination.
export function linkResources(root, agentDir) {
    root = resolve(root);
    agentDir = resolve(agentDir);
    for (const resource of resources) {
        if (!existsSync(join(root, resource))) throw new Error(`Missing source: ${join(root, resource)}`);
        if (join(root, resource) === join(agentDir, resource)) throw new Error("Source and destination must differ");
    }
    let backupDir;
    for (const resource of resources) {
        const source = join(root, resource);
        const destination = join(agentDir, resource);
        let existing;
        try {
            existing = lstatSync(destination);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        if (existing?.isSymbolicLink() && readlinkSync(destination) === source) continue;
        if (existing) {
            if (!backupDir) {
                const backups = join(agentDir, "install-backups");
                mkdirSync(backups, { recursive: true });
                backupDir = mkdtempSync(join(backups, "resources-"));
            }
            const backup = join(backupDir, resource);
            mkdirSync(dirname(backup), { recursive: true });
            renameSync(destination, backup);
        }
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(source, destination);
        console.log(`Linked ${destination} -> ${source}`);
    }
    if (backupDir) console.log(`Previous resources preserved in ${backupDir}`);
    return backupDir;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const root = dirname(fileURLToPath(import.meta.url));
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(process.env.HOME, ".pi", "agent");
    linkResources(root, agentDir);
}
