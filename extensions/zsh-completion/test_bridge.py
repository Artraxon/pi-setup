import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).with_name("bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.old_zdotdir = os.environ.get("ZDOTDIR")
        os.environ["ZDOTDIR"] = self.directory.name
        self.addCleanup(self.restore_env)
        Path(self.directory.name, ".zshrc").write_text(
            "autoload -Uz compinit; compinit -i -d $ZDOTDIR/.zcompdump\n"
            "_pi_test() { compadd alpha beta; }; compdef _pi_test pi-test\n"
            "alias pt=pi-test\n"
        )

    def restore_env(self):
        if self.old_zdotdir is None:
            os.environ.pop("ZDOTDIR", None)
        else:
            os.environ["ZDOTDIR"] = self.old_zdotdir

    def complete(self, text):
        return bridge.complete(dict(buffer=text, cursor=len(text), cwd=self.directory.name))

    def test_user_completion_and_alias(self):
        self.assertIn("pi-test alpha", self.complete("pi-test a"))
        self.assertIn("pt alpha", self.complete("pt a"))

    def test_paths_and_spaces(self):
        Path(self.directory.name, "hello world").touch()
        Path(self.directory.name, "nested").mkdir()
        Path(self.directory.name, "nested", "sample").touch()
        self.assertIn("cat hello\\ world", self.complete("cat hel"))
        self.assertIn("cat nested/sample", self.complete("cat nested/sa"))

    def test_does_not_submit_command(self):
        self.complete("touch NEVER_EXECUTED")
        self.assertFalse(Path(self.directory.name, "NEVER_EXECUTED").exists())


if __name__ == "__main__":
    unittest.main()
