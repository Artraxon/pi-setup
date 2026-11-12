// Compact activity component installed into upstream Pi by pi-setup.
import { Container, Markdown, sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

/** Snapshot only the compact activity area; never throttle the editor or transcript. */
export class ActivityContainer extends Container {
    static UPDATE_MS = 500;
    snapshot;
    timer;

    constructor(isCompact = () => true, requestRender = () => {}, clock = {
        now: () => performance.now(),
        set: (callback, delay) => setTimeout(callback, delay),
        clear: timer => clearTimeout(timer),
    }) {
        super();
        this.isCompact = isCompact;
        this.requestRender = requestRender;
        this.clock = clock;
    }

    render(width) {
        if (!this.isCompact()) {
            this.resetSnapshot();
            return super.render(width);
        }
        // Explicit interactions opt in to an immediate refresh. Automatic status,
        // output and reasoning changes all share the same half-second snapshot.
        const revisions = this.children.map(child => child.getActivityRevision?.() ?? 0);
        const now = this.clock.now();
        const previous = this.snapshot;
        const interacted = previous && revisions.some((value, index) => value !== previous.revisions[index]);
        if (previous && previous.width === width && !interacted && now - previous.at < ActivityContainer.UPDATE_MS) {
            this.schedule(ActivityContainer.UPDATE_MS - (now - previous.at));
            return previous.rows;
        }
        this.cancelTimer();
        const rows = super.render(width);
        const visible = rows.some(row => stripTerminalSequences(row).trim());
        if (visible) rows.push("");
        this.snapshot = { rows, width, at: now, revisions };
        // Keep elapsed timers advancing even when a process is completely quiet.
        // Once the area empties, there is no polling timer left running.
        if (visible) this.schedule(ActivityContainer.UPDATE_MS);
        return rows;
    }

    schedule(delay) {
        if (this.timer !== undefined) return;
        this.timer = this.clock.set(() => {
            this.timer = undefined;
            this.requestRender();
        }, Math.max(0, Math.ceil(delay)));
        this.timer?.unref?.();
    }

    cancelTimer() {
        if (this.timer !== undefined) this.clock.clear(this.timer);
        this.timer = undefined;
    }

    resetSnapshot() {
        this.cancelTimer();
        this.snapshot = undefined;
    }

    clear() {
        this.resetSnapshot();
        super.clear();
    }

    invalidate() {
        super.invalidate();
        this.resetSnapshot();
    }

    dispose() {
        this.resetSnapshot();
    }
}

/** Renders current activity; the native editor retains ownership of Working. */
export class ActivityDisplay extends Container {
    reasoning = "";
    active = true;
    tools = new Map();
    markdown;

    constructor(getPadding = () => 1, getTheme = getMarkdownTheme) {
        super();
        this.getPadding = getPadding;
        this.getTheme = getTheme;
    }

    setActive(active) {
        this.active = active;
        this.invalidate();
    }

    render(width) {
        if (!this.active) return [];
        const prefix = " ".repeat(this.getPadding());
        const rows = [];
        if (this.reasoning) {
            this.markdown ??= new Markdown(this.reasoning, 0, 0, this.getTheme(), {
                color: text => theme.fg("thinkingText", text), italic: true,
            });
            // Parse inline formatting at the source's full width, then truncate
            // styled cells. Wrapping first would turn one activity into many rows.
            const rendered = this.markdown.render(Math.max(width, visibleWidth(this.reasoning) + 1));
            const line = rendered.join(" ");
            const contentWidth = visibleWidth(stripTerminalSequences(line).trimEnd());
            rows.push(prefix + sliceByColumn(line, 0, contentWidth));
        }
        for (const label of this.tools.values()) rows.push(prefix + theme.fg("muted", label));
        return rows.map(row => truncateToWidth(row, width, "…"));
    }

    setReasoning(text) {
        const paragraphs = text.trim().split(/\n\s*\n/).map(paragraph => paragraph.trim()).filter(Boolean);
        const next = this.tools.size > 0 ? "" : this.singleLine(paragraphs.at(-1) ?? "");
        if (next === this.reasoning) return;
        this.reasoning = next;
        this.invalidate();
    }

    setTool(id, label) {
        this.tools.set(id, this.singleLine(label));
        this.reasoning = "";
        this.invalidate();
    }

    removeTool(id) {
        this.tools.delete(id);
        this.invalidate();
    }

    clear() {
        this.reasoning = "";
        this.tools.clear();
        this.invalidate();
    }

    singleLine(value) {
        return stripTerminalSequences(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
    }

    invalidate() {
        super.invalidate();
        this.markdown = undefined;
    }
}
