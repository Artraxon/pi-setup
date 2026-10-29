import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sendNotification } from '../notifications/pi-notify.mjs';

// Compatibility adapter. Identity and private-job policy belong to the endpoint,
// not the sender's environment or message.
export function sendProcessMessage(type, text, { env = process.env, ...options } = {}) {
    return sendNotification(type, text, { ...options, env, socket: env.PI_PROCESS_SOCKET || env.PI_NOTIFY_SOCKET });
}
export async function main(args = process.argv.slice(2)) {
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('Usage: pi-process status|notify "text"\nManaged-job adapter for pi-notify. Empty status clears it. Private jobs do not notify by default.');
        return;
    }
    if (args.length !== 2 || !['status', 'notify'].includes(args[0])) throw new Error('Usage: pi-process status|notify "text"');
    await sendProcessMessage(args[0], args[1]);
}
let isMain = false;
try { isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (isMain) {
    try { await main(); } catch (error) { console.error(`pi-process: ${error.message}`); process.exitCode = 1; }
}
