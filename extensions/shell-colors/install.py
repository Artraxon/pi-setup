#!/usr/bin/env python3
"""Narrow, idempotent Pi 1.3 runtime patch: colored display, plain model context."""
from pathlib import Path
import shutil
import sys

root = Path(shutil.which("pi")).resolve().parents[1]
helper = Path(__file__).with_name("sgr.js").read_text().replace("export function preserveShellColors", "function piPreserveShellColors")
marker = "// pi-shell-colors-v1\n"
patches = []

executor = root / "core/bash-executor.js"
if executor.exists():
    patches.append((executor, [
        ('const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\\r/g, "");',
         'options?.onChunk?.(piPreserveShellColors(rawText).replace(/\\r/g, ""));\n        const text = sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\\r/g, "");'),
        ('options.onChunk(text);', '/* Display was streamed separately, with SGR retained. */'),
    ]))
component = root / "modes/interactive/components/bash-execution.js"
if component.exists():
    patches.append((component, [('stripAnsi(chunk)', 'piPreserveShellColors(chunk)')]))

for path in (root / "bundle/chunks").glob("*.js"):
    text = path.read_text()
    if "executeBashWithOperations(command,cwd,operations,options)" in text:
        patches.append((path, [
            ('let text=sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\\r/g,"");if(text){',
             'let text=sanitizeBinaryOutput(stripAnsi(rawText)).replace(/\\r/g,"");options?.onChunk?.(piPreserveShellColors(rawText).replace(/\\r/g,""));if(text){'),
            ('options?.onChunk&&options.onChunk(text)', 'void 0'),
            ('stripAnsi(chunk).replace(/\\r\\n/g,', 'piPreserveShellColors(chunk).replace(/\\r\\n/g,'),
        ]))

# Validate everything before touching any runtime file. Fail visibly on upgrades.
changes = []
for path, replacements in patches:
    text = path.read_text()
    if text.startswith(marker):
        continue
    for old, new in replacements:
        if text.count(old) != 1:
            sys.exit(f"Unsupported Pi layout in {path}: expected one occurrence of {old!r}; no changes applied")
        text = text.replace(old, new)
    changes.append((path, marker + helper + "\n" + text))
if not patches:
    sys.exit("Could not locate Pi runtime")
for path, text in changes:
    backup = path.with_suffix(path.suffix + ".pre-shell-colors")
    if not backup.exists():
        shutil.copy2(path, backup)
    path.write_text(text)
print(f"Pi shell colors: patched {len(changes)} runtime files (restart Pi to activate)")
