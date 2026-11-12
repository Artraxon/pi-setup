"""Launch installed Pi as a display-less client with no clipboard helper on PATH."""
import os
import sys
from pathlib import Path

root, node, cli, extension, observer = sys.argv[1:]
root = Path(root)
agent = root / "agent"
agent.mkdir(exist_ok=True)
(agent / "settings.json").write_text('{"hideThinkingBlock":true,"quietStartup":true}')
bin_dir = root / "client-bin"
bin_dir.mkdir(exist_ok=True)
(bin_dir / "node").symlink_to(node)
for name in ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_SESSION_TYPE", "KITTY_LISTEN_ON"):
    os.environ.pop(name, None)
os.environ["PATH"] = str(bin_dir)
os.environ["PI_CODING_AGENT_DIR"] = str(agent)
os.environ["PI_CLIPBOARD_TEST_STATE"] = str(root / "state.json")
os.chdir(root)
(root / "client.pid").write_text(str(os.getpid()))
os.execv(node, [node, cli, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
               "--no-session", "--tui-mode", "fullscreen", "-e", extension, "-e", observer])
