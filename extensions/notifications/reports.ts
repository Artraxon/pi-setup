import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, Text, truncateToWidth } from '@earendil-works/pi-tui';

const singleLine = (value: string) => stripTerminalSequences(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();

export function registerNotificationReports(pi: ExtensionAPI) {
    pi.registerMessageRenderer('process-message', (message, options, theme) => {
        const data = (message.details as { notifications?: unknown } | undefined)?.notifications;
        const reports = Array.isArray(data) ? data.flatMap(entry =>
            entry && typeof entry.id === 'string' && typeof entry.text === 'string'
                ? [`${singleLine(entry.id)} · ${singleLine(entry.text)}`] : []) : [];
        const fallback = typeof message.content === 'string' ? message.content : Array.isArray(message.content)
            ? message.content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join(' ') : '';
        const lines = reports.length ? reports : [singleLine(fallback) || 'Process message'];
        const icon = theme.fg('customMessageLabel', '↩ ');
        if (options.expanded) return new Text(lines.map(line => icon + theme.fg('muted', line)).join('\n'), 0, 0);
        return {
            render(width: number) {
                return [truncateToWidth(icon + theme.fg('muted', lines.join(' ; ')), width, '…')];
            },
            invalidate() {},
        };
    });
}
