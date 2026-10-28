// Pi's TUI reference wraps function reads and does not forward deleteProperty.
// Use an object identity token and assignments rather than callback equality/delete.
const cancelKey = Symbol.for('pi.transcript-selection.cancel');
const tokenKey = Symbol.for('pi.transcript-selection.owner');

export function claimSelection(host, token, cancel) {
    host[tokenKey] = token;
    host[cancelKey] = cancel;
}

export function releaseSelection(host, token) {
    if (!host || host[tokenKey] !== token) return;
    host[cancelKey] = undefined;
    host[tokenKey] = undefined;
}

export function cancelSelection(host) {
    const cancel = host?.[cancelKey];
    if (!host || typeof cancel !== 'function') return;
    host[cancelKey] = undefined;
    host[tokenKey] = undefined;
    try { cancel(); }
    catch (error) {
        // Recover a callback left by an older extension version during hot reload.
        // Other errors are still surfaced rather than silently hiding bugs.
        if (!(error instanceof Error && error.message.startsWith('This extension ctx is stale'))) throw error;
    }
}
