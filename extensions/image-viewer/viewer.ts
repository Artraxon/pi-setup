import {
    allocateImageId, getCellDimensions, isKeyRelease, matchesKey, renderImage, truncateToWidth,
    type Component, type ImageDimensions, type TUI, type TuiMouseEvent,
} from '@earendil-works/pi-tui';

export type Picture = { data: string; dimensions: ImageDimensions };

/** Crop in source pixels, not terminal cells. Zoom never grows the overlay. */
export function geometry(dim: ImageDimensions, columns: number, rows: number,
    cell: ImageDimensions, scale: number, panX = 0, panY = 0) {
    const w = Math.max(1, Math.min(dim.widthPx, Math.floor(columns * cell.widthPx / scale)));
    const h = Math.max(1, Math.min(dim.heightPx, Math.floor(rows * cell.heightPx / scale)));
    return {
        x: Math.round(Math.max(0, Math.min(dim.widthPx - w, (dim.widthPx - w) / 2 + panX))),
        y: Math.round(Math.max(0, Math.min(dim.heightPx - h, (dim.heightPx - h) / 2 + panY))),
        w, h,
        columns: Math.max(1, Math.min(columns, Math.ceil(w * scale / cell.widthPx))),
        rows: Math.max(1, Math.min(rows, Math.ceil(h * scale / cell.heightPx))),
    };
}

export class ImageViewer implements Component {
    capturesViewportInput = true;
    private scale: number | undefined;
    private panX = 0;
    private panY = 0;
    private sequence: string | undefined;
    private uploadGeometry = '';
    private cachedKey = '';
    private cachedLines: string[] = [];
    private closed = false;
    private readonly id = allocateImageId();

    constructor(private picture: Picture, private tui: TUI,
        private color: (text: string) => string, private done: () => void) {}

    close() {
        if (this.closed) return;
        this.closed = true;
        this.done();
    }

    private zoom(direction: number) {
        if (this.scale === undefined) return;
        this.scale = Math.max(1 / 4096, Math.min(64, this.scale * 1.25 ** direction));
        this.invalidate();
        this.tui.requestRender();
    }

    handleInput(data: string) {
        if (this.closed || isKeyRelease(data)) return;
        if (matchesKey(data, 'q') || matchesKey(data, 'escape')) { this.close(); return; }
        if (matchesKey(data, '+') || matchesKey(data, '=') || matchesKey(data, 'shift+=')) this.zoom(1);
        else if (matchesKey(data, '-')) this.zoom(-1);
        else if (matchesKey(data, '0')) {
            this.scale = undefined; this.panX = this.panY = 0;
            this.invalidate(); this.tui.requestRender();
        } else {
            const step = 40 / (this.scale ?? 1);
            if (matchesKey(data, 'left')) this.panX -= step;
            else if (matchesKey(data, 'right')) this.panX += step;
            else if (matchesKey(data, 'up')) this.panY -= step;
            else if (matchesKey(data, 'down')) this.panY += step;
            else return;
            this.invalidate(); this.tui.requestRender();
        }
    }

    handleMouse(event: TuiMouseEvent) {
        if (this.closed) return;
        if (event.type === 'wheel' && event.ctrl && event.wheelDelta) this.zoom(event.wheelDelta < 0 ? 1 : -1);
        // Keep all pointer events in the modal, including unmodified wheel events.
        return { handled: true, render: false };
    }

    render(width: number): string[] {
        const height = Math.max(1, this.tui.terminal.rows);
        const cell = getCellDimensions();
        const dim = this.picture.dimensions;
        const uploadGeometry = [this.tui.terminal.columns, width, height, cell.widthPx, cell.heightPx].join(':');
        if (uploadGeometry !== this.uploadGeometry) {
            // A terminal resize can discard graphics independently of Pi's
            // upload cache. Register a fresh transmission generation so the
            // renderer sends PNG bytes again, not just a stale image-ID placement.
            this.uploadGeometry = uploadGeometry;
            this.sequence = undefined;
            this.cachedKey = '';
        }
        const imageRows = Math.max(1, height - 1);
        this.scale ??= Math.min(1, width * cell.widthPx / dim.widthPx, imageRows * cell.heightPx / dim.heightPx);
        const key = [width, height, cell.widthPx, cell.heightPx, this.scale, this.panX, this.panY].join(':');
        if (key === this.cachedKey) return this.cachedLines;
        const g = geometry(dim, width, imageRows, cell, this.scale, this.panX, this.panY);
        // Clamp the pan state too, so returning from an edge never needs many keys.
        this.panX = g.x - (dim.widthPx - g.w) / 2;
        this.panY = g.y - (dim.heightPx - g.h) / 2;
        // Register once per terminal geometry. Zoom/pan only change placement
        // controls; resizing deliberately renews the upload for recovery.
        this.sequence ??= renderImage(this.picture.data, dim, {
            imageId: this.id, maxWidthCells: width, maxHeightCells: imageRows, moveCursor: false,
        })?.sequence;
        const lines = Array.from({ length: height }, () => ' '.repeat(width));
        if (this.sequence && height > 1) {
            const sequence = this.sequence.replace(/\x1b_G([^;]*);/, (_all, controls: string) => {
                const keep = controls.split(',').filter(control => !/^[crxywhz]=/.test(control));
                // Direct, chunked PNG transfer (t=d default), never a remote file
                // name or shared-memory handle. Positive z puts it above text.
                return `\x1b_G${keep.join(',')},x=${g.x},y=${g.y},w=${g.w},h=${g.h},c=${g.columns},r=${g.rows},z=1;`;
            });
            const top = Math.floor((imageRows - g.rows) / 2);
            const left = Math.floor((width - g.columns) / 2);
            lines[top] = ' '.repeat(left) + sequence;
        }
        lines[height - 1] = this.color(truncateToWidth(
            `${dim.widthPx}×${dim.heightPx} · ${Math.round(this.scale * 100)}% · +/- or Ctrl+wheel zoom · arrows pan · 0 reset · q/Esc close`, width));
        this.cachedKey = [width, height, cell.widthPx, cell.heightPx, this.scale, this.panX, this.panY].join(':');
        return this.cachedLines = lines;
    }

    invalidate() { this.cachedKey = ''; }
}
