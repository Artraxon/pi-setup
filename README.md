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
terminates those sessions and clears their in-memory output. The native shell
color patch changes Pi runtime files and requires a **Pi restart**, not just
`/reload`. Rerun the installer after updating Pi.

## Layout

```text
install.sh
README.md
test.sh
extensions/
  clion-file-actions/   Inline CLion navigation and /clion
  compact-tools/       One-line collapsed tool summaries
  message-selection/   Ctrl+K/J transcript selection into the prompt
  output-editor/       Edit response/block text into the prompt
  pty-sessions/        Background PTYs, live previews and attachment
  shell-colors/        Native shell-output SGR preservation
  zsh-completion/      Zsh completion bridge for ! and !! input
```

Tests live beside their extension. Dependencies and generated caches are ignored.
The installer copies runtime files only, not test entry points, into Pi's
extension directories.

## Interactive PTY sessions

User-entered `!`/`!!` commands start **asynchronous background PTYs** rather than
blocking Pi until exit. Live transcript previews interpret colors, progress
updates, carriage returns, and standard VT animations using a headless xterm
terminal emulator. Raw cursor-control sequences are not forwarded into Pi's UI.
Previews refresh at most about 12 times/second.

| Control | Action |
| --- | --- |
| Ctrl+O | Expand/collapse previews alongside tool output |
| Ctrl+click a preview | Attach and give the PTY keyboard focus |
| `/fg [id]` | Attach; default is the most recently used running PTY |
| Ctrl+Z while attached | Detach without stopping or suspending the program |
| Ctrl+C while attached | Interrupt that PTY's foreground process group |
| Ctrl+C in Pi | Normal Pi behavior; detached PTYs are untouched |
| `/pty-list` | Recent-first picker: arrows or Ctrl+K/J, Enter selects, Esc closes |

Collapsed previews show the most recent eight screen rows (the first eight for
full-screen applications). Expanded previews show the entire rendered screen and
up to 2,000 retained scrollback lines. Selecting an exited session opens its final
screen. Ctrl+Z is reserved for detachment rather than normal Unix job control.
Kitty and modifyOtherKeys encodings of Ctrl+C/Z are supported.

Read-only model tools:

- **`pty_list`** discovers sessions, status and exit information.
- **`pty_snapshot`** reads the current rendered screen, dimensions, cursor position,
  timestamp and process status. It does not attach or send input.

Only startup metadata is automatically included in model context, not PTY output.
Public output is retrieved explicitly through snapshots. `!!` sessions are
private: model listings redact their commands and snapshots refuse their output.
You can still attach to private sessions yourself.

PTYs live in memory for the current extension runtime. **Exit, reload, or session
shutdown terminates running PTYs.** They do not survive restarting Pi. Up to 16
PTYs may run concurrently; the most recent 32 sessions are retained with bounded
scrollback/logs. Historical preview messages show an unavailable marker after
reload. Attach only while the agent is idle. Embedded previews do not implement
mouse interaction or terminal graphics; direct attachment forwards normal
terminal output and supports interactive/full-screen applications.

Model-issued Bash calls are unchanged. User PTYs use Pi's configured
`shellPath`/`shellCommandPrefix` from user/project settings, defaulting to Bash.
They do not run in the Zsh completion subprocess.

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

## Inline CLion links

Inline Markdown links to existing project files open in the current CLion project.
No visible file-list widget is added. Coordinates such as `:line:column` and
`#Lline` are preserved.

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

## Output editing and compact tool summaries

- **Alt+G:** open the latest assistant response in the external editor.
- **Ctrl+Alt+G:** arm a one-shot picker; click a user/assistant message or completed
  tool block. A compact tool summary opens the full tool text output, not the
  summary. Escape cancels; scrolling is supported.

Saving and exiting replaces the prompt with the file contents. History is
unchanged and nothing is submitted automatically. As with Ctrl+G, a normal editor
exit imports the file even if unchanged; use **`:cq`** in Vim to cancel. The editor
uses `VISUAL`, then `EDITOR`, then `vim`. Finish any active agent turn before
opening it. Images are not converted to text.

Collapsed tool calls use one summary line with a theme-colored success tick,
error cross, or muted pending indicator. Muted `↑~N ↓~N` values estimate text tokens
for arguments/output (characters divided by four); they are **not billed model
usage**. Ctrl+O or clicking expands the original tool rendering where available.

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
