# Compact activity on normal upstream Pi

The entire customization lives in this repository. No Pi fork, source checkout,
TypeScript compiler, external patch utility, or separate Pi build is required.

## Installation and supported runtime

Run the normal setup installer:

```sh
bash install.sh
```

It installs the extension resources and applies
`extensions/compact-tools/install.py` to the Pi executable found on `PATH`.
Currently supported: the **upstream Node/npm Pi 1.5.2 package**, on Linux.
Bun standalone binaries and other Pi versions are not supported by this patch.

To select a particular upstream executable or inspect the current installation:

```sh
python3 extensions/compact-tools/install.py --pi /absolute/path/to/pi
python3 extensions/compact-tools/install.py --check
```

The installer validates the package version, every original-file checksum, every
replacement anchor, and the activity-component checksum before changing runtime
files. The patch is display-only: session entries and model context are unchanged.

Public extensions can customize tool renderers and widgets, but cannot fully hide
normal thinking/tool transcript rows or own the built-in expansion cycle. The
small runtime patch adds those display controls. It patches upstream's unbundled
UI files and makes the normal CLI entry delegate to upstream's existing
`dist/cli.js`, with Node's compile cache enabled. This avoids editing minified
bundle internals or replacing Pi with a fork. All implementation files and patch
fragments are under `extensions/compact-tools/`.

Original files are retained beside their targets with `.pre-compact-ui` suffixes.
The shell-color customization is preserved, whether installed before or after the
compact UI patch. Files are replaced atomically; an interrupted write operation
rolls back changes made by that installer invocation. A different Pi version,
modified runtime file, conflicting asset, or missing backup fails visibly rather
than guessing. Reinstallation is idempotent.

**Restart Pi** after installation. `/reload` refreshes extensions, not core code.
A Pi update can replace runtime patches: rerun setup afterward. If the upstream
layout or version is unsupported, update the checked patch in this repository.
Before changing the compact patch itself to a different patch version, uninstall
it with the current repository revision first.

The extension adds `/settings` → **Compact activity**, persisted as the single
`activityEnabled` boolean in the agent directory's `compact-tools.json`. It is
On by default. Off restores inline one-line summaries and the ordinary two-state
Ctrl+O expand/collapse cycle. The native menu applies changes immediately; direct
file edits are read at startup/reload.

## Removing the customization

```sh
python3 extensions/compact-tools/install.py --uninstall
```

This restores the original upstream runtime and removes the owned activity asset
and patch-state file. Original backups are kept. It refuses to overwrite runtime
files edited after installation. The existing shell-color patch is not removed.
Restart Pi afterward. No launcher pointing at a different Pi build is necessary.

## Installer regression tests

These tests use temporary copies of the supported installed runtime, never the
live package. When already patched, they copy the original backups so clean
installation and restoration remain testable:

```sh
python3 -m unittest discover -s extensions/compact-tools -p 'test_*.py' -v
```

Set `PI_COMPACT_TEST_BASE_PI` to select another upstream executable. Coverage
includes fresh installation, repeat installation, executable permissions,
unsupported versions, unrelated edits/assets, missing backups, symlink rejection,
write-failure rollback, uninstall/reinstall, and shell-color interoperability.
They also run as part of `bash test.sh`.

## Real-terminal acceptance tests

These tests start the actual installed Pi CLI in a real Kitty window on a private
Xvfb X11 display. A test-only provider emits deterministic reasoning, text, and
tool-call streams; gated tools execute through Pi's normal pipeline. No remote
model request or API key is used. Background cases start actual managed shell
processes and report status through their normal notification sockets.

Prerequisites:

- Linux and Python 3.9+ (the shared cleanup harness uses Linux pidfds).
- Patched upstream Pi 1.5.2 on `PATH`, Node.js 22.23+, and pinned PTY dependencies.
- `Xvfb`, Kitty/`kitten`, `xclip`, `xdotool`, and software OpenGL/Mesa support.

The Kitty clipboard testing guide describes installing the display prerequisites.
This suite reuses its private-display/process cleanup helper; it neither reads
nor overwrites the user's real clipboard. Install PTY dependencies, if needed:

```sh
npm ci --prefix extensions/pty-sessions --no-audit --no-fund
```

`node-pty` may require a compiler and Python for its native binding. Review its
pinned lifecycle scripts when setting up a new environment.

### Verify the terminal harness first

The following infrastructure baseline works even on unmodified upstream Pi. It
proves that the harness can drive a real prompt, streaming response, two actual
tool executions, and a final answer while checking persisted history:

```sh
python3 extensions/compact-tools/test-tui.py \
  CompactTuiTests.test_environment_drives_real_streaming_tools_and_preserves_history
```

This baseline passed before implementing compact mode. The compact acceptance
case was then run on unmodified Pi and failed because reasoning accumulated in
the transcript instead of updating above the prompt.

### Run acceptance tests against the normal installed Pi

```sh
python3 extensions/compact-tools/test-tui.py
PI_COMPACT_TEST_TUI_MODE=regular python3 extensions/compact-tools/test-tui.py
```

`PI_COMPACT_TEST_PI=/absolute/path/to/pi` can select an isolated installed package
for testing. No source checkout or model-catalog generation is needed. Unpatched
upstream Pi is expected to fail feature acceptance cases, not the baseline.

The runner creates a private agent directory, selects only the local fake model,
disables automatic compaction, and loads just compact-tools, managed processes,
and the fixture. Its model URL is an unused loopback endpoint; streaming runs
in-process rather than through a server that could forward a paid API request.
A held Kitty window preserves startup errors for diagnostics.

Fast component tests use a deterministic clock to verify 500 ms coalescing,
trailing refresh, quiet-process timer ticks, short-lived task suppression,
interaction/resize bypasses, and cancellation on teardown. Activity updates do
not throttle the response transcript, editor, or native Working animation.

The terminal scenarios check:

- The native Working indicator staying in the prompt border, including before the first provider event.
- Markdown formatting, normal output alignment, and one consistent blank row above and below visible activity.
- Process rows without bullets, aligned for both supported output-padding settings.
- Latest reasoning replacing old activity instead of accumulating in history.
- Concurrent tools appearing as distinct live tasks and disappearing on completion.
- Ctrl+O cycling compact, inline summaries, full output, and back to compact.
- No extra provider requests when changing the display mode.
- Complete history remaining expandable after settlement and reload.
- Failed tool bodies remaining hidden until full expansion.
- Remapped expansion keys and native dialog focus/cancellation behavior.
- Narrow resizing, wide Unicode, draft preservation, and one-line activity.
- Escape clearing foreground activity without losing the draft or saved reasoning.
- Thinking preferences not bypassing compact transcript filtering.
- Real background jobs stacking above the prompt and disappearing on exit.
- Notification reports remaining in history without polluting the compact log.
- Compact process elapsed timers, dense headers without dot separators, and Ctrl-click preview expansion.
- Ctrl-click per-tool expansion without consuming ordinary text-selection clicks.
- The binary switch applying through native `/settings`, persisting across reload,
  and restoring the two-state Ctrl+O cycle when Off.

Mouse cases inject SGR packets into the actual Pi stdin parser using coordinates
from Kitty's real rendered screen. They run in fullscreen mode; regular mode
leaves mouse ownership to the terminal and skips these two cases. `/fg` and
keyboard expansion remain available there.

Real-terminal tests are separate from the normal unit suite because they require
GUI terminal/X11 dependencies. All fixture files, session logs, display sockets,
and child processes belong to a private temporary directory and are cleaned up
on both success and failure. The acceptance tests do not change the user's
launcher, extension links, credentials, or agent configuration.
