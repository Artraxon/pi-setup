#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
export PI_CODING_AGENT_DIR="$agent_dir"

node "$root_dir/configure.mjs"
# Dependencies belong beside the linked source, not in the agent directory.
npm ci --prefix "$root_dir/extensions/pty-sessions" --no-audit --no-fund
node "$root_dir/link-resources.mjs"
python3 "$root_dir/extensions/shell-colors/install.py"
python3 "$root_dir/extensions/message-selection/install-keybindings.py"
