import type { TUI } from '@earendil-works/pi-tui';

/**
 * Compatibility fix for Pi 1.5's fullscreen Kitty upload cache.
 *
 * Full redraws emit a lowercase placement delete followed by ED 2 (CSI 2 J).
 * Kitty's grman_clear() then frees image data with no placements, including the
 * just-detached images. Pi must not replace their transmissions with a=p commands
 * in that same frame. Source: kitty/graphics.c, grman_clear() -> filter_refs().
 *
 * Hook the renderer's preparation boundary, not terminal.write: cache state and
 * output commands stay consistent, and ordinary partial redraws keep SSH upload
 * reuse. Work through the actual prototype because Pi can hand us a stable TUI
 * Proxy whose method wrappers rebind themselves when the renderer is replaced.
 */
export function installKittyCacheGuard(host: TUI): () => void {
    if (host.mode !== 'fullscreen') return () => {};
    const prototype = Object.getPrototypeOf(host);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'prepareKittyScreen');
    const original = descriptor?.value;
    const state = host as any;
    if (typeof original !== 'function' || !Array.isArray(state.previousScreen) ||
        !(state.uploadedKittyImages instanceof Map)) return () => {};
    const guarded = function(this: any, screen: string[]) {
        const width = Math.max(1, this.terminal.columns);
        const height = Math.max(1, this.terminal.rows);
        const fullRedraw = this.previousScreen.length === 0 ||
            this.previousScreenWidth !== width || this.previousScreenHeight !== height;
        if (fullRedraw) this.uploadedKittyImages.clear();
        return original.call(this, screen);
    };
    Object.defineProperty(prototype, 'prepareKittyScreen', { ...descriptor, value: guarded });
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        if (prototype.prepareKittyScreen === guarded) Object.defineProperty(prototype, 'prepareKittyScreen', descriptor!);
    };
}
