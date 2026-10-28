# Pi development extensions

A self-contained collection of Pi extensions, with an installer and tests. This
folder can be copied/extracted into its own repository without changing its
internal paths. It currently lives inside the parent project's devcontainer;
it does not contain a nested Git repository.

## Requirements and installation

- Pi **1.3.0** on Linux, running in fullscreen mode for mouse/navigation features.
- Node.js **22.23+**, npm, Python 3, and Zsh. Native `node-pty` installation may
  require a C/C++ compiler and Python if a suitable prebuilt binary is unavailable.
- An external editor (`VISUAL`, then `EDITOR`, then `vim` for output editing).
- CLion's Index MCP Server with a project open and `ide_open_file` enabled for
  editor navigation. Other extensions do not require CLion.

From this folder (or its future standalone repository root):

```sh
bash install.sh
```

The installer works from any current directory. It installs into
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extensions`, installs pinned PTY runtime
dependencies, and updates keybindings to free Ctrl+J/K for transcript selection.
Other custom keybindings are preserved.

Run `/reload` after updating extensions. **Save active PTY work first:** reload
terminates all managed processes and clears their retained output/logs. The native shell
color patch changes Pi runtime files and requires a **Pi restart**, not just
`/reload`. Rerun the installer after updating Pi.

The changing managed-process backend helpers deliberately use TypeScript: Pi's
loader refreshes those on reload, whereas native ESM helpers can remain cached
inside Node and mix old backend code with a new extension entry point.

## Layout

```text
install.sh
README.md
test.sh
extensions/
  clion-file-actions/   Inline CLion navigation and /clion
  compact-tools/       One-line collapsed tool summaries
  extract/             Editor capture and extraction with a separate model
  message-selection/   Ctrl+K/J transcript selection into the prompt
  output-editor/       Edit response/block text into the prompt
  pty-sessions/        Managed bash processes, background PTYs and attachment
  shared/              Shared settings and reload-safe selection ownership
  shell-colors/        Native shell-output SGR preservation
  zsh-completion/      Zsh completion bridge for ! and !! input
```

Tests live beside their extension. Dependencies and generated caches are ignored.
The installer copies runtime files only, not test entry points, into Pi's
extension directories.

## Managed processes and interactive PTY sessions

The extension **replaces the model's `bash` tool**. Commands normally run without
a TTY, with closed stdin and piped stdout/stderr. Short commands return their
output and exit status normally. After **15 seconds** (default), a still-running
command returns a background ID without being killed.

### Foreground interval and hard timeouts

Choose **`/settings` → Bash foreground wait** and enter any number of seconds from
0 to 86400. The value is saved in
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/processes.json` as
`backgroundAfterSeconds` and applies to subsequent calls immediately. Zero means
immediate background handoff. The main-settings row uses the same internal Pi
1.3 hook as Extraction model; contributions share one cleanup-safe hook.

The tool additionally accepts:
- `yield_after`: override the foreground interval for one call.
- `timeout`: an optional **hard kill deadline**, which remains active after
  backgrounding. There is no default hard deadline.
- `tty: true`: allocate an interactive PTY **at launch**. A pipe process cannot
  acquire a TTY afterward. Use `yield_after: 0` if the user should attach immediately.

Codemode example (no shell `&` or `nohup` required):

```js
const job = await tools.bash({ command: "cmake --build build", yield_after: 15 });
text(job); // background:true and exit_code:null mean still running, not failure
```

Ordinary foreground results match native Bash: `output`, `truncated`,
`exit_code`, and `wall_time_seconds` (rounded to 0.1 seconds), with no process
footer or extra context messages. Empty output and nonzero-exit text also use the
native format. `full_output_path` is returned only for truncated output.
Management fields are optional: `background: true` and `id` identify a running
job; TTY launches and exceptional exits include relevant metadata. False/default
flags are omitted, except `tty` is explicit in background results. A public log
can still be found through `pty_snapshot`, even when absent from the Bash result.
Model-facing output is limited to the last 2000
lines / 50 KiB; codemode receives up to 1 MiB of recent output. Public processes
also capture a mode-0600 log in a private temporary directory, capped at **16 MiB**.
When that cap is exceeded or a write fails, `output_file_truncated: true` means
the log is **not complete**. Snapshots provide up to 64 Ki characters of recent
plain output plus the rendered screen and log path.

