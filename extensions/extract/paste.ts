import { Container, Editor, matchesKey, truncateToWidth } from '@earendil-works/pi-tui';

export type PasteCapture = { blob: string; edit: boolean };

export function createPasteDialog(tui: any, theme: any, done: (value?: PasteCapture) => void) {
    const editor = new Editor(tui, {
        borderColor: value => theme.fg('border', value),
        selectList: {
            selectedPrefix: value => theme.fg('accent', value), selectedText: value => theme.fg('accent', value),
            description: value => theme.fg('muted', value), scrollInfo: value => theme.fg('muted', value),
            noMatch: value => theme.fg('muted', value),
        },
    });
    editor.onSubmit = blob => done({ blob, edit: false });
    const component = new Container() as Container & { focused: boolean; handleInput(data: string): void };
    component.addChild({
        render: width => [truncateToWidth(theme.fg('accent', 'Paste source for extraction'), width),
            truncateToWidth(theme.fg('muted', 'Enter extracts · Ctrl+G edits in external editor · Shift+Enter newline · Esc cancels'), width)],
        invalidate() {},
    });
    component.addChild(editor);
    // Forward focus so Pi's Editor can draw/place the cursor correctly.
    Object.defineProperty(component, 'focused', {
        get: () => editor.focused, set: value => { editor.focused = value; },
    });
    component.handleInput = data => {
        if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { done(); return; }
        if (matchesKey(data, 'ctrl+g')) {
            // getText() would return [paste #N ...] placeholders. Always expand
            // paste markers before opening Vim or making a model request.
            done({ blob: editor.getExpandedText(), edit: true });
            return;
        }
        editor.handleInput(data);
    };
    return component;
}

export async function capturePaste(ctx: any): Promise<PasteCapture | undefined> {
    return ctx.ui.custom((tui: any, theme: any, _keys: any, done: (value?: PasteCapture) => void) => createPasteDialog(tui, theme, done));
}
