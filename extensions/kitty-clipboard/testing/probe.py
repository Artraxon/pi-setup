"""Independent OSC 5522 smoke client; does not import the extension or run kitten."""
import base64
import hashlib
import json
import os
import select
import sys
import termios
import time
import tty
from pathlib import Path


def main():
    fd = sys.stdin.fileno()
    previous = termios.tcgetattr(fd)
    frames = []
    data = bytearray()
    pending = b""
    try:
        tty.setraw(fd)
        request = b"\x1b]5522;type=read:id=probe;" + base64.b64encode(b"image/png") + b"\x1b\\"
        os.write(sys.stdout.fileno(), request)
        deadline = time.monotonic() + 15
        complete = False
        while not complete and time.monotonic() < deadline:
            if not select.select([fd], [], [], 0.1)[0]:
                continue
            pending += os.read(fd, 65536)
            while b"\x1b\\" in pending:
                frame, pending = pending.split(b"\x1b\\", 1)
                if not frame.startswith(b"\x1b]5522;"):
                    continue
                header, _, payload = frame[len(b"\x1b]5522;"):].partition(b";")
                meta = dict(pair.split(b"=", 1) for pair in header.split(b":"))
                assert meta[b"id"] == b"probe"
                status = meta[b"status"].decode("ascii")
                frames.append(status)
                if status == "DATA":
                    assert base64.b64decode(meta[b"mime"], validate=True) == b"image/png"
                    chunk = base64.b64decode(payload, validate=True)
                    assert len(chunk) <= 4096
                    data.extend(chunk)
                if status not in ("OK", "DATA"):
                    complete = True
        result = {"statuses": frames, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        Path(sys.argv[1]).write_text(json.dumps(result))
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, previous)


if __name__ == "__main__":
    main()
