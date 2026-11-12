#!/usr/bin/env python3
"""Install pi-setup's display-only compact view into a supported upstream Pi runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile

HERE = Path(__file__).resolve().parent
STATE = ".pi-setup-compact-ui.json"
BACKUP = ".pre-compact-ui"


def sha256(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def shell_color_prefix():
    helper = (HERE.parent / "shell-colors/sgr.js").read_text(encoding="utf-8")
    return "// pi-shell-colors-v1\n" + helper.replace(
        "export function preserveShellColors", "function piPreserveShellColors") + "\n"


def canonical(relative, text):
    # The existing shell-color patch owns this prefix and the ANSI-preserving
    # call. Neither applying nor removing compact UI may undo that patch.
    if relative == "modes/interactive/components/bash-execution.js":
        prefix = shell_color_prefix()
        if text.startswith("// pi-shell-colors-v1\n"):
            if not text.startswith(prefix):
                raise ValueError("Unsupported shell-color helper; no runtime changes applied")
            text = text[len(prefix):]
        text = text.replace("piPreserveShellColors(chunk)", "stripAnsi(chunk)")
    return text


def package_dir(executable):
    path = Path(executable).resolve()
    for parent in path.parents:
        metadata = parent / "package.json"
        if metadata.is_file():
            data = json.loads(metadata.read_text(encoding="utf-8"))
            if data.get("name") == "@earendil-works/pi-coding-agent":
                return parent
    raise ValueError(f"Cannot locate the upstream Pi package for {executable}")


def atomic_write(path, content, mode):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(root, *, check=False, uninstall=False):
    manifest_text = (HERE / "runtime-patch.json").read_text(encoding="utf-8")
    manifest = json.loads(manifest_text)
    metadata = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if metadata.get("name") != manifest["packageName"] or metadata.get("version") != manifest["piVersion"]:
        raise ValueError(f"Compact activity supports upstream Pi {manifest['piVersion']}; "
                         f"found {metadata.get('name')} {metadata.get('version')}. "
                         "Update pi-setup's patch before installing; no runtime changes applied")
    dist = root / "dist"
    state_path = dist / STATE
    if state_path.is_symlink():
        raise ValueError(f"Refusing a symlinked patch-state file: {state_path}")
    previous_state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None
    if previous_state and previous_state.get("patchDigest") != sha256(manifest_text):
        raise ValueError("A different compact UI patch is installed; uninstall it before changing patch versions")

    changes = []
    originals = []
    created_assets = set(previous_state.get("createdAssets", [])) if previous_state else set()

    # Validate every asset and hunk before creating backups or changing files.
    # Assets precede code; the CLI entry point is the last code file changed.
    for asset in manifest["assets"]:
        content = None
        if not uninstall:
            content = (HERE / asset["source"]).read_text(encoding="utf-8")
            if sha256(content) != asset["sha256"]:
                raise ValueError(f"Invalid pi-setup asset: {asset['source']}")
        path = dist / asset["path"]
        if path.is_symlink():
            raise ValueError(f"Refusing a symlinked runtime asset: {path}")
        old = path.read_bytes() if path.exists() else None
        if old is not None and sha256(old.decode("utf-8")) != asset["sha256"]:
            raise ValueError(f"Refusing to overwrite an unrelated runtime asset: {path}")
        if uninstall:
            if asset["path"] in created_assets and old is not None:
                changes.append((path, old, None, stat.S_IMODE(path.stat().st_mode)))
        elif old is None:
            created_assets.add(asset["path"])
            changes.append((path, None, content.encode("utf-8"), 0o644))

    for entry in manifest["files"]:
        relative = entry["path"]
        path = dist / relative
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Unsupported Pi layout: missing or symlinked {path}")
        old = path.read_bytes()
        text = old.decode("utf-8")
        digest = sha256(canonical(relative, text))
        backup = path.with_name(path.name + BACKUP)
        if backup.is_symlink():
            raise ValueError(f"Refusing a symlinked original backup: {backup}")
        if uninstall:
            if digest == entry["originalSha256"]:
                continue
            if digest != entry["patchedSha256"] or not backup.is_file():
                raise ValueError(f"Cannot safely restore modified runtime or missing backup: {path}")
            restored = backup.read_bytes()
            if sha256(canonical(relative, restored.decode("utf-8"))) != entry["originalSha256"]:
                raise ValueError(f"Invalid original backup: {backup}")
            if relative == "modes/interactive/components/bash-execution.js":
                restored_text = canonical(relative, restored.decode("utf-8"))
                if text.startswith("// pi-shell-colors-v1\n"):
                    restored_text = shell_color_prefix() + restored_text.replace(
                        "stripAnsi(chunk)", "piPreserveShellColors(chunk)")
                restored = restored_text.encode("utf-8")
            changes.append((path, old, restored, stat.S_IMODE(path.stat().st_mode)))
            continue
        if digest == entry["patchedSha256"]:
            if not backup.is_file():
                raise ValueError(f"Patched runtime has no original backup: {path}")
            continue
        if digest != entry["originalSha256"]:
            raise ValueError(f"Unsupported or modified Pi runtime: {path}; no runtime changes applied")
        for replacement in entry["replacements"]:
            if text.count(replacement["before"]) != 1:
                raise ValueError(f"Expected one patch anchor in {path}; no runtime changes applied")
            text = text.replace(replacement["before"], replacement["after"], 1)
        if sha256(canonical(relative, text)) != entry["patchedSha256"]:
            raise ValueError(f"Patched checksum mismatch: {path}; no runtime changes applied")
        if backup.exists() and sha256(canonical(relative, backup.read_text(encoding="utf-8"))) != entry["originalSha256"]:
            raise ValueError(f"Refusing to overwrite a different original backup: {backup}")
        originals.append((path, backup, old))
        changes.append((path, old, text.encode("utf-8"), stat.S_IMODE(path.stat().st_mode)))

    if check:
        return not changes and previous_state is not None
    if uninstall and previous_state is None and not changes:
        return False
    if uninstall:
        # Restore the upstream entry first; it must not load a half-restored UI.
        changes.sort(key=lambda change: change[0] != dist / "bundle/cli.js")
        new_state = None
    else:
        new_state = (json.dumps({"patchDigest": sha256(manifest_text), "piVersion": manifest["piVersion"],
                                 "createdAssets": sorted(created_assets)}, indent=2) + "\n").encode("utf-8")
    old_state = state_path.read_bytes() if state_path.exists() else None
    if old_state != new_state:
        changes.append((state_path, old_state, new_state, 0o600))
    if not changes:
        return False

    for path, backup, content in originals:
        if not backup.exists():
            with backup.open("xb") as stream:
                stream.write(content)
            shutil.copystat(path, backup)
    written = []
    try:
        for path, before, after, mode in changes:
            current = path.read_bytes() if path.exists() else None
            if current != before:
                raise ValueError(f"Runtime changed during installation: {path}")
            if after is None:
                path.unlink()
            else:
                atomic_write(path, after, mode)
            written.append((path, before, mode))
    except Exception:
        for path, before, mode in reversed(written):
            if before is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, before, mode)
        raise
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", default=shutil.which("pi"), help="Upstream Pi executable (default: PATH)")
    parser.add_argument("--package-dir", type=Path, help="Explicit installed package directory for staging/tests")
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--check", action="store_true", help="Verify the installed patch without changing anything")
    operation.add_argument("--uninstall", action="store_true", help="Restore the original upstream runtime")
    args = parser.parse_args()
    try:
        if not args.package_dir and not args.pi:
            raise ValueError("Pi is not on PATH; install upstream Pi first")
        root = args.package_dir.resolve() if args.package_dir else package_dir(args.pi)
        changed = install(root, check=args.check, uninstall=args.uninstall)
        if args.check:
            print("Compact activity patch is installed" if changed else "Compact activity patch is not installed")
            return 0 if changed else 1
        action = "restored upstream runtime" if args.uninstall else "installed upstream runtime patch"
        print(f"Pi compact activity: {action if changed else 'already in the requested state'} ({root})")
        print("Restart Pi to load runtime changes; /reload does not replace the core.")
        return 0
    except (OSError, ValueError) as error:
        print(f"Pi compact activity: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