### Shared process controls

User-entered `!`/`!!` commands still launch **asynchronous interactive PTYs** in
the terminal UI. All modes share the same registry and stable `pty-N` IDs.
Live previews interpret colors, carriage returns and terminal animations using a
headless xterm emulator rather than forwarding raw cursor controls into Pi.
Previews refresh at most about 12 times/second.

| Control | Action |
| --- | --- |
| Ctrl+O | Expand/collapse previews alongside tool output |
| Ctrl+click a preview | Attach to a TTY or view pipe output |
| `/fg [id]` | Attach to a TTY; open a read-only live viewer for pipe processes |
| Ctrl+Z while attached | Detach without stopping/suspending the process |
| Ctrl+C while attached | Interrupt that session; pipe viewers also support Ctrl+C |
| Ctrl+C in Pi | Normal Pi behavior; a pending foreground tool is cancelled, already-backgrounded jobs are untouched |
| `/pty-list` | Recent-first picker: arrows or Ctrl+K/J, Enter selects, Esc closes |
| `/pty-stop id [SIGTERM\|SIGINT\|SIGKILL]` | Signal a managed process group; default SIGTERM |

Collapsed previews show eight rows for ordinary shell output. Full-screen /
alternate-screen applications show only process metadata and attach controls,
not their startup logos/help headers, including after Ctrl+Z. Expanded previews
still show the screen and up to 2000 retained scrollback lines. Pipe viewers support arrows/PageUp/PageDown to
scroll and Esc/Enter/Ctrl+Z to close; typing does not send stdin. Selecting an
exited process shows its retained output. TTY attachment supports Kitty and
modifyOtherKeys Ctrl+C/Z encodings and interactive/full-screen programs.

Model tools:
- **`pty_list`** discovers IDs, TTY/pipe mode, source and status.
- **`pty_snapshot`** inspects public output/status without attaching or sending input.
- **`pty_stop`** sends SIGTERM/SIGINT/SIGKILL to a public process group.
- **`pty_write`** sends raw UTF-8 `data` to a public TTY; `submit: true` appends
  Enter. Private, exited, pipe and user-attached sessions are denied. Input is
  limited to 16 KiB. It does not attach or take keyboard focus.
- **`subagent_result`** is codemode-only: retrieves a public child's saved final
  answer, not its terminal/history; see the subagent workflow below.

### Exit notifications, privacy and lifetime

Once a model command has returned in the background, its exit queues one
`process-exit` message with **`triggerTurn: true, deliverAs: "followUp"`**.
Public `!` jobs also notify on exit. Notifications contain lifecycle metadata,
not command output, and do not steer/interrupt a current turn. They can start a
new agent turn when idle, so normal model usage charges may apply. Foreground
completions are already returned by `bash` and do not send duplicate notifications.
Inspect output explicitly through snapshots or the public log.

**Private `!!` output stays in memory only:** no disk capture, no exit notification,
commands redacted from model lists, and model snapshot/stop access denied.
Users may still attach or stop their own private jobs.

Processes belong to the current extension runtime. **Exit, reload or session
shutdown kills running process groups and deletes retained logs.** They do not
survive Pi restarts. Sixteen jobs may run concurrently; 32 records are retained,
with old exited/unattached records evicted first. Groups normally cover shell
children; deliberately daemonized jobs that escape their group are unsupported.
In Pi Web, the documented liveness registry prevents automatic idle eviction
while a managed job is running; explicit shutdown still kills it.

All launches honor Pi's user/project `shellPath` and `shellCommandPrefix`, defaulting
to Bash. Model commands receive current Pi session/model metadata rather than
stale inherited metadata; `PI_WEB_PASSWORD` is never inherited. The native Zsh
completion subprocess is not used to execute these jobs.

### Process-to-Pi messages

Every managed launch (model Bash, public `!`, private `!!`, TTY or pipe) receives a
`pi-process` helper on its `PATH`. Descendants inherit it. No D-Bus, external
service or new npm dependency is needed:

```sh
pi-process status "Compiling: 42 / 100 files"
pi-process notify "Ready for integration tests"
pi-process status ""  # Clear the latest status
```

`status` replaces local `statusText`/`statusUpdatedAt`, repaints the process list
and previews, and **never invokes the agent or adds conversation messages**.
The latest status appears in explicit `pty_list`/`pty_snapshot` queries and stays
with the record after exit until eviction. `/pty-list` updates live while open.

