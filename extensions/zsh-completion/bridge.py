#!/usr/bin/env python3
"""Run normal Zsh completion inside a disposable PTY; return JSON, not terminal bytes."""
import json
import os
import pty
import select
import signal
import sys
import tempfile
import time
from pathlib import Path


def complete(request):
    with tempfile.TemporaryDirectory(prefix="pi-zsh-") as directory:
        result = Path(directory) / "matches"
        env = dict(os.environ, PI_ZSH_BUFFER=request["buffer"],
                   PI_ZSH_CURSOR=str(request["cursor"]), PI_ZSH_RESULT=str(result))
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(request["cwd"])
            script = str(Path(__file__).with_name("complete.zsh"))
            command = 'source "$1"; _pi_start() { BUFFER=$PI_ZSH_BUFFER; CURSOR=$PI_ZSH_CURSOR; print -u2 -- __PI_ZSH_READY__; }; zle -N zle-line-init _pi_start; vared -c _pi_dummy'
            os.execvpe("zsh", ["zsh", "-i", "-c", command, "pi-completion", script], env)
        try:
            deadline = time.monotonic() + 3
            terminal_output = b""
            triggered = False
            while time.monotonic() < deadline:
                if select.select([master], [], [], 0.03)[0]:
                    try:
                        terminal_output += os.read(master, 65536)
                        if not triggered and b"__PI_ZSH_READY__" in terminal_output:
                            os.write(master, b"\x18\x1a")
                            triggered = True
                        terminal_output = terminal_output[-4096:]
                    except OSError:
                        break
                if result.exists():
                    data = result.read_bytes().split(b"\0")
                    if b"__PI_ZSH_DONE__" in data:
                        values = [v.decode("utf-8", "replace") for v in data[:data.index(b"__PI_ZSH_DONE__")]]
                        return list(dict.fromkeys(values))[:200]
            return []
        finally:
            try:
                os.killpg(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(master)
            os.waitpid(pid, 0)


if __name__ == "__main__":
    def terminate(_signal, _frame):
        raise TimeoutError("completion cancelled")

    signal.signal(signal.SIGTERM, terminate)
    try:
        print(json.dumps(complete(json.load(sys.stdin))))
    except Exception:
        print("[]")
