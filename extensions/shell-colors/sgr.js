// Preserve SGR styling only. Never forward cursor motion, OSC (including
// clipboard/title changes), DCS, or other terminal control sequences.
export function preserveShellColors(text) {
    let result = "";
    for (let i = 0; i < text.length;) {
        const code = text.charCodeAt(i);
        if (code === 27 || code === 0x9b) {
            const start = i++;
            const kind = code === 0x9b ? "[" : text[i++];
            if (kind === "[") {
                const parameters = i;
                while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i++;
                if (text[i] === "m" && /^[0-9;:]*$/.test(text.slice(parameters, i))) {
                    result += "\x1b[" + text.slice(parameters, i) + "m";
                }
                if (i < text.length) i++;
            } else if (["]", "P", "_", "^", "X"].includes(kind)) {
                while (i < text.length) {
                    if (text[i] === "\x07" || text[i] === "\x9c") { i++; break; }
                    if (text[i] === "\x1b" && text[i + 1] === "\\") { i += 2; break; }
                    i++;
                }
            } else {
                // ESC intermediates, e.g. charset selection ESC ( B.
                while (i < text.length && text.charCodeAt(i - 1) >= 0x20 && text.charCodeAt(i - 1) <= 0x2f) i++;
            }
            if (i <= start) i = start + 1;
        } else {
            if ((code >= 32 && !(code >= 0x7f && code <= 0x9f) && !(code >= 0xfff9 && code <= 0xfffb)) || code === 9 || code === 10 || code === 13) result += text[i];
            i++;
        }
    }
    return result;
}
