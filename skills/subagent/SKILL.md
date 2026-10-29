---
name: subagent
description: Delegate to a lightweight, steerable Pi TUI with compact final-result retrieval.
---

# Interactive subagent

1. Require `pty_write` and `subagent_result`; otherwise ask for `/reload`. Always launch with managed `bash` **`tty: true, yield_after: 0`**. Never print/JSON/RPC mode, redirection, `&` or `nohup`.
2. Resolve `launch.mjs` relative to this skill directory. Shell-quote a scoped task with permissions and completion criteria. Read-only default:
   ```sh
   node /ABSOLUTE/SKILL/DIRECTORY/launch.mjs 'TASK. Do not modify project files or launch agents. Finish with a concise handoff (at most 200 words): findings/changes, validation, remaining issues, and artifact paths if needed. Stay open for follow-ups.'
   ```
   Optional `--model`, `--thinking`, `--tools` precede the task. Defaults: `openai/gpt-6-luna`, `low`, `read,bash`; enable edit/write only when authorized. This is not a security sandbox.
3. The launcher starts a fresh normal Pi TUI with isolated persisted sessions and only an explicit result-reporting extension. Its dedicated socket supplies the label automatically; do not add identity/source instructions to the child's task. Progress status and completion notifications are automatic; do not ask the child to notify before its final response.
4. Retain the process ID. On completion, call **`subagent_result({id})`**, not `pty_snapshot` or log reads. It returns only the saved final text, bounded by `max_chars`; optional `turn` and `offset` retrieve earlier turns/pages. Keep detailed work in artifacts; read selectively.
5. `/fg ID` enters the child; Ctrl+Z returns. For steering only, inspect `pty_snapshot`, then use `pty_write` with an empty editor/no user attached. Never overwrite drafts or blindly retry. Leave useful agents open; stop only when requested/done. Private jobs remain inaccessible.
