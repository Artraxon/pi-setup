"""Installer regression tests using copies of the supported upstream runtime."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("compact_installer", HERE / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
MANIFEST = json.loads((HERE / "runtime-patch.json").read_text())


class CompactInstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        executable = os.environ.get("PI_COMPACT_TEST_BASE_PI") or shutil.which("pi")
        if not executable:
            raise RuntimeError("Install upstream Pi 1.5.2 before running runtime-patch tests")
        cls.upstream = installer.package_dir(executable)
        metadata = json.loads((cls.upstream / "package.json").read_text())
        if metadata["version"] != MANIFEST["piVersion"]:
            raise RuntimeError(f"Runtime-patch tests require upstream Pi {MANIFEST['piVersion']}")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pi-compact-install-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / "package.json").write_text(json.dumps({
            "name": MANIFEST["packageName"], "version": MANIFEST["piVersion"],
        }))
        self.originals = {}
        for entry in MANIFEST["files"]:
            relative = entry["path"]
            source = self.upstream / "dist" / relative
            backup = source.with_name(source.name + installer.BACKUP)
            # Tests still exercise clean upstream after the real install is patched.
            if backup.exists():
                source = backup
            destination = self.root / "dist" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            self.originals[relative] = destination.read_bytes()

    def snapshot(self):
        return {str(path.relative_to(self.root)): (path.read_bytes(), stat.S_IMODE(path.stat().st_mode))
                for path in self.root.rglob("*") if path.is_file()}

    def asset(self):
        return self.root / "dist" / MANIFEST["assets"][0]["path"]

    def assert_original_runtime(self):
        for relative, content in self.originals.items():
            self.assertEqual((self.root / "dist" / relative).read_bytes(), content, relative)
        self.assertFalse(self.asset().exists())
        self.assertFalse((self.root / "dist" / installer.STATE).exists())

    def test_installs_into_upstream_without_a_fork_or_build_step(self):
        self.assertFalse(installer.install(self.root, check=True))
        self.assertTrue(installer.install(self.root))
        self.assertTrue(installer.install(self.root, check=True))
        for entry in MANIFEST["files"]:
            path = self.root / "dist" / entry["path"]
            self.assertEqual(installer.sha256(installer.canonical(entry["path"], path.read_text())),
                             entry["patchedSha256"])
            self.assertEqual(path.with_name(path.name + installer.BACKUP).read_bytes(), self.originals[entry["path"]])
        entry = self.root / "dist/bundle/cli.js"
        self.assertIn('await import("../cli.js")', entry.read_text())
        self.assertEqual(stat.S_IMODE(entry.stat().st_mode), 0o755)
        self.assertNotIn("/workspaces/", entry.read_text())
        self.assertNotIn("/opt/", entry.read_text())
        self.assertTrue(self.asset().is_file())

    def test_repeated_install_does_not_rewrite_code_backups_or_state(self):
        installer.install(self.root)
        before = self.snapshot()
        self.assertFalse(installer.install(self.root))
        self.assertEqual(self.snapshot(), before)

    def test_unsupported_version_fails_without_changes(self):
        metadata = self.root / "package.json"
        metadata.write_text(json.dumps({"name": MANIFEST["packageName"], "version": "1.5.999"}))
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "supports upstream Pi"):
            installer.install(self.root)
        self.assertEqual(self.snapshot(), before)

    def test_modified_late_file_fails_before_any_earlier_file_or_asset_changes(self):
        path = self.root / "dist/core/extensions/index.d.ts"
        path.write_text(path.read_text() + "\n// unrelated local edit\n")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "modified Pi runtime"):
            installer.install(self.root)
        self.assertEqual(self.snapshot(), before)

    def test_unrelated_asset_is_not_overwritten(self):
        self.asset().write_text("unrelated local file")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "unrelated runtime asset"):
            installer.install(self.root)
        self.assertEqual(self.snapshot(), before)

    def test_uninstall_restores_original_runtime_and_retains_backups(self):
        installer.install(self.root)
        self.assertTrue(installer.install(self.root, uninstall=True))
        self.assert_original_runtime()
        for relative in self.originals:
            path = self.root / "dist" / relative
            self.assertTrue(path.with_name(path.name + installer.BACKUP).is_file())
        self.assertFalse(installer.install(self.root, uninstall=True))
        self.assertTrue(installer.install(self.root))

    def test_uninstall_uses_installed_asset_checksum_even_if_repository_asset_was_edited(self):
        installer.install(self.root)
        alternate = self.root / 'repo/extensions/compact-tools'
        alternate.mkdir(parents=True)
        shutil.copy2(HERE / 'runtime-patch.json', alternate / 'runtime-patch.json')
        (alternate / MANIFEST['assets'][0]['source']).write_text('// edited source for the next revision\n')
        shell_colors = alternate.parent / 'shell-colors'
        shell_colors.mkdir()
        shutil.copy2(HERE.parent / 'shell-colors/sgr.js', shell_colors / 'sgr.js')
        with patch.object(installer, 'HERE', alternate):
            self.assertTrue(installer.install(self.root, uninstall=True))
        self.assert_original_runtime()

    def test_uninstall_refuses_to_clobber_edits_after_installation(self):
        installer.install(self.root)
        path = self.root / "dist/modes/interactive/interactive-mode.js"
        path.write_text(path.read_text() + "\n// another customization\n")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "Cannot safely restore"):
            installer.install(self.root, uninstall=True)
        self.assertEqual(self.snapshot(), before)

    def test_missing_backup_is_not_silently_accepted(self):
        installer.install(self.root)
        entry = self.root / "dist/bundle/cli.js"
        entry.with_name(entry.name + installer.BACKUP).unlink()
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "no original backup"):
            installer.install(self.root)
        self.assertEqual(self.snapshot(), before)

    def test_write_failure_rolls_back_runtime_changes(self):
        original_write = installer.atomic_write
        calls = 0

        def failing_write(*args):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise OSError("simulated disk failure")
            return original_write(*args)

        with patch.object(installer, "atomic_write", side_effect=failing_write):
            with self.assertRaisesRegex(OSError, "simulated disk failure"):
                installer.install(self.root)
        self.assert_original_runtime()

    def test_works_with_plain_or_shell_color_patched_native_bash(self):
        relative = "modes/interactive/components/bash-execution.js"
        path = self.root / "dist" / relative
        original = path.read_text()
        installer.install(self.root)
        if original.startswith("// pi-shell-colors-v1"):
            self.assertTrue(path.read_text().startswith("// pi-shell-colors-v1"))
            self.assertIn("piPreserveShellColors(chunk)", path.read_text())
        installer.install(self.root, uninstall=True)
        plain = installer.canonical(relative, original)
        path.write_text(plain)
        self.originals[relative] = plain.encode()
        path.with_name(path.name + installer.BACKUP).unlink()
        installer.install(self.root)
        self.assertIn("stripAnsi(chunk)", path.read_text())
        installer.install(self.root, uninstall=True)
        self.assert_original_runtime()

    def test_shell_colors_added_after_compact_install_survive_uninstall_and_reinstall(self):
        relative = "modes/interactive/components/bash-execution.js"
        path = self.root / "dist" / relative
        plain_original = installer.canonical(relative, path.read_text())
        path.write_text(plain_original)
        installer.install(self.root)
        patched = path.read_text()
        path.write_text(installer.shell_color_prefix() + patched.replace(
            "stripAnsi(chunk)", "piPreserveShellColors(chunk)"))
        self.assertTrue(installer.install(self.root, check=True))
        installer.install(self.root, uninstall=True)
        expected = installer.shell_color_prefix() + plain_original.replace(
            "stripAnsi(chunk)", "piPreserveShellColors(chunk)")
        self.assertEqual(path.read_text(), expected)
        installer.install(self.root)
        installer.install(self.root, uninstall=True)
        self.assertEqual(path.read_text(), expected)

    def test_refuses_a_symlinked_runtime_file(self):
        path = self.root / "dist/modes/interactive/interactive-mode.js"
        other = self.root / "unrelated.js"
        other.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(other)
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "symlinked"):
            installer.install(self.root)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