`notify` queues an identified **untrusted process-output** message for the main
agent with `triggerTurn: true, deliverAs: "followUp"`. It does not interrupt the
current turn. Messages arriving within 100 ms are batched, with at most 32 KiB
of serialized notification data per batch. Reports stay in the bounded local
queue while the parent is busy and are dispatched once it is idle, after
`agent_settled`. At most one batch is outstanding per run. A handoff to
`pi.sendMessage` is **not** delivery: the exact queued prefix is removed only
when `message_end` confirms that report entered the transcript. This avoids
losing notifications when Escape clears Pi's volatile follow-up queue.
Uncommitted handoffs can retry after settlement or join the next normal run;
committed reports are not replayed. Notifications can cause model usage charges.
Status text is not automatically included in these messages. In the transcript,
notifications render as one width-truncated line with a themed pink `↩` icon,
process ID and report text—no JSON panel or timestamp block. Ctrl+O explicitly
expands the complete report text. This is display-only: the agent still receives
the original identified, untrusted notification payload.

Limits and acknowledgement semantics:
- Status: 1024 UTF-8 bytes, burst 10 updates, refilling at 10/second per process.
- Notify: 8192 UTF-8 bytes, burst 3, refilling at 3/minute per process; global burst
  6, refilling at 6/minute. At most 32 notifications are queued locally.
- One newline-terminated JSON request and acknowledgement per connection, 64 KiB
  maximum frame, 32 active connections, 3-second idle/absolute server and client
  deadlines.
- Success is silent and means accepted locally, **not** guaranteed LLM delivery
  or successful handling. Shutdown discards pending messages. The helper exits
  nonzero on rejection/unavailability, with a short error that does not echo text
  or credentials. Use backoff or `|| :` for best-effort progress under `set -e`.

A private `!!` process may set a user-visible status, but model queries redact it
and notifications are rejected with `private_process`. No private status is
written to a log. Exited/disposed processes cannot send new messages.

The endpoint is one filesystem Unix socket per Pi instance in a short, mode-0700
`/tmp/pi-ipc-*` directory; the socket is mode 0600. Each launch gets an independent
random capability token, revoked on exit. `PI_PROCESS_SOCKET`, `PI_PROCESS_TOKEN`
and `PI_PROCESS_HELPER` identify its endpoint/credential/helper. `PI_PROCESS_ID`,
`PI_PROCESS_PRIVATE` (`0`/`1`) and `PI_PROCESS_DATA_DIR` identify the owning job
and its reserved, random workspace path. Ordinary commands allocate no workspace.
Use
`"$PI_PROCESS_HELPER" status "text"` if a shell rewrites `PATH`. Never print or
persist the token. These variables are overwritten for nested managed launches,
so children of another Pi instance do not accidentally use its credentials.
This is same-host IPC, designed for Linux and macOS (Linux-tested; native macOS
validation is still pending). It is not a security sandbox against the same OS
account/root inspecting process environments.

Programs may use any Unix-socket client with this version-1 protocol, terminated
by a literal newline (substitute the environment token; JSON-escape text):

```json
{"version":1,"token":"<PI_PROCESS_TOKEN>","type":"status","text":"Compiling"}
```

The response is `{"ok":true}` or `{"ok":false,"error":"rate_limited"}` (other error
codes include `unauthorized`, `private_process`, `queue_full`, `text_too_large`,
`frame_too_large` and `invalid_message`). Only `status`/`notify` are accepted;
clients cannot supply another process ID. All resources/capabilities are removed
on reload/shutdown, and late callbacks cannot enqueue new agent messages.

Non-TTY stdin remains closed. `pty_write` controls only unattached public TTYs;
while the user is attached, only their keyboard controls that session.

### Interactive Pi subagents

Use `/subagent <task>` (a minimal prompt alias for the `subagent` skill), or
`/skill:subagent <task>`. The installer includes both resources.

Subagents are **normal Pi TUIs in managed interactive PTYs**, never RPC/print
workers. The parent launches with `tty: true, yield_after: 0`, retains the ID,
and sends later prompts with `pty_write`. `/fg ID` enters the child's normal
session; Ctrl+Z returns to the parent. Attachment is allowed even while the
parent agent works; only its terminal renderer/input is paused. Model input is
rejected while the user owns the child.

