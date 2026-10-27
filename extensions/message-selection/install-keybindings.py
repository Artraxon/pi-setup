#!/usr/bin/env python3
"""Free Ctrl+J/K for transcript selection, keeping other custom bindings intact."""
import json
import os
from pathlib import Path

path = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent"))) / "keybindings.json"
settings = json.loads(path.read_text()) if path.exists() else {}
for action, removed, default in [
    ("tui.input.newLine", "ctrl+j", ["shift+enter", "ctrl+j"]),
    ("tui.editor.deleteToLineEnd", "ctrl+k", ["ctrl+k"]),
]:
    bindings = settings.get(action, default)
    if isinstance(bindings, str):
        bindings = [bindings]
    settings[action] = [binding for binding in bindings if binding.lower() != removed]
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(settings, indent=2) + "\n")
