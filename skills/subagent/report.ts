import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { finalResponse, readRecord, readResult, turnFile, writeRecord } from '../../extensions/pty-sessions/subagent-store.ts';
import { sendProcessMessage } from '../../extensions/pty-sessions/pi-process.mjs';

// Explicitly loaded by launch.mjs, even though discovered extensions are disabled.
// All long-lived work begins at lifecycle events, never in the factory.
export default function reportSubagent(pi: ExtensionAPI) {
    const directory = process.env.PI_SUBAGENT_DIR, id = process.env.PI_PROCESS_ID;
    if (!directory || !id || process.env.PI_PROCESS_PRIVATE === '1') return;
    let active = true, turn = 0, startingLeaf: string | null = null, sessionId: string | undefined;
    const send = async (type: 'status' | 'notify', text: string) => {
        if (!active) return;
        try { await sendProcessMessage(type, text); } catch { /* Results remain readable if the parent is gone/rate-limited/private. */ }
    };
    pi.on('session_start', () => { active = true; });
    pi.on('session_shutdown', () => { active = false; });
    pi.on('before_agent_start', async (_event, ctx) => {
        const previous = readResult(directory, id);
        turn = previous.turn + 1;
        startingLeaf = ctx.sessionManager.getLeafId();
        sessionId = ctx.sessionManager.getSessionId();
        writeRecord(directory, 'latest.json', { version: 1, id, turn, status: 'running', output: '', sessionId });
        await send('status', `Working (turn ${turn})`);
    });
    pi.on('agent_settled', async (event, ctx) => {
        if (!active || !turn) return;
        const latest = readRecord(directory, 'latest.json');
        if (latest.status !== 'running' || latest.turn !== turn) return; // No duplicate settlement reports.
        let response = ctx.sessionManager.getSessionId() === sessionId
            ? finalResponse(ctx.sessionManager.getBranch(), startingLeaf, event.aborted)
            : { status: 'error', output: '', error: 'The child session changed during the run.' };
        const metadata = { version: 1, id, turn, sessionId, sessionFile: ctx.sessionManager.getSessionFile(), completedAt: new Date().toISOString() };
        let result = { ...metadata, ...response };
        try {
            // Commit the immutable turn artifact and the current pointer BEFORE notification.
            writeRecord(directory, turnFile(turn), result);
            writeRecord(directory, 'latest.json', result);
        } catch (error) {
            result = { ...metadata, status: 'error', output: '', error: 'Could not save the final response; inspect the saved child session.' };
            writeRecord(directory, turnFile(turn), result);
            writeRecord(directory, 'latest.json', result);
        }
        await send('status', result.status === 'completed' ? `Result ready (turn ${turn})` : `${result.status} (turn ${turn})`);
        await send('notify', `Subagent turn ${turn} ${result.status}; retrieve with subagent_result.`);
    });
}
