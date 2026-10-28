import { extractFileReferences } from './clion.ts';

export const CLION_REFERENCE_GUIDANCE = `Use CLion-compatible Markdown links for every existing project-file reference in explanatory prose: [src/Foo.cpp:42](src/Foo.cpp#L42), or [src/Foo.cpp:42:8](src/Foo.cpp#L42C8). Use project-relative targets, URL-encode spaces, and include useful line numbers when known. These links are handled by the CLion file-actions extension; do not use file://, vscode://, JetBrains project-launcher URLs, or bare/backticked paths as prose references. Do not automatically open files merely because you mention them. Do not invent existing files, line numbers, or successful IDE actions. Keep executable commands, source code, diffs, and literal logs unchanged; paths inside them are data, not prose navigation. Directories, nonexistent paths, and necessary paths outside the current project must not be presented as working CLion file links.`;

function linkedReference(value: string, projectPath: string): string | undefined {
    try {
        // Wrapping as a link also recognizes extensionless files. The extractor
        // validates real paths, regular files, coordinates and project bounds.
        const references = extractFileReferences(`[file](${value.replace(/ /g, '%20')})`, projectPath);
        if (references.length !== 1) return undefined;
        const reference = references[0];
        const target = reference.file.split('/').map(encodeURIComponent).join('/') +
            (reference.line === undefined ? '' : `#L${reference.line}${reference.column === undefined ? '' : `C${reference.column}`}`);
        const label = reference.label.replace(/[\\[\]]/g, '\\$&');
        return `[${label}](${target})`;
    } catch { return undefined; }
}

/** Display-only linkification. Never rewrite source code, commands or tool output.
 * Existing Markdown links/images and URLs remain untouched. Unclosed fences are
 * protected as well, since this transform also runs during streaming.
 */
export function linkProjectReferences(markdown: string, projectPath: string): string {
    let fence: { character: string; length: number } | undefined;
    return markdown.split('\n').map(line => {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (fence) {
            if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
            return line;
        }
        if (marker) { fence = { character: marker[1][0], length: marker[1].length }; return line; }
        if (/^(?: {4}|\t)/.test(line)) return line;
        // Alternate protected links, autolinks and inline code with prose.
        const tokens = /(!?\[[^\]\n]*\]\([^\n]*?\)|<[^>\n]+>|(`+)[^`\n]*?\2|`+[^`\n]*$)/g;
        let output = '', end = 0;
        const prose = (text: string) => text.replace(/[^\s`<>"()[\]{}]+/g, token => {
            const value = token.replace(/[.,;!?]+$/, '');
            if (!/[./]/.test(value) && !/^[A-Z][A-Z0-9_-]+$/.test(value)) return token;
            if (!value || /^[a-z][a-z\d+.-]*:/i.test(value) && !/:\d+(?::\d+)?$/.test(value)) return token;
            const linked = linkedReference(value, projectPath);
            return linked ? linked + token.slice(value.length) : token;
        });
        for (const match of line.matchAll(tokens)) {
            output += prose(line.slice(end, match.index));
            const token = match[0];
            if (token.startsWith('`') && match[2]) {
                const delimiter = match[2];
                const value = token.slice(delimiter.length, -delimiter.length);
                output += linkedReference(value, projectPath) ?? token;
            } else output += token;
            end = match.index! + token.length;
        }
        return output + prose(line.slice(end));
    }).join('\n');
}
