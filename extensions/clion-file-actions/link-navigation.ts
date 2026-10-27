import { isKeyRelease, matchesKey } from '@earendil-works/pi-tui';
import { extractFileReferences, type FileReference } from './clion.ts';

const ownerKey = Symbol.for('pi.transcript-selection.cancel');
// Only real rendered OSC 8 links are navigated. Ordinary web URLs are excluded.
const links = /\x1b\]8;[^;\x07]*;([^\x07\x1b]+)(?:\x07|\x1b\\)([\s\S]*?)\x1b\]8;;(?:\x07|\x1b\\)/g;
type Target = { component: any; url: string; reference: FileReference; y: number };

export function installLinkNavigation(host: any, theme: any, ctx: any, open: (reference: FileReference) => void): () => void {
    let selected: Target | undefined;
    let restore: (() => void) | undefined;
    function clear() {
        restore?.(); restore = undefined; selected = undefined;
        if (host[ownerKey] === clear) delete host[ownerKey];
        ctx.ui.setStatus('clion-link-selection', undefined);
        host.requestRender();
    }
    function collect(): Target[] {
        const result: Target[] = [];
        const seen = new Set<any>();
        function componentVisit(component: any, y: number, width: number) {
            if (seen.has(component)) return;
            seen.add(component);
            if (component.lastMessage?.role === 'assistant') {
                const urls = new Set<string>();
                const lines: string[] = component.render(width);
                lines.forEach((line, row) => {
                    for (const match of line.matchAll(links)) {
                        if (urls.has(match[1])) continue;
                        urls.add(match[1]);
                        const references = extractFileReferences(match[1], ctx.cwd);
                        if (references.length === 1) result.push({ component, url: match[1], reference: references[0], y: y + row });
                    }
                });
                return;
            }
            const children = component.mouseLayout?.width === width ? component.mouseLayout.children :
                (component.children ?? []).map((child: any) => ({ component: child, height: child.render(width).length }));
            let top = y;
            for (const child of children) { componentVisit(child.component, top, width); top += child.height; }
        }
        function visit(box: any) {
            if (box.children.length && box.component.lastMessage?.role !== 'assistant') {
                for (const child of box.children) visit(child);
            } else componentVisit(box.component, box.rect.y, box.rect.width);
        }
        if (host.currentLayout) visit(host.currentLayout.root);
        return result.sort((a, b) => a.y - b.y);
    }
    function move(direction: number) {
        const previous = selected;
        host[ownerKey]?.();
        clear();
        const targets = collect();
        if (!targets.length) { ctx.ui.notify('No rendered project-file links found.', 'info'); return; }
        const index = targets.findIndex(target => target.component === previous?.component && target.url === previous?.url);
        const next = index < 0 ? targets.length - 1 : Math.max(0, Math.min(targets.length - 1, index + direction));
        selected = targets[next];
        const target = selected;
        const original = target.component.render;
        target.component.render = function(width: number) {
            const lines: string[] = original.call(this, width);
            return lines.map(line => line.replace(links, (whole, url, body) => {
                if (url !== target.url) return whole;
                // Reverse video remains visible even if theme selection and
                // message backgrounds are similar. Preserve the OSC 8 target.
                const highlighted = '\x1b[7m' + body.replace(/\x1b\[[0-9;:]*m/g, (s: string) => s + '\x1b[7m') + '\x1b[27m';
                const closeStart = whole.lastIndexOf('\x1b]8;;');
                return whole.slice(0, closeStart - body.length) + highlighted + whole.slice(closeStart);
            }));
        };
        restore = () => { target.component.render = original; };
        host[ownerKey] = clear;
        ctx.ui.setStatus('clion-link-selection', `CLion: ${target.reference.label} · Alt+K/J moves · Enter opens · Esc cancels`);
        const scroll = host.getPrimaryScrollView?.();
        let viewport: any;
        function find(box: any) {
            if (box.scrollView === scroll) viewport = box.rect;
            for (const child of box.children) find(child);
        }
        if (scroll && host.currentLayout) find(host.currentLayout.root);
        if (viewport) {
            if (target.y < viewport.y) scroll.scrollBy(target.y - viewport.y);
            else if (target.y >= viewport.y + viewport.height) scroll.scrollBy(target.y - viewport.y - viewport.height + 1);
        }
        host.requestRender();
    }
    const removeInput = ctx.ui.onTerminalInput((data: string) => {
        if (isKeyRelease(data)) return;
        const focus = host.getFocusedComponent?.();
        if (!focus || typeof focus.getText !== 'function' || typeof focus.setText !== 'function' || host.hasOverlay?.()) return;
        if (matchesKey(data, 'alt+k') || matchesKey(data, 'alt+j')) {
            move(matchesKey(data, 'alt+k') ? -1 : 1);
            return { consume: true };
        }
        if (!selected) return;
        if (matchesKey(data, 'enter')) {
            const reference = selected.reference;
            clear(); open(reference);
            return { consume: true };
        }
        if (matchesKey(data, 'escape')) { clear(); return { consume: true }; }
        clear();
    });
    return () => { clear(); removeInput(); };
}
