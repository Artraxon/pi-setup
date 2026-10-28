import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export function editorCommand(cwd: string): string {
    let configured: string | undefined;
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent');
    for (const path of [join(agentDir, 'settings.json'), join(cwd, '.pi/settings.json')]) {
        try {
            const value = JSON.parse(readFileSync(path, 'utf8')).externalEditor;
            if (typeof value === 'string' && value.trim()) configured = value;
        } catch { /* Missing settings use the environment/default editor. */ }
    }
    return configured || process.env.VISUAL || process.env.EDITOR || 'vim';
}

export async function captureBlob(host: any, command: string, initialText = ''): Promise<string | undefined> {
    const directory = await mkdtemp(join(tmpdir(), 'pi-extract-'));
    const path = join(directory, 'source.txt');
    try {
        await writeFile(path, initialText, { mode: 0o600 });
        host.stop();
        try {
            const code = await new Promise<number | null>((resolve, reject) => {
                // The editor command is trusted local configuration. The file
                // path is supplied separately through a quoted environment var.
                const child = spawn(`${command} "$PI_EXTRACT_FILE"`, {
                    shell: true, stdio: 'inherit', env: { ...process.env, PI_EXTRACT_FILE: path },
                });
                child.once('error', reject);
                child.once('close', resolve);
            });
            if (code !== 0) return undefined;
            return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '');
        } finally {
            host.start();
            host.requestRender(true);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
