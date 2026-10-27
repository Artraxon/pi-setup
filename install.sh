#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

install_extension() {
    local name="$1"
    shift
    local destination="$agent_dir/extensions/$name"
    mkdir -p "$destination"
    for file in "$@"; do
        install -m 644 "$root_dir/extensions/$name/$file" "$destination/$file"
    done
    echo "Installed $name for Pi in $destination"
}

install_extension clion-file-actions index.ts clion.ts inline.ts link-navigation.ts
# Remove the helper left behind by the former multi-runtime installer.
rm -f "$agent_dir/extensions/clion-file-actions/shared.ts"
install_extension compact-tools index.ts
install_extension output-editor index.ts
install_extension zsh-completion index.ts bridge.py complete.zsh
install_extension shell-colors index.ts
python3 "$root_dir/extensions/shell-colors/install.py"
install_extension pty-sessions index.ts sessions.mjs input.mjs package.json package-lock.json
npm ci --prefix "$agent_dir/extensions/pty-sessions" --no-audit --no-fund
install_extension message-selection index.ts
python3 "$root_dir/extensions/message-selection/install-keybindings.py"