The skill invokes its small `launch.mjs` helper. Defaults are Luna, low thinking,
read/bash, and no discovered extensions/skills/context files/MCP. `--model`,
`--thinking` and `--tools` can override those defaults. Every child starts fresh,
with its own persisted session directory and UUID, not the parent's transcript.
Only an explicit `report.ts` extension is loaded. Native child Bash still keeps
inherited `pi-process` progress messages routed to the parent.

The reporter marks each run as working, then exports **only the final assistant
text after `agent_settled`**. Thinking, tool calls/results, banners, and the
working history are never copied to the result. An immutable numbered turn
artifact and current pointer are atomically saved **before** the completion
notification; the child need not spend a model/tool call announcing completion.
Aborted, failed, tool-only and length-limited runs are not reported as completed
answers. Starting a follow-up clears the current result to `running`, preventing
an older answer from being mistaken for the new result.

Retrieve with codemode `tools.subagent_result({ id: "pty-1" })`. It returns
`{id, turn, status, output}`; `turn` optionally selects a previous run.
The default output limit is 8,000 characters, adjustable with `max_chars` (1–65,536).
Truncated responses include `next_offset` and `result_file`; pass `offset` to read
another page without repeating the prefix (offsets are UTF-16 indices).
The artifact reader is deterministic and bounded: **no extra LLM extraction call**.
The tool is codemode-only so its full schemas do not inflate the normal tool list.
Use snapshots only for steering/terminal diagnostics, never to collect final answers.
Task prompts request a concise handoff of at most 200 words; keep detailed work in
artifacts and consult it selectively.

Workspaces live under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/process-data/<random UUID>/`.
Workspace/session directories are mode 0700 and exported JSON records mode 0600;
full JSONL sessions stay on disk, outside the parent's model context. **Unlike
managed terminal logs, these saved sessions/results survive reload and child exit**
until manually deleted. They may contain sensitive task history. The launcher
refuses private `!!` jobs, and the result API rejects private jobs before disk access.
The process-ID lookup lasts only as long as the managed record is retained; after
reload/eviction, inspect or resume saved sessions by their filesystem paths.

Read-only task instructions are not a security sandbox; explicitly scope
permissions. Do not paste over a user draft or blindly retry input. Useful
children stay open for further work rather than exiting after the first answer.

## Transcript selection into the prompt

- **Ctrl+K / Ctrl+J** starts at the latest selectable block, then moves up/down
  through user messages, assistant responses, and tool/native-shell blocks.
- The selected block is scrolled into view and marked with an accent-colored
  **▎** and the theme's selection background.
- **Enter** replaces the prompt with the whole message or full tool text output,
  even if the tool is collapsed. Nothing is submitted.
- **Escape** cancels without changing the draft. Ordinary typing leaves selection
  mode and continues editing normally.

Ctrl+J no longer inserts a newline (**Shift+Enter** still does); Ctrl+K no longer
deletes to end of line. Dialog/list controls retain their own bindings. PTY
previews are not included in this text navigator; use `/fg` or PTY snapshots.
Selection ownership uses proxy-safe identity tokens shared with CLion link
navigation. Shutdown releases the underlying TUI callback and deactivates retained
input/cancel handlers, preventing stale extension-context access after reload.

## Inline CLion links

Inline Markdown links to existing project files open in the current CLion project.
No visible file-list widget is added. Coordinates such as `:line:column` and
`#Lline` are preserved.

On every agent turn, the extension contributes a dedicated system-prompt section
requiring CLion-compatible Markdown links for existing project-file references
in prose. It does not replace other system instructions. A display-only Markdown
transform also converts bare or backticked project-file references into those
links, including during streaming. Commands, fenced/indented code, literal inline
commands, existing Markdown links, user messages, thinking and raw tool output
remain unchanged. This is navigation formatting, not automatic IDE opening.

The display transform and click interception target Pi's terminal UI. Other
frontends receive the prompt guidance, but their link handling is frontend-owned.
Directories, missing/outside-project paths and external web URLs are not converted
into purported working CLion links. This is best-effort formatting, not censorship
or a byte-level prohibition on literal paths in commands and logs.

