import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { isKeyRelease, matchesKey, stripTerminalSequences, truncateToWidth } from '@earendil-works/pi-tui';

import { cancelSelection as cancelCurrentSelection, claimSelection, releaseSelection } from '../shared/selection-owner.mjs';

type Component = any;
type Block = { component: Component; y: number; height: number; text: () => string; kind: string };

function text(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n\n');
}

function semantic(component: Component): { text: () => string; kind: string } | undefined {
    if (typeof component.toolCallId === 'string') {
        return { kind: `tool: ${component.toolName}`, text: () => stripTerminalSequences(text(component.result?.content)) };
    }
    if (component.lastMessage?.role === 'assistant') {
        if (!text(component.lastMessage.content).trim()) return;
        return { kind: 'assistant', text: () => text(component.lastMessage.content) };
    }
    if (component.constructor?.name === 'UserMessageComponent') {
        return { kind: 'user', text: () => component.text };
    }
    if (component.constructor?.name === 'BashExecutionComponent') {
        return { kind: 'shell output', text: () => stripTerminalSequences(component.getOutput()) };
    }
}

// Fullscreen layout keeps off-screen blocks in its scroll content. Ordinary
// Containers are opaque to that layout, but retain their own mouse-height cache.
export function collectBlocks(root: any): Block[] {
    const blocks: Block[] = [];
    const seen = new Set<Component>();
    function componentVisit(component: Component, y: number, height: number, width: number) {
        if (seen.has(component)) return;
        seen.add(component);
        const block = semantic(component);
        if (block) { blocks.push({ component, y, height, ...block }); return; }
        const children = component.mouseLayout?.width === width ? component.mouseLayout.children :
            (component.children ?? []).map((child: Component) => ({ component: child, height: child.render(width).length }));
        let top = y;
        for (const child of children) {
            componentVisit(child.component, top, child.height, width);
            top += child.height;
        }
    }
    function visit(box: any) {
        const block = semantic(box.component);
        if (block) {
            if (!seen.has(box.component)) blocks.push({ component: box.component, y: box.rect.y, height: box.rect.height, ...block });
            seen.add(box.component);
        } else if (box.children.length) {
            for (const child of box.children) visit(child);
        } else componentVisit(box.component, box.rect.y, box.rect.height, box.rect.width);
    }
    visit(root);
    return blocks.sort((a, b) => a.y - b.y);
}

export default function messageSelection(pi: ExtensionAPI) {
    let host: any;
    let theme: any;
    let selected: Component | undefined;
    let restore: (() => void) | undefined;
    let removeInput: (() => void) | undefined;

    const owner = {};
    let latestContext: ExtensionContext | undefined;

    function clear() {
        restore?.(); restore = undefined; selected = undefined;
        releaseSelection(host, owner);
        latestContext?.ui.setStatus('message-selection', undefined);
        host?.requestRender();
    }

    function reveal(component: Component) {
        const layout = host?.currentLayout;
        if (!layout) return;
        const block = collectBlocks(layout.root).find(item => item.component === component);
        const scroll = host.getPrimaryScrollView?.();
        if (!block || !scroll) return;
        let viewport: any;
        const visit = (box: any) => {
            if (box.scrollView === scroll) viewport = box.rect;
            for (const child of box.children) visit(child);
        };
        visit(layout.root);
        if (!viewport) return;
        const visibleBottom = viewport.y + viewport.height;
        const delta = block.y < viewport.y ? block.y - viewport.y :
            block.y >= visibleBottom ? block.y - viewport.y :
            block.height <= viewport.height && block.y + block.height > visibleBottom ? block.y + block.height - visibleBottom : 0;
        if (delta) scroll.scrollBy(delta);
    }

    function move(direction: number, ctx: ExtensionContext) {
        if (!host?.currentLayout) return;
        const blocks = collectBlocks(host.currentLayout.root);
        if (!blocks.length) return;
        const index = blocks.findIndex(block => block.component === selected);
        const next = index < 0 ? blocks.length - 1 : Math.max(0, Math.min(blocks.length - 1, index + direction));
        cancelCurrentSelection(host);
        clear();
        claimSelection(host, owner, clear);
        const block = blocks[next];
        selected = block.component;
        const original = selected.render;
        const target = selected;
        target.render = function(width: number) {
            const contentWidth = Math.max(1, width - 2);
            const lines: string[] = original.call(this, contentWidth);
            const background = theme.getBgAnsi('selectedBg');
            const marker = theme.fg('accent', '▎ ');
            // Sent prompts render their own backgrounds inside the line. Reapply
            // selection after every SGR so nested styles cannot cover it up.
            return lines.map(line => truncateToWidth(marker + theme.bg('selectedBg', truncateToWidth(line, contentWidth)
                .replace(/\x1b\[[0-9;:]*m/g, sequence => sequence + background)), width));
        };
        restore = () => { target.render = original; };
        ctx.ui.setStatus('message-selection', `${block.kind} · Ctrl+K/J moves · Enter copies to prompt · Esc cancels`);
        reveal(target);
        host.requestRender();
    }

    pi.on('session_start', (_event, ctx) => {
        if (ctx.mode !== 'tui') return;
        latestContext = ctx;
        ctx.ui.setWidget('message-selection-host', (tui, currentTheme) => {
            host = tui; theme = currentTheme;
            return { render: () => [], invalidate() {} };
        });
        removeInput?.();
        removeInput = ctx.ui.onTerminalInput(data => {
            if (ctx !== latestContext || isKeyRelease(data)) return;
            // Do not steal dialog/list controls or keys from custom screens.
            const focus = host?.getFocusedComponent?.();
            if (!focus || typeof focus.getText !== 'function' || typeof focus.setText !== 'function' || host.hasOverlay?.()) return;
            if (matchesKey(data, 'ctrl+k') || matchesKey(data, 'ctrl+j')) {
                move(matchesKey(data, 'ctrl+k') ? -1 : 1, ctx);
                return { consume: true };
            }
            if (!selected) return;
            if (matchesKey(data, 'escape')) { clear(); return { consume: true }; }
            if (matchesKey(data, 'enter')) {
                const block = host.currentLayout && collectBlocks(host.currentLayout.root).find(item => item.component === selected);
                if (block) ctx.ui.setEditorText(block.text());
                clear();
                return { consume: true };
            }
            // Any normal editing action leaves transcript-selection mode and
            // keeps Pi's original input behavior for that keystroke.
            clear();
        });
    });
    pi.on('session_tree', () => clear());
    pi.on('session_shutdown', () => {
        try { clear(); }
        finally {
            latestContext = undefined;
            removeInput?.(); removeInput = undefined;
            host = undefined; theme = undefined;
        }
    });
}
