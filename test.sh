#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
npm ci --prefix extensions/pty-sessions --no-audit --no-fund
node --test \
    extensions/pty-sessions/*.test.mjs \
    extensions/notifications/*.test.mjs \
    extensions/shared/*.test.mjs \
    skills/subagent/*.test.mjs \
    extensions/shell-colors/sgr.test.mjs \
    extensions/message-selection/index.test.mjs \
    extensions/clion-file-actions/link-navigation.test.mjs \
    extensions/clion-file-actions/index.test.mjs \
    extensions/extract/index.test.mjs \
    extensions/extract/settings.test.mjs \
    extensions/extract/paste.test.mjs \
    extensions/extract/tool.test.mjs
node --experimental-strip-types --test \
    extensions/clion-file-actions/clion.test.ts \
    extensions/clion-file-actions/references.test.ts \
    extensions/output-editor/index.test.ts \
    extensions/compact-tools/index.test.ts \
    extensions/extract/core.test.ts \
    extensions/extract/editor.test.ts
python3 -m unittest discover -s extensions/zsh-completion -p 'test_*.py' -v
bash -n install.sh
zsh -n extensions/zsh-completion/complete.zsh
