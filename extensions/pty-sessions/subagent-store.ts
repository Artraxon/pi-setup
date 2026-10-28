// Standard-library-only, JS-compatible TypeScript: also imported by the launcher.
import { constants, openSync, closeSync, fstatSync, readSync, writeFileSync, renameSync, rmSync,
    mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
export function privateDirectory(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Subagent directory must not be a symlink.');
    chmodSync(directory, 0o700);
}
export function writeRecord(directory, name, value) {
    privateDirectory(directory);
    const data = JSON.stringify(value);
    if (Buffer.byteLength(data) > MAX_RESULT_BYTES) throw new Error('Subagent result exceeds the 8 MiB storage limit.');
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
        writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, join(directory, name));
    } finally { rmSync(temporary, { force: true }); }
}
export function readRecord(directory, name) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid subagent directory.');
    const fd = openSync(join(directory, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_RESULT_BYTES) throw new Error('Invalid or oversized subagent result file.');
        // Bound the actual read too: an untrusted child can grow a file after fstat.
        const buffer = Buffer.alloc(stat.size + 1);
        let bytes = 0;
        while (bytes < buffer.length) {
            const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
            if (!count) break;
            bytes += count;
        }
        if (bytes !== stat.size) throw new Error('Subagent result changed during reading. Retry once settled.');
        return JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    } finally { closeSync(fd); }
}
export const turnFile = turn => `turn-${String(turn).padStart(6, '0')}.json`;
export function initializeSubagent(directory, id) {
    if (!/^pty-\d+$/.test(id)) throw new Error('Expected a managed process ID.');
    privateDirectory(directory);
    const sessionDirectory = join(directory, 'sessions');
    privateDirectory(sessionDirectory);
    // A process can launch only one result-producing interactive child at a time.
    // Reuse would make old notifications ambiguous; start a fresh managed process.
    try { readRecord(directory, 'subagent.json'); throw new Error('This process already has a subagent workspace.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    writeRecord(directory, 'subagent.json', { version: 1, kind: 'pi-subagent', id, createdAt: new Date().toISOString() });
    writeRecord(directory, 'latest.json', { version: 1, id, turn: 0, status: 'idle', output: '' });
    return sessionDirectory;
}
export function readResult(directory, id, turn) {
    if (turn !== undefined && (!Number.isSafeInteger(turn) || turn < 1)) throw new Error('Invalid subagent turn number.');
    const manifest = readRecord(directory, 'subagent.json');
    if (manifest.version !== 1 || manifest.kind !== 'pi-subagent' || manifest.id !== id) throw new Error('Subagent workspace does not match this process.');
    const result = readRecord(directory, turn === undefined ? 'latest.json' : turnFile(turn));
    if (result.version !== 1 || result.id !== id || !Number.isSafeInteger(result.turn) || result.turn < 0 || (result.status !== 'idle' && result.turn < 1) ||
        !['idle', 'running', 'completed', 'aborted', 'error'].includes(result.status) || typeof result.output !== 'string' ||
        (turn !== undefined && result.turn !== turn)) throw new Error('Invalid subagent result record.');
    return result;
}

// Never search older assistant messages: a current tool-only/error turn must not
// accidentally return a prior turn's successful answer. getBranch is active-branch aware.
export function finalResponse(branch, startingLeaf, aborted) {
    const start = startingLeaf === null ? -1 : branch.findIndex(entry => entry.id === startingLeaf);
    if (startingLeaf !== null && start < 0) return { status: 'error', output: '', error: 'The active branch changed during the run.' };
    const entry = branch.slice(start + 1).reverse().find(item => item.type === 'message' && item.message?.role === 'assistant');
    const message = entry?.message;
    if (aborted || message?.stopReason === 'aborted') return { status: 'aborted', output: '' };
    if (!message || message.stopReason !== 'stop' || !Array.isArray(message.content) || message.content.some(part => part.type === 'toolCall')) {
        return { status: 'error', output: '', error: message?.errorMessage || 'No completed final assistant response for this run.' };
    }
    return { status: 'completed', output: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n'), entryId: entry.id };
}
