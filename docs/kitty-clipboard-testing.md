# Testing direct Kitty clipboard reads

The clipboard bridge speaks Kitty's OSC 5522 protocol directly. Its runtime needs
only Pi and Node, not `kitten`, `xclip`, an SSH wrapper, or display access on the
machine running Pi. The tools below are **test-only** dependencies.

## Environment

Validated in an Arch Linux devcontainer with:

- Kitty / kitten **0.50.0**
- Node.js **26.13.0**, Pi **1.5.2**
- Xvfb **21.1.26**, Mesa software rendering, xclip and xdotool
- Python 3 and OpenSSH client/server

Install the test tools on Arch (a full update avoids stale rolling-release
package URLs and partial upgrades):

```sh
sudo pacman -Syu --needed kitty xorg-server-xvfb xclip xdotool mesa \
    fontconfig ttf-dejavu libxkbcommon-x11 openssh
```

On Debian/Ubuntu, the corresponding graphical dependencies are:

```sh
sudo apt-get update
sudo apt-get install xvfb xclip xdotool libgl1-mesa-dri libegl1 \
    libfontconfig1 libxkbcommon-x11-0 fonts-dejavu-core openssh-client openssh-server
```

Install a recent Kitty separately if the distro package lacks OSC 5522 support.
The official Kitty binary installation can be used; ensure both `kitty` and
`kitten` are on the **test driver's** PATH. The extension never launches either.
No privileged GPU/device access is required: the harness uses X11 and
`LIBGL_ALWAYS_SOFTWARE=1`.

## Commands

From the checkout root:

```sh
# Fast protocol, lifecycle and native editor/parser tests; installed Pi required.
node --test extensions/kitty-clipboard/*.test.mjs extensions/kitty-clipboard/*.test.ts

# Real Kitty and full Pi, including loopback SSH when run as root.
python3 extensions/kitty-clipboard/test-kitty.py

# Run only one scenario while investigating.
python3 extensions/kitty-clipboard/test-kitty.py \
    RealKittyTests.test_pi_slow_fragmented_replies_never_enter_the_editor
```

The real-terminal tests are explicit, not included in the normal test script:
ordinary extension contributors need not install a graphical stack. Missing
prerequisites fail with a diagnostic rather than silently replacing Kitty with a
mock. Only the isolated SSH test is skipped for non-root users; it needs to start
a private sshd capable of accepting a login. Run as root inside a disposable
container to exercise the entire suite. No existing SSH daemon, authorized-keys
file, known-hosts file or Kitty configuration is changed.

## What is actually tested

Each scenario allocates a private Xvfb display and starts a real Kitty process
with an isolated configuration. xclip owns a deterministic 37 KB PNG on that
display; its incompressible pixels force multiple protocol DATA packets. The
fixture is round-tripped through X11 before each request. Neither your desktop
clipboard nor your current Pi session is used.

An independent Python client first checks the terminal transport itself:

- Correlated OK / DATA / DONE packets, decoded chunk sizes and exact SHA-256.
- Explicit permission denial.
- The real Kitty permission overlay, approved by simulated X11 keyboard input.

Full-Pi tests load only the clipboard extension plus a test observer. The observer
uses Pi's native editor, records the transformed input hook, then **handles the
submission locally**. No model request, API key or paid tokens are used. Checks
cover:

- Actual Ctrl+V followed by Enter attaches exactly the fixture's bytes to one
  user input; staging itself neither submits nor creates a preview message.
- The Pi client has no DISPLAY or WAYLAND_DISPLAY and only Node on its PATH:
  no remote `kitten`, `xclip`, `wl-paste` or shell helper can supply the result.
- No alternate-screen exit occurs during the read: the TUI stays running.
- Both approving and denying the actual Kitty permission overlay.
- Permission denial preserves the draft and keeps Pi alive.
- Text-only clipboard detection leaves the draft alone; ordinary terminal
  Ctrl+Shift+V still pastes the text normally.
- Slow real replies forwarded through a transparent PTY relay, split with
  **80 ms gaps** (past Pi's incomplete-OSC timeout). Headers, base64 payloads and
  terminators must not appear in the native editor, and the image hash must match.
- An actual `ssh -tt` connection to a temporary, loopback-only sshd, using generated
  throwaway keys, with the same display-less/helper-less Pi client. Image bytes
  travel through the SSH terminal connection, not a shared image-file path.

The SSH test runs both endpoints in the container; it proves the terminal
transport across real SSH, not cross-platform behavior or every network topology.
The suite does not claim tmux/screen or Wayland-backend coverage, macOS clipboard
coverage, provider-side image processing, or session persistence after submission.

All clients, clipboard owners, X servers and the temporary SSH daemon are stopped
on cleanup. State files and generated keys live in temporary directories and are
removed. Timeout failures include the Kitty screen and helper logs for diagnosis;
all clipboard content used by the suite is synthetic.

## Protocol references

- Kitty clipboard protocol: https://sw.kovidgoyal.net/kitty/clipboard/
- Reference implementation: https://github.com/kovidgoyal/kitty/blob/v0.50.0/kitty/clipboard.py

Read replies are `type=read:status=OK`, then `status=DATA` with a base64 MIME and
payload, then `status=DONE`. Every decoded DATA chunk is at most 4096 bytes and
is decoded independently; concatenating padded base64 chunks before decoding is
incorrect. The `id` field must be echoed in every response. Listing MIME types
uses the base64 encoding of `.` and, with Kitty's normal ask policy, does not
itself prompt for clipboard contents.
