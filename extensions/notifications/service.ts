import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { NotificationChannel, notificationLabel } from './channel.ts';
import { NotificationDelivery } from './delivery.ts';
import { registerNotificationReports } from './reports.ts';

const SERVICE = 'pi-local-notifications:service/v3';

// Share the inbox/delivery service through Pi's bus, not a global singleton.
// Sockets themselves belong to individual consumers and never get shared.
export function getNotificationService(pi: ExtensionAPI) {
    let existing;
    pi.events.emit(SERVICE, { accept(service) { existing = service; } });
    if (existing && !existing.closed) return existing;
    let context;
    const external = new Map();
    const channel = new NotificationChannel({ onNotify: messages => delivery.dispatch(messages) });
    const delivery = new NotificationDelivery(pi, channel, () => context, () => {
        try { context?.ui.notify('Notification delivery failed; retained for a later retry.', 'warning'); } catch {}
    });
    registerNotificationReports(pi);
    const service = {
        version: 3,
        get closed() { return channel.closed; },
        create(label, options = {}) { return channel.create(label, options); },
    };
    const unsubscribe = pi.events.on(SERVICE, request => request.accept(service));
    pi.on('session_start', (_event, ctx) => { context = ctx; delivery.reset(); });
    pi.on('session_shutdown', () => {
        unsubscribe(); delivery.close(); channel.close(); external.clear(); context = undefined;
    });
    pi.registerCommand('create-socket', {
        description: 'Create/show a labeled external notification socket',
        handler: async (args, ctx) => {
            if (!args.trim()) { ctx.ui.notify('Usage: /create-socket LABEL', 'error'); return; }
            try {
                const label = notificationLabel(args);
                let endpoint = external.get(label);
                if (!endpoint || endpoint.closed) { endpoint = service.create(label); external.set(label, endpoint); }
                const env = endpoint.environment();
                ctx.ui.notify(`Socket: ${endpoint.path}\nLabel: ${endpoint.label}\nHelper: ${env.PI_NOTIFY_HELPER}\nUse: ${env.PI_NOTIFY_HELPER} --socket ${endpoint.path} notify "Finished"\nReload closes sockets, not external programs.`, 'info');
            } catch (error) { ctx.ui.notify(error.message, 'error'); }
        },
    });
    pi.registerCommand('list-sockets', {
        description: 'List active notification socket labels and paths',
        handler: async (args, ctx) => {
            if (args.trim()) { ctx.ui.notify('Usage: /list-sockets', 'error'); return; }
            const list = [...channel.endpoints.values()].map(endpoint => `${endpoint.label}: ${endpoint.path}`);
            ctx.ui.notify(list.join('\n') || 'No active sockets.', 'info');
        },
    });
    pi.registerCommand('close-socket', {
        description: 'Close a labeled external notification socket',
        handler: async (args, ctx) => {
            if (!args.trim()) { ctx.ui.notify('Usage: /close-socket LABEL', 'error'); return; }
            try {
                const label = notificationLabel(args);
                const endpoint = external.get(label);
                if (!endpoint) throw new Error('No external endpoint with that label.');
                endpoint.close(); external.delete(label); ctx.ui.notify(`Closed: ${label}`, 'info');
            } catch (error) { ctx.ui.notify(error.message, 'error'); }
        },
    });
    return service;
}
