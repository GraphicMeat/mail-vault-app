#!/usr/bin/env python3
"""Use the signed app's background resource instead of a root .background folder.

create-dmg parks its background folder outside the window, creating scrollbars
when Finder displays it. Keep its normal packaging flow, but point Finder at
the resource Tauri embeds before signing. Never modify the signed application.
"""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    arguments = sys.argv[1:]
    app = Path(arguments[-1]).resolve()
    resource = app / "Contents/Resources/dmg-background.png"
    background = Path(arguments[arguments.index("--background") + 1]).resolve()
    if not resource.is_file() or resource.read_bytes() != background.read_bytes():
        raise SystemExit("Rebuild the app: its bundled DMG background is missing or outdated.")
    executable = shutil.which("create-dmg")
    if not executable:
        raise SystemExit("create-dmg is required.")
    executable = Path(executable).resolve()
    support = executable.parent / "support"
    if not support.is_dir():
        support = executable.parent.parent / "share/create-dmg/support"
    if not support.is_dir():
        raise SystemExit("Cannot locate create-dmg support files.")
    source = executable.read_text()
    old_alias = r'.background:$BACKGROUND_FILE_NAME'
    new_alias = f'{app.name}:Contents:Resources:dmg-background.png'
    copy_block = '\t[[ -d "$MOUNT_DIR/.background" ]] || mkdir "$MOUNT_DIR/.background"\n\tcp "$BACKGROUND_FILE" "$MOUNT_DIR/.background/$BACKGROUND_FILE_NAME"'
    if source.count(old_alias) != 1 or source.count(copy_block) != 1:
        raise SystemExit("Unsupported create-dmg version: review its background handling.")
    source = source.replace(old_alias, new_alias).replace(copy_block, ': # Background already lives in the signed app bundle.')
    with tempfile.TemporaryDirectory(prefix="mailvault-create-dmg-") as temporary:
        root = Path(temporary)
        (root / ".this-is-the-create-dmg-repo").touch()
        (root / "support").symlink_to(support, target_is_directory=True)
        patched = root / "create-dmg"
        patched.write_text(source)
        subprocess.run(["bash", str(patched), *arguments], check=True)


if __name__ == "__main__":
    main()
