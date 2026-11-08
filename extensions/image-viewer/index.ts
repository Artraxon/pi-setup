import { convertToPng, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Container, getCapabilities, getCellDimensions, getImageDimensions, Image, Spacer, type TuiMouseEvent } from '@earendil-works/pi-tui';
import { ImageViewer } from './viewer.ts';
import { installKittyCacheGuard } from './kitty-cache.ts';

// Pi's Image has no public content accessor or activation hook yet. Keep this
// compatibility bridge isolated here; never change installed package files.
type InlineImage = { base64Data?: string; mimeType?: string; pngData?: string };

export function collectImages(root: any): Image[] {
    const result: Image[] = [], seen = new Set<any>();
    function visit(component: any) {
        if (!component || seen.has(component)) return;
        seen.add(component);
        if (component instanceof Image) { result.push(component); return; }
        for (const child of component.children ?? []) visit(child);
        // Some layout wrappers store their content outside children.
        if (component.content) visit(component.content);
    }
    visit(root);
    return result;
}

export default function imageViewer(pi: ExtensionAPI) {
    let host: any;
    let context: ExtensionContext | undefined;
    let restore: (() => void) | undefined;
    let restoreKittyCache: (() => void) | undefined;
    let viewer: ImageViewer | undefined;
    let busy = false;
    let generation = 0;

    async function open(image: Image, ctx: ExtensionContext) {
        if (busy || !host || ctx.mode !== 'tui') return;
        if (getCapabilities().images !== 'kitty') {
            ctx.ui.notify('Image enlargement currently requires Kitty graphics support.', 'warning');
            return;
        }
        const source = image as unknown as InlineImage;
        if (typeof source.base64Data !== 'string' || typeof source.mimeType !== 'string') {
            ctx.ui.notify('This Pi version does not expose inline image content.', 'warning');
            return;
        }
        busy = true;
        const started = generation;
        try {
            const png = source.pngData ? { data: source.pngData } : await convertToPng(source.base64Data, source.mimeType);
            if (generation !== started) return;
            const dimensions = png && getImageDimensions(png.data, 'image/png');
            if (!png || !dimensions) throw new Error('Could not decode this image.');
            await ctx.ui.custom<void>((tui, theme, _keys, done) => {
                viewer = new ImageViewer({ data: png.data, dimensions }, tui,
                    text => theme.fg('dim', text), () => done(undefined));
                return viewer;
            }, { overlay: true, overlayOptions: { width: '100%', maxHeight: '100%', margin: 0 } });
        } catch (error) {
            if (generation === started) ctx.ui.notify(`Image viewer: ${error instanceof Error ? error.message : String(error)}`, 'warning');
        } finally {
            if (generation === started) { viewer = undefined; busy = false; host.requestRender(true); }
        }
    }

    function cleanup() {
        generation++;
        viewer?.close(); viewer = undefined;
        restore?.(); restore = undefined;
        restoreKittyCache?.(); restoreKittyCache = undefined;
        busy = false; context = undefined; host = undefined;
    }

    pi.on('session_start', (_event, ctx) => {
        cleanup();
        if (ctx.mode !== 'tui') return;
        context = ctx;
        ctx.ui.setWidget('image-viewer-host', tui => {
            host = tui;
            restoreKittyCache?.();
            restoreKittyCache = installKittyCacheGuard(tui);
            return { render: () => [], invalidate() {} };
        });
        const prototype = Image.prototype as Image & { handleMouse?: (event: TuiMouseEvent) => any };
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'handleMouse');
        const previous = prototype.handleMouse;
        const originalRender = prototype.render;
        const inlineGeometry = new WeakMap<Image, string>();
        const modalRender = function(this: Image, width: number) {
            const cell = getCellDimensions();
            const geometry = [host?.terminal?.columns ?? width, host?.terminal?.rows ?? 0, cell.widthPx, cell.heightPx].join(':');
            const previousGeometry = inlineGeometry.get(this);
            if (previousGeometry !== undefined && previousGeometry !== geometry) {
                // Image's own cache only keys on content width. Height-only
                // resizes must also renew the Kitty transmission, including
                // inline images underneath (or after closing) the viewer.
                this.invalidate();
            }
            inlineGeometry.set(this, geometry);
            const lines = originalRender.call(this, width);
            // Pi currently preserves a base image line instead of compositing an
            // overlay over it. Keep layout heights but suppress inline graphics
            // while our full-screen modal owns the foreground.
            return viewer ? lines.map(() => '') : lines;
        };
        prototype.render = modalRender;
        const handler = function(this: Image, event: TuiMouseEvent) {
            if (context && !busy && !host?.hasOverlay?.() && event.button === 'left') {
                const line = this.render(event.width)[0] ?? '';
                const controls = /\x1b_G([^;]*);/.exec(line)?.[1];
                const columns = controls && /(?:^|,)c=(\d+)/.exec(controls)?.[1];
                const rows = controls && /(?:^|,)r=(\d+)/.exec(controls)?.[1];
                if (columns && rows && event.x >= 0 && event.y >= 0 && event.x < Number(columns) && event.y < Number(rows)) {
                    // Claim press so the transcript does not start text selection;
                    // open only on click, not on drag or the release event.
                    if (event.type === 'press') return { handled: true, render: false };
                    if (event.type === 'click') { void open(this, context); return { handled: true, render: false }; }
                }
            }
            return previous?.call(this, event);
        };
        prototype.handleMouse = handler;
        const toolPrototype = ToolExecutionComponent.prototype;
        const originalToolMouse = toolPrototype.handleMouse;
        const toolMouse = function(this: any, event: TuiMouseEvent) {
            // Pi's self-shell render path lays images out AFTER its text, but
            // its mouse handler delegates only into selfRenderContainer. Mirror
            // the image portion of that layout so normal Container dispatch
            // preserves the concrete image target and screen-relative origin
            // for the press/release/click sequence, even below the first row.
            if (this.toolDefinition?.renderShell === 'self' && this.imageComponents?.length && event.y > this.selfRenderHeight) {
                const images = new Container();
                if (this.selfRenderHeight > 0) images.addChild(new Spacer(this.selfRenderHeight + 1));
                for (let i = 0; i < this.imageComponents.length; i++) {
                    if (this.imageSpacers[i]) images.addChild(this.imageSpacers[i]);
                    images.addChild(this.imageComponents[i]);
                }
                const result = images.handleMouse(event);
                if (result) return result;
            }
            return originalToolMouse.call(this, event);
        };
        toolPrototype.handleMouse = toolMouse;
        restore = () => {
            if (toolPrototype.handleMouse === toolMouse) toolPrototype.handleMouse = originalToolMouse;
            if (prototype.render === modalRender) prototype.render = originalRender;
            if (prototype.handleMouse === handler) {
                if (descriptor) Object.defineProperty(prototype, 'handleMouse', descriptor);
                else delete prototype.handleMouse;
            }
        };
    });

    pi.registerCommand('image', {
        description: 'Enlarge the latest rendered image, or /image N (oldest is 1)',
        handler: async (args, ctx) => {
            if (ctx.mode !== 'tui' || !host) return;
            const images = collectImages(host);
            const value = args.trim();
            const index = value ? (/^[1-9]\d*$/.test(value) ? Number(value) - 1 : -1) : images.length - 1;
            if (!images.length) { ctx.ui.notify('No rendered images. Enable image display first.', 'info'); return; }
            if (index < 0 || index >= images.length) { ctx.ui.notify(`Use /image or /image N (1–${images.length}).`, 'warning'); return; }
            await open(images[index], ctx);
        },
    });
    pi.on('session_shutdown', cleanup);
}