- **Alt+K / Alt+J** navigates rendered project-file links, starting with the latest.
- Selected links use reverse video and scroll into view; web links are skipped.
- **Enter** opens the selected file; **Escape** cancels without changing the prompt.
- Link selection and Ctrl+K/J message selection cancel each other, so Enter has
  only one action at a time.
- **`/clion`** opens a keyboard picker for the latest assistant file references.
- **`/clion path:line:column`** opens a specific existing project file.

The extension calls Index MCP Server directly—no browser, OS URL handler, port
forwarding, or CLion launcher is involved. The endpoint defaults to
`http://127.0.0.1:29177/index-mcp/streamable-http`. Set **`NES_CLION_MCP_URL`** before
starting Pi to override it (the existing variable name is retained for compatibility).
Only existing files inside Pi's working directory are eligible; directories,
missing paths, code-fenced references, and symlinks escaping the project are
excluded. The backend must have the project open and `ide_open_file` enabled.

## Extract a large blob with a separate model

Use **`/extract [optional instructions]`** to open an empty external-editor buffer,
paste source material, save, and close. For example:

```text
/extract list the errors and their likely causes; preserve exact error messages
/extract extract benchmark results into a Markdown table
/extract
```

For faster large pastes, use **`/epaste [optional instructions]`** instead. It opens
a Pi-native buffer, where large pastes appear as compact paste markers rather
than being streamed into Vim. **Enter** extracts directly; **Ctrl+G** opens the
captured text in your external editor first, already populated from a file.
Save and close to extract, or use `:cq` in Vim to cancel. **Escape/Ctrl+C** in the
paste buffer cancels. Shift+Enter inserts a newline. Both commands use the same
selected model, isolated request, and result-to-prompt behavior. Paste markers
are expanded to their complete original text before editing or extraction.

The last `/extract` form requests a concise structured summary preserving important exact
details. The command uses Pi's configured `externalEditor`, then `VISUAL`, then
`EDITOR`, then `vim`. In Vim, **`:wq`** sends the saved text for extraction;
**`:cq`** cancels. Empty input is not sent.

The extraction result is placed in Pi's input prompt for review; **nothing is
submitted to the main agent automatically**. The current conversation model is
not changed. Only the extraction instructions and complete pasted source are
sent to the side model, with no conversation history or tools. Source material is
marked as untrusted data rather than instructions. The original blob is not
added to the main conversation or session log; only usage metadata is recorded
in an excluded-from-context custom entry. Temporary capture files are removed.
Your editor's own backups/clipboard behavior and the provider's data retention
are outside this extension's control.

