#!/usr/bin/env python3
"""Migrate legacy Kotlin jvmTarget syntax used by generated Android projects."""

from pathlib import Path
import re
import sys


IMPORT = "import org.jetbrains.kotlin.gradle.dsl.JvmTarget"

# Kotlin 2.3 rejects the old kotlinOptions/jvmTarget String DSL. Tauri's
# generated app and its own cached Android module do not use identical
# whitespace/indentation, so match the block structurally rather than relying
# on one exact generated spelling.
LEGACY_BLOCK = re.compile(
    r"(?P<indent>^[ \t]*)kotlinOptions\s*\{\s*"
    r"jvmTarget\s*=\s*[\"']1\.8[\"']\s*"
    r"\}",
    re.MULTILINE,
)


def patch(path: Path) -> bool:
    text = path.read_text()
    if not LEGACY_BLOCK.search(text):
        return False

    if IMPORT not in text:
        text = text.replace("plugins {", IMPORT + "\n\nplugins {", 1)

    def modern(match: re.Match[str]) -> str:
        indent = match.group("indent")
        return (
            f"{indent}kotlin {{\n"
            f"{indent}    compilerOptions {{\n"
            f"{indent}        jvmTarget.set(JvmTarget.JVM_1_8)\n"
            f"{indent}    }}\n"
            f"{indent}}}"
        )

    updated, count = LEGACY_BLOCK.subn(modern, text)
    if count:
        path.write_text(updated)
        return True
    return False


if len(sys.argv) < 2:
    raise SystemExit("usage: ensure_android_gradle.py GRADLE_FILE [...]")

for raw_path in sys.argv[1:]:
    path = Path(raw_path)
    if path.is_file() and patch(path):
        print(f"patched Kotlin compilerOptions: {path}")
