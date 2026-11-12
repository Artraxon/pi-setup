#!/usr/bin/env python3
"""Real Kitty/X11 clipboard tests on a private Xvfb display; no model/API calls."""
import hashlib
import json
import os
import random
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import time
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent


def png_fixture():
    # Incompressible pixels force multiple 4096-byte protocol packets.
    random_bytes = random.Random(5522).randbytes(96 * 96 * 4)
    pixels = b"".join(b"\0" + random_bytes[row * 384:(row + 1) * 384] for row in range(96))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 96, 96, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


class KittyEnvironment:
    def __init__(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pi-kitty-test-")
        self.root = Path(self.temporary.name)
        self.processes = []
        self.logs = []
        read_fd, write_fd = os.pipe()
        self.start(["Xvfb", "-displayfd", str(write_fd), "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
                   "xvfb", pass_fds=[write_fd])
        os.close(write_fd)
        try:
            if not select.select([read_fd], [], [], 10)[0]:
                raise RuntimeError("Xvfb did not allocate a display")
            display = os.read(read_fd, 100).decode().strip()
        finally:
            os.close(read_fd)
        self.env = {**os.environ, "DISPLAY": f":{display}", "LIBGL_ALWAYS_SOFTWARE": "1"}
        self.socket = self.root / "control.sock"

    def start(self, command, name, **kwargs):
        log = open(self.root / f"{name}.log", "wb")
        self.logs.append(log)
        process = subprocess.Popen(command, stdout=log, stderr=log, **kwargs)
        self.processes.append(process)
        return process

    def clipboard(self, mime, data):
        process = self.start(["xclip", "-selection", "clipboard", "-in", "-target", mime, "-silent"],
                             "clipboard", env=self.env, stdin=subprocess.PIPE)
        process.stdin.write(data)
        process.stdin.close()
        # Round-trip through X11, not just a sleep, before asking Kitty to read.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = subprocess.run(["xclip", "-selection", "clipboard", "-out", "-target", mime],
                                    env=self.env, capture_output=True, timeout=2)
            if result.returncode == 0 and result.stdout == data:
                return
            time.sleep(0.05)
        raise AssertionError("X11 clipboard fixture was not installed")

    def kitty(self, command, control="read-clipboard write-clipboard"):
        return self.start([shutil.which("kitty"), "--config", "NONE",
                           "-o", "linux_display_server=x11", "-o", f"clipboard_control={control}",
                           "-o", "allow_remote_control=socket-only", "--listen-on", f"unix:{self.socket}",
                           *command], "kitty", env=self.env)

    def remote(self, *args):
        return subprocess.run(["kitten", "@", "--to", f"unix:{self.socket}", *args],
                              env=self.env, capture_output=True, text=True, timeout=10, check=True).stdout

    def key(self, *keys):
        # XTest exercises the actual GUI input path, including Kitty permission
        # dialogs (remote send-key does not reliably target its ask kitten).
        window = json.loads(self.remote("ls"))[0]["platform_window_id"]
        subprocess.run(["xdotool", "windowfocus", "--sync", str(window), "key", "--clearmodifiers", *keys],
                       env=self.env, check=True, capture_output=True, timeout=5)

    def wait(self, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.05)
        logs = "\n".join(path.read_text(errors="replace") for path in self.root.glob("*.log"))
        raise AssertionError(f"Timed out waiting for Kitty test condition\n{self.screen()}\n{logs}")

    def result(self, name="result.json"):
        path = self.root / name
        if path.exists():
            try:
                return json.loads(path.read_text())
            except json.JSONDecodeError:
                pass
        return None

    def screen(self):
        try:
            return self.remote("get-text", "--match", "state:focused")
        except (subprocess.SubprocessError, OSError):
            return ""

    def stop_client(self):
        # Kitty can exit before its Pi child finishes graceful shutdown. Wait
        # for the actual client (also through SSH/PTY relays) before deleting
        # files that the observer's interval may still be updating.
        pid_file = self.root / "client.pid"
        if not pid_file.exists():
            return
        pid = int(pid_file.read_text())
        try:
            descriptor = os.pidfd_open(pid)
        except ProcessLookupError:
            return
        try:
            if select.select([descriptor], [], [], 0)[0]:
                return
            marker = f"PI_CLIPBOARD_TEST_STATE={self.root / 'state.json'}".encode()
            try:
                environment = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                if select.select([descriptor], [], [], 1)[0]:
                    return
                raise
            if marker not in environment:
                raise RuntimeError("Refusing to signal a process not owned by this test")
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if select.select([descriptor], [], [], 0)[0]:
                    return
                try:
                    signal.pidfd_send_signal(descriptor, sig)
                except ProcessLookupError:
                    return
                if select.select([descriptor], [], [], 3)[0]:
                    return
            raise RuntimeError("Test Pi client did not exit before cleanup")
        finally:
            os.close(descriptor)

    def close(self, failed=False):
        try:
            self.stop_client()
        finally:
            for process in reversed(self.processes):
                if process.poll() is None:
                    process.terminate()
            for process in reversed(self.processes):
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            for log in self.logs:
                log.close()
            if failed:
                for path in self.root.glob("*.log"):
                    print(f"\n--- {path.name} ---\n{path.read_text(errors='replace')}")
            self.temporary.cleanup()


class RealKittyTests(unittest.TestCase):
    def setUp(self):
        self.environment = KittyEnvironment()
        self.addCleanup(self.environment.close)
        self.png = png_fixture()
        self.environment.clipboard("image/png", self.png)

    def probe(self, control="read-clipboard write-clipboard"):
        return self.environment.kitty(["python3", str(HERE / "testing/probe.py"),
                                       str(self.environment.root / "result.json")], control)

    def start_pi(self, control="read-clipboard write-clipboard", fragmented=False, ssh=False):
        env = self.environment
        cli = str(Path(shutil.which("pi")).resolve())
        command = [shutil.which("python3"), str(HERE / "testing/run-pi.py"), str(env.root),
                   shutil.which("node"), cli, str(HERE / "index.ts"), str(HERE / "testing/pi-observer.ts")]
        if fragmented:
            command = [shutil.which("python3"), str(HERE / "testing/fragment-tty.py"), str(env.root / "fragment-state.json"), *command]
        if ssh:
            command = self.ssh_command(command)
        process = env.kitty(command, control)
        initial = env.wait(lambda: env.result("state.json"), timeout=30)
        self.assertTrue(initial["isTTY"])
        self.assertIsNone(initial["display"])
        self.assertIsNone(initial["wayland"])
        self.assertEqual(list(Path(initial["path"]).iterdir()), [Path(initial["path"]) / "node"])
        env.key("ctrl+e")
        return process, initial

    def ssh_command(self, command):
        env = self.environment
        if os.geteuid() != 0:
            self.skipTest("Isolated loopback sshd test requires root (the other Kitty tests do not)")
        for tool in ("sshd", "ssh", "ssh-keygen"):
            if not shutil.which(tool):
                self.fail(f"Missing SSH test dependency: {tool}")
        for name in ("host-key", "client-key"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(env.root / name)], check=True)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        config = env.root / "sshd.conf"
        config.write_text(f"""Port {port}
ListenAddress 127.0.0.1
HostKey {env.root / 'host-key'}
PidFile {env.root / 'sshd.pid'}
AuthorizedKeysFile {env.root / 'client-key.pub'}
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
StrictModes no
UsePAM no
PrintMotd no
LogLevel ERROR
AllowUsers root
""")
        env.start([shutil.which("sshd"), "-D", "-e", "-f", str(config)], "sshd")

        def listening():
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    return True
            except OSError:
                return False

        env.wait(listening)
        return [shutil.which("ssh"), "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no",
                "-o", "UserKnownHostsFile=/dev/null", "-o", "IdentitiesOnly=yes", "-i", str(env.root / "client-key"),
                "-p", str(port), "-tt", "root@127.0.0.1", shlex.join(command)]

    def test_pi_image_paste_over_real_ssh(self):
        env = self.environment
        self.start_pi(ssh=True)
        env.key("ctrl+v")
        env.wait(lambda: (state := env.result("state.json")) and "[#image " in state["draft"])
        env.key("Return")
        state = env.wait(lambda: (value if (value := env.result("state.json")) and value["submissions"] else None))
        self.assertTrue(state["ssh"])
        self.assertEqual(state["submissions"][0]["images"][0]["sha256"], hashlib.sha256(self.png).hexdigest())

    def test_pi_image_paste_and_submission_without_helpers_or_display(self):
        env = self.environment
        _, initial = self.start_pi()
        env.key("ctrl+v")
        staged = env.wait(lambda: (state if (state := env.result("state.json")) and "[#image " in state["draft"] else None))
        self.assertRegex(staged["draft"], r"^Explain this:  \[#image [a-f0-9]{8}\] $")
        self.assertEqual(staged["submissions"], [])
        self.assertEqual(staged["reads"], 2)
        self.assertEqual(staged["altExits"], initial["altExits"], "clipboard read must not stop the TUI")
        env.key("Return")
        submitted = env.wait(lambda: (state if (state := env.result("state.json")) and state["submissions"] else None))
        self.assertEqual(len(submitted["submissions"]), 1)
        images = submitted["submissions"][0]["images"]
        self.assertEqual(images, [{"mimeType": "image/png", "bytes": len(self.png), "sha256": hashlib.sha256(self.png).hexdigest()}])
        self.assertNotIn("5522", submitted["submissions"][0]["text"])

    def test_pi_slow_fragmented_replies_never_enter_the_editor(self):
        env = self.environment
        self.start_pi(fragmented=True)
        env.key("ctrl+v")
        staged = env.wait(lambda: (state if (state := env.result("state.json")) and "[#image " in state["draft"] else None))
        self.assertRegex(staged["draft"], r"^Explain this:  \[#image [a-f0-9]{8}\] $")
        self.assertGreater(env.result("fragment-state.json")["fragmentedFrames"], 10)
        env.key("Return")
        state = env.wait(lambda: (value if (value := env.result("state.json")) and value["submissions"] else None))
        self.assertEqual(state["submissions"][0]["images"][0]["sha256"], hashlib.sha256(self.png).hexdigest())

    def test_pi_permission_denial_keeps_draft_and_terminal_alive(self):
        env = self.environment
        process, initial = self.start_pi("write-clipboard")
        env.key("ctrl+v")
        env.wait(lambda: "denied" in env.screen().lower())
        state = env.result("state.json")
        self.assertEqual(state["draft"], initial["draft"])
        self.assertEqual(state["submissions"], [])
        self.assertEqual(state["altExits"], initial["altExits"])
        self.assertIsNone(process.poll())

    def test_pi_text_clipboard_and_normal_terminal_paste(self):
        env = self.environment
        env.clipboard("text/plain", b"plain text, not an image")
        _, initial = self.start_pi()
        env.key("ctrl+v")
        env.wait(lambda: "no supported image" in env.screen().lower())
        state = env.result("state.json")
        self.assertEqual(state["reads"], 1, "listing types must not request text data")
        self.assertEqual(state["draft"], initial["draft"])
        env.key("ctrl+shift+v")
        state = env.wait(lambda: (value if (value := env.result("state.json")) and "plain text" in value["draft"] else None))
        self.assertEqual(state["draft"], initial["draft"] + "plain text, not an image")
        self.assertEqual(state["submissions"], [])

    def test_pi_actual_permission_prompt_deny(self):
        env = self.environment
        _, initial = self.start_pi("read-clipboard-ask write-clipboard")
        env.key("ctrl+v")
        env.wait(lambda: "clipboard" in env.screen().lower() and "Allow" in env.screen())
        env.key("n")
        env.wait(lambda: "denied" in env.screen().lower())
        state = env.result("state.json")
        self.assertEqual(state["draft"], initial["draft"])
        self.assertEqual(state["submissions"], [])
        self.assertEqual(state["altExits"], initial["altExits"])

    def test_pi_actual_permission_prompt_allow(self):
        env = self.environment
        self.start_pi("read-clipboard-ask write-clipboard")
        env.key("ctrl+v")
        env.wait(lambda: "clipboard" in env.screen().lower() and "Allow" in env.screen())
        env.key("y")
        staged = env.wait(lambda: (state if (state := env.result("state.json")) and "[#image " in state["draft"] else None))
        self.assertEqual(staged["submissions"], [])
        self.assertEqual(staged["reads"], 2)

    def test_protocol_multichunk_png(self):
        process = self.probe()
        result = self.environment.wait(self.environment.result)
        self.assertEqual(result["statuses"][0], "OK")
        self.assertEqual(result["statuses"][-1], "DONE")
        self.assertGreater(result["statuses"].count("DATA"), 1)
        self.assertEqual(result["bytes"], len(self.png))
        self.assertEqual(result["sha256"], hashlib.sha256(self.png).hexdigest())
        self.assertEqual(process.wait(timeout=5), 0)

    def test_protocol_permission_denied(self):
        self.probe("write-clipboard")
        result = self.environment.wait(self.environment.result)
        self.assertEqual(result["statuses"], ["EPERM"])
        self.assertEqual(result["bytes"], 0)

    def test_protocol_permission_prompt_allow(self):
        self.probe("read-clipboard-ask write-clipboard")
        self.environment.wait(lambda: "clipboard" in self.environment.screen().lower())
        self.environment.key("y")
        result = self.environment.wait(self.environment.result)
        self.assertEqual(result["statuses"][-1], "DONE")
        self.assertEqual(result["sha256"], hashlib.sha256(self.png).hexdigest())


if __name__ == "__main__":
    for executable in ("Xvfb", "kitty", "kitten", "xclip", "xdotool", "node", "pi"):
        if not shutil.which(executable):
            raise SystemExit(f"Missing test dependency: {executable}; see docs/kitty-clipboard-testing.md")
    unittest.main(verbosity=2)