Choose the side model through **`/settings` → Extraction model**. The searchable
picker lists authenticated models with catalog pricing and context sizes; it does
not change the main conversation model. The choice is saved in
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/extract.json` and takes effect immediately.
There is no separate settings command. The row uses an internal Pi 1.3 UI hook
and may need adjustment after Pi upgrades.

Default model: **`openai/gpt-6.1-terra`**, using Pi's existing provider configuration
and credentials. There is no silent fallback to the main model. Saved settings
take precedence over the environment. Without a saved choice, set these before
starting Pi to override:

```sh
export PI_EXTRACT_MODEL=openai/gpt-6.1-terra   # provider/model-id
export PI_EXTRACT_MAX_TOKENS=8192             # output limit, capped by the model
```

The request uses minimal reasoning where supported. Escape cancels the request
from the progress UI; a five-minute timeout is also applied. Cancellations and
errors leave the prompt unchanged. Output-limit truncation is explicitly warned
about. Source text is **not silently truncated or split**: requests beyond the
model's context limit can fail and must be reduced/retried. Usage is shown in a
notification and recorded as metadata, but this side request does not count as a
normal agent tool call in Pi's conversation totals.

Finish any active agent operation before invoking `/extract`. No live model calls
are made by its test suite.

### Summarize tool output from codemode

The model-callable **`extract_text`** tool uses the same saved extraction model
without any UI, editor, or prompt changes. It is exposed through codemode:

```js
const run = await tools.bash({ command: "your-command", timeout: 60 });
const result = await tools.extract_text({
    text: run.output,
    instructions: "Summarize failures; preserve exact error messages and counts.",
    max_tokens: 2048,
});
text({ exit_code: run.exit_code, source_truncated: run.truncated, ...result });
```

Only print the extraction result, not the raw output, to keep the latter out of
the main model context. The tool returns `{ summary, model, truncated }`; always
check `truncated` before treating the summary as complete. If the originating
tool truncated its output, that missing text is not magically recovered: read
its full-output file through codemode first if complete input is required.

Each call makes a separately billed model request, and its usage is included in
Pi's tool/session totals. Caller cancellation, runtime shutdown, and a five-minute
timeout abort the request. Errors fail the tool rather than falling back to the
main model. No conversation history or tools are sent to the side model. Tool
arguments can be retained by Pi (including nested-call metadata); this is not a
secret-storage mechanism. Never send private PTY output or credentials.

## Output editing and compact tool summaries

- **Alt+G:** open the latest **completed** assistant response in the external
  editor, including while the agent is working. Streaming, interrupted,
  truncated, and tool-call-only/preamble messages are skipped.
- **Ctrl+Alt+G:** arm a one-shot picker; click a user/assistant message or completed
  tool block. A compact tool summary opens the full tool text output, not the
  summary. Escape cancels; scrolling is supported.

Saving and exiting replaces the prompt with the file contents. History is
unchanged and nothing is submitted automatically. As with Ctrl+G, a normal editor
exit imports the file even if unchanged; use **`:cq`** in Vim to cancel. The editor
uses `VISUAL`, then `EDITOR`, then `vim`. Opening it pauses only terminal rendering
and input; the agent continues working and its updated transcript is redrawn on
return. Images are not converted to text.

Collapsed tool calls use one summary line with a theme-colored success tick,
error cross, or muted pending indicator. Muted `↑  N ↓  N` values estimate text
tokens for arguments/output (characters divided by four); they are **not billed
model usage**. Each number is right-aligned in three characters, keeping tool
names vertically aligned, without tildes or a separator dot. Labels use compact
units such as `679`, `2k`, `23k`, or `.8M` (800,000). Unit values are whole numbers
unless below one, where a single decimal omits the leading zero.
Pending output uses a dash in the same fixed-width column. Ctrl+O or clicking
expands the original tool rendering where available.

## Zsh completion

For single-line `!`/`!!` input, put the cursor at the end and press Tab, e.g.
`!git che` or `!git checkout main`. Normal prose, multiline and mid-line completion
retain Pi's native provider. Empty results, failures and timeouts fall back to Pi.

A disposable interactive Zsh runs in a Python PTY, loads your `.zshrc`/`ZDOTDIR`,
and calls the normal completion system through ZLE. Aliases, custom `compdef`
functions, and plugins participate. Each uncached request has a three-second
deadline; a short cache avoids identical repeat requests. Startup configuration
loads per request, so expensive `.zshrc` setup adds latency. Unsaved state in
another shell is not inherited.

The typed command is not submitted, but normal startup/completion code runs with
your permissions and can invoke programs or access the network. Completion menus,
descriptions and unusual insertion flags are not fully reproduced. Execution
still uses Pi's configured shell (Bash by default), so Zsh-only aliases or syntax
can complete without being executable by Pi.

## Native shell-output colors

PTYs provide TTY detection and terminal colors naturally. The installer also
retains the earlier Pi 1.3 patch for native/non-PTY `!` output. It preserves SGR
colors/styles while removing cursor movement, clipboard/title commands, and
other terminal controls. Model context and saved native-shell session output
remain plain, so historical replay is plain too. `FORCE_COLOR` and `CLICOLOR_FORCE`
are enabled unless `NO_COLOR` is set. Programs requiring explicit flags may need
`--color=always` or `git -c color.ui=always` on the native/non-PTY path.

The installer patches bundled and unbundled runtime files, keeps
`.pre-shell-colors` backups, and fails visibly if an upgrade changes expected
code. **Restart Pi after installation.** Model-issued Bash output uses separate
sanitization and is not changed by this patch.

## Tests and portability

After installing the extensions, run from this folder:

```sh
bash test.sh
```

The test script installs the local pinned PTY dependencies and runs the node and
Python suites. Integration tests locate Pi through `PATH`. The shell-color test
expects its runtime patch to have been applied by `install.sh`.

Several UI features use internal Pi layout, component and URL-dispatch hooks.
They are tested against Pi 1.3.0 and may need updates after Pi upgrades. Keep this
folder intact when extracting it: no source/test path depends on the parent
project. The parent devcontainer only supplies CLI/system dependencies, persists
the agent directory, sets the editor, and invokes `install.sh`.
