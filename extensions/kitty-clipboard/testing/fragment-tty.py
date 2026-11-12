"""Transparent PTY relay that delays pieces of real Kitty replies past Pi's OSC timeout."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import sys
import termios
import time
import tty
from collections import deque
from pathlib import Path


def main():
    state_path = Path(sys.argv[1])
    original = termios.tcgetattr(0)
    size = fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
    pid, master = pty.fork()
    if pid == 0:
        os.execv(sys.argv[2], sys.argv[2:])
    fcntl.ioctl(master, termios.TIOCSWINSZ, size)
    queue = deque()
    pending = b""
    next_time = 0
    frames = 0

    def enqueue(data, delay=0):
        nonlocal next_time
        next_time = max(time.monotonic(), next_time) + delay
        queue.append((next_time, data))

    try:
        tty.setraw(0)
        while True:
            now = time.monotonic()
            while queue and queue[0][0] <= now:
                _, data = queue.popleft()
                os.write(master, data)
            ready = select.select([0, master], [], [], 0.01)[0]
            if master in ready:
                try:
                    output = os.read(master, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not output:
                    break
                os.write(1, output)
            if 0 in ready:
                data = os.read(0, 65536)
                if not data:
                    break
                pending += data
                while pending:
                    start = pending.find(b"\x1b]5522;")
                    if start < 0:
                        # Retain a possible split OSC prefix; ordinary keys are
                        # forwarded without interpreting their keyboard encoding.
                        if b"\x1b]5522;".startswith(pending):
                            break
                        enqueue(pending)
                        pending = b""
                        break
                    if start:
                        enqueue(pending[:start])
                        pending = pending[start:]
                    end = pending.find(b"\x1b\\")
                    if end < 0:
                        break
                    frame, pending = pending[:end + 2], pending[end + 2:]
                    enqueue(frame[:1])
                    enqueue(frame[1:16], 0.08)
                    enqueue(frame[16:-1], 0.08)
                    enqueue(frame[-1:], 0.08)
                    frames += 1
                    state_path.write_text(json.dumps({"fragmentedFrames": frames, "gapMs": 80}))
    finally:
        termios.tcsetattr(0, termios.TCSANOW, original)
        os.close(master)
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
