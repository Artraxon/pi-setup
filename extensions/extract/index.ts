import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BorderedLoader } from '@earendil-works/pi-coding-agent';
import { captureBlob, editorCommand } from './editor.ts';
import { runExtraction, selectModel } from './core.ts';
import { extractionModelSpec, installSettingsRow } from './settings.ts';
import { capturePaste } from './paste.ts';
import { registerExtractionTool } from './tool.ts';

// Injectable operations keep tests offline: no model request or editor process
// is launched by the command integration tests.
export function createExtractExtension(overrides: Partial<{ captureBlob: typeof captureBlob; editorCommand: typeof editorCommand; runExtraction: typeof runExtraction; BorderedLoader: typeof BorderedLoader; capturePaste: typeof capturePaste }> = {}) {
    const dependencies = { captureBlob, editorCommand, runExtraction, BorderedLoader, capturePaste, ...overrides };
    return function extract(pi: ExtensionAPI) {
        const stopToolRequests = registerExtractionTool(pi, dependencies.runExtraction);
        let host: any;
        let removeSettingsRow: (() => void) | undefined;
        let busy = false;
        let generation = 0;
        let active: AbortController | undefined;
        let cancelDialog: (() => void) | undefined;
        pi.on('session_start', (_event, ctx) => {
            if (ctx.mode !== 'tui') return;
            ctx.ui.setWidget('extract-host', (tui, theme) => {
                removeSettingsRow?.();
                host = tui;
                removeSettingsRow = installSettingsRow(tui, theme, ctx);
                return { render: () => [], invalidate() {} };
            });
        });
        pi.on('session_shutdown', () => {
            generation++;
            stopToolRequests();
            removeSettingsRow?.();
            removeSettingsRow = undefined;
            active?.abort();
            cancelDialog?.();
        });
        for (const name of ['extract', 'epaste']) pi.registerCommand(name, {
            description: name === 'epaste'
                ? 'Capture a large paste in Pi; Enter extracts, Ctrl+G edits first: /epaste [instructions]'
                : 'Paste a blob in the external editor and extract it with a separate model: /extract [instructions]',
            handler: async (instructions, ctx) => {
                if (ctx.mode !== 'tui' || !host) {
                    ctx.ui.notify(`/${name} requires interactive Pi.`, 'warning');
                    return;
                }
                if (busy || !ctx.isIdle()) {
                    ctx.ui.notify(`Wait for the current operation to finish before /${name}.`, 'warning');
                    return;
                }
                busy = true;
                const started = generation;
                try {
                    const spec = extractionModelSpec();
                    const model = selectModel(ctx.modelRegistry, spec);
                    const configuredMax = process.env.PI_EXTRACT_MAX_TOKENS;
                    const maxTokens = configuredMax === undefined ? 8192 : Number(configuredMax);
                    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('PI_EXTRACT_MAX_TOKENS must be a positive integer.');
                    let blob: string | undefined;
                    if (name === 'epaste') {
                        const captured = await dependencies.capturePaste(ctx);
                        if (generation !== started) return;
                        blob = captured?.blob;
                        if (captured?.edit && blob?.trim()) {
                            blob = await dependencies.captureBlob(host, dependencies.editorCommand(ctx.cwd), blob);
                        }
                    } else {
                        blob = await dependencies.captureBlob(host, dependencies.editorCommand(ctx.cwd));
                    }
                    if (generation !== started) return;
                    if (blob === undefined || !blob.trim()) {
                        ctx.ui.notify(blob === undefined ? 'Extraction cancelled.' : 'No text entered; nothing sent.', 'info');
                        return;
                    }
                    const controller = new AbortController();
                    active = controller;
                    const timeout = AbortSignal.timeout(300_000);
                    const outcome = await ctx.ui.custom<any>((tui, theme, _keys, done) => {
                        const loader = new dependencies.BorderedLoader(tui, theme,
                            `Extracting ${blob.length.toLocaleString()} characters with ${spec}…`);
                        const signal = AbortSignal.any([controller.signal, loader.signal, timeout]);
                        let finished = false;
                        const finish = (value: any) => {
                            if (finished) return;
                            finished = true;
                            signal.removeEventListener('abort', onAbort);
                            done(value);
                        };
                        function onAbort() { finish(undefined); }
                        signal.addEventListener('abort', onAbort, { once: true });
                        cancelDialog = () => { controller.abort(); finish(undefined); };
                        loader.onAbort = cancelDialog;
                        void dependencies.runExtraction(ctx.modelRegistry, model, instructions, blob, signal, maxTokens)
                            .then(result => finish(result ? { result } : undefined))
                            .catch(error => finish(signal.aborted ? undefined : { error }));
                        return loader;
                    });
                    cancelDialog = undefined;
                    if (generation !== started) return;
                    if (!outcome) {
                        ctx.ui.notify(timeout.aborted ? 'Extraction timed out after five minutes.' : 'Extraction cancelled.', 'info');
                        return;
                    }
                    if (outcome.error) throw outcome.error;
                    const result = outcome.result;
                    ctx.ui.setEditorText(result.output);
                    // Usage metadata only: no blob, instructions or result is
                    // persisted in this excluded-from-context custom entry.
                    pi.appendEntry('extract-usage', { provider: model.provider, model: model.id, usage: result.usage });
                    const usage = result.usage;
                    const count = usage ? ` · ${usage.input ?? 0} input / ${usage.output ?? 0} output tokens` : '';
                    ctx.ui.notify(result.truncated
                        ? `Extraction reached its output limit; partial result loaded into prompt (${spec}${count}).`
                        : `Extraction loaded into prompt (${spec}${count}). Review and submit when ready.`,
                        result.truncated ? 'warning' : 'info');
                } catch (error) {
                    if (generation !== started) return;
                    ctx.ui.notify(`Extraction: ${error instanceof Error ? error.message : String(error)}`, 'error');
                } finally {
                    active = undefined;
                    cancelDialog = undefined;
                    busy = false;
                }
            },
        });
    };
}

export default createExtractExtension();
