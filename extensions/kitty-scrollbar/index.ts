import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { HStack, ScrollView } from '@earendil-works/pi-tui';

export const GUTTER_COLUMNS = 1;

export function isKittySsh(env = process.env): boolean {
    const kitty = env.TERM === 'xterm-kitty' || Boolean(env.KITTY_WINDOW_ID) || env.TERM_PROGRAM === 'kitty';
    if (!kitty) return false;
    if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY || env.KITTY_SSH_KITTEN_DATA_DIR) return true;
    // Some devcontainer launchers retain Kitty's remote helper PATH but drop
    // SSH_* variables. A real local Kitty child has KITTY_PID; a kitten-SSH
    // remote child normally does not. SSH_AUTH_SOCK alone is not an SSH session.
    return !env.KITTY_PID && (env.PATH ?? '').split(':').some(
        path => /(?:^|\/)kitty-ssh-kitten\/kitty\/bin\/?$/.test(path));
}

// Pi 1.5's fullscreen root is internal. Keep that access in the bridge below;
// compose the actual gutter with built-in stacks so drawing and hit-testing
// agree. Replace only the transcript entry, leaving the input dock full width.
export function insetTranscript(root: any): (() => void) | undefined {
    const seen = new Set<any>();
    function visit(parent: any): (() => void) | undefined {
        if (!parent || seen.has(parent)) return;
        seen.add(parent);
        if (!Array.isArray(parent.entries) || !Array.isArray(parent.children)) return;
        for (const entry of parent.entries) {
            const original = entry?.component;
            if (original instanceof ScrollView && original.primary) {
                const index = parent.children?.indexOf(original) ?? -1;
                if (index < 0) return;
                const gutter = { render: () => [], invalidate() {} };
                const wrapper = new HStack([
                    { component: original, basis: 0, grow: 1, shrink: 1, minSize: 1 },
                    { component: gutter, basis: GUTTER_COLUMNS, grow: 0, shrink: 1, minSize: 0, maxSize: GUTTER_COLUMNS },
                ]);
                entry.component = wrapper;
                parent.children[index] = wrapper;
                root.invalidate?.();
                return () => {
                    // Do not overwrite another extension's subsequent changes.
                    if (entry.component === wrapper) entry.component = original;
                    if (parent.children[index] === wrapper) parent.children[index] = original;
                    root.invalidate?.();
                };
            }
            const restore = visit(original);
            if (restore) return restore;
        }
    }
    return visit(root);
}

export default function kittyScrollbar(pi: ExtensionAPI) {
    let dispose: (() => void) | undefined;
    pi.on('session_start', (_event, ctx) => {
        dispose?.(); dispose = undefined;
        if (ctx.mode !== 'tui' || !isKittySsh()) return;
        let live = true, queued = false;
        let mounted: any;
        let restore: (() => void) | undefined;
        dispose = () => { live = false; restore?.(); restore = undefined; };
        ctx.ui.setWidget('kitty-scrollbar-bridge', host => {
            // Stable TUI references follow regular/fullscreen renderer switches.
            const tui = host as any;
            const sync = () => {
                queued = false;
                if (!live || tui.layoutRoot === mounted) return;
                restore?.(); restore = undefined;
                mounted = tui.layoutRoot;
                if (mounted) restore = insetTranscript(mounted);
                tui.requestRender();
            };
            sync();
            return {
                render: () => {
                    if (live && !queued && tui.layoutRoot !== mounted) {
                        queued = true;
                        // Never mutate the layout tree in the middle of a render.
                        queueMicrotask(sync);
                    }
                    return [];
                },
                invalidate() {},
            };
        });
    });
    pi.on('session_shutdown', () => { dispose?.(); dispose = undefined; });
}
