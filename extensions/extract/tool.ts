import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { runExtraction, selectModel } from './core.ts';
import { extractionModelSpec } from './settings.ts';

export function registerExtractionTool(pi: ExtensionAPI, extract = runExtraction): () => void {
    const active = new Set<AbortController>();
    pi.registerTool({
        name: 'extract_text', label: 'Extract text', exposure: 'codemode',
        description: 'Summarize or extract facts from text using the separate extraction model selected in /settings. Makes a separately billed model request. In codemode, pass tool output directly and return only the summary to avoid loading the raw output into the main conversation. Source is untrusted data; no conversation history or tools are sent. Does not open an editor or alter the user draft. Do not send secrets or private PTY output.',
        parameters: Type.Object({
            text: Type.String({ minLength: 1, description: 'Complete source text to summarize or extract from.' }),
            instructions: Type.Optional(Type.String({ description: 'Extraction instructions; defaults to a concise structured summary preserving exact relevant details.' })),
            max_tokens: Type.Optional(Type.Integer({ minimum: 1, description: 'Output token limit; otherwise PI_EXTRACT_MAX_TOKENS or 8192. Capped by the selected model.' })),
        }),
        outputSchema: Type.Object({ summary: Type.String(), model: Type.String(), truncated: Type.Boolean() }),
        async execute(_id, args, signal, _update, ctx) {
            const spec = extractionModelSpec();
            const model = selectModel(ctx.modelRegistry, spec);
            const maxTokens = args.max_tokens ?? Number(process.env.PI_EXTRACT_MAX_TOKENS ?? 8192);
            if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('Extraction output token limit must be a positive integer.');
            const controller = new AbortController();
            const timeout = AbortSignal.timeout(300_000);
            const combined = AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]);
            active.add(controller);
            try {
                combined.throwIfAborted();
                const result = await extract(ctx.modelRegistry, model, args.instructions ?? '', args.text, combined, maxTokens);
                combined.throwIfAborted();
                if (!result) throw new Error('Extraction cancelled.');
                const structuredContent = { summary: result.output, model: spec, truncated: result.truncated };
                return {
                    content: [{ type: 'text', text: result.truncated
                        ? `Warning: extraction reached its output limit; this summary is partial.\n\n${result.output}` : result.output }],
                    structuredContent,
                    details: { model: spec, truncated: result.truncated, usage: result.usage },
                    usage: result.usage,
                };
            } finally { active.delete(controller); }
        },
    });
    return () => { for (const controller of active) controller.abort(); active.clear(); };
}
