"""Start an isolated real Pi TUI with a local deterministic test provider."""
import json
import os
import sys
from pathlib import Path

root, node, cli, compact, managed, scenario, mode = sys.argv[1:]
root = Path(root)
agent = root / "agent"
agent.mkdir(exist_ok=True)
(agent / "settings.json").write_text(json.dumps({
    "quietStartup": True, "hideThinkingBlock": False, "defaultProjectTrust": "yes",
    "compaction": {"enabled": False}, "outputPad": int(os.environ.get("PI_COMPACT_TEST_OUTPUT_PAD", "1")),
}))
if os.environ.get("PI_COMPACT_TEST_ACTIVITY_DISABLED"):
    (agent / "compact-tools.json").write_text('{"activityEnabled":false}')
if key := os.environ.get("PI_COMPACT_TEST_EXPAND_KEY"):
    (agent / "keybindings.json").write_text(json.dumps({"app.tools.expand": key}))
os.environ["PI_CODING_AGENT_DIR"] = str(agent)
os.environ["PI_COMPACT_TEST_ROOT"] = str(root)
os.environ["PI_CLIPBOARD_TEST_STATE"] = str(root / "state.json")
for key in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DISPLAY", "WAYLAND_DISPLAY", "KITTY_LISTEN_ON"):
    os.environ.pop(key, None)
os.chdir(root)
(root / "client.pid").write_text(str(os.getpid()))
os.execv(node, [node, cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
               "--session", str(root / "session.jsonl"), "--tui-mode", mode,
               "--provider", "compact-e2e", "--model", "scenario",
               "-e", compact, "-e", managed, "-e", scenario])
