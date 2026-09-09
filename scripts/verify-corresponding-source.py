"""Verify unchanged private runtime/build source without extracting the archive."""
from pathlib import Path
import subprocess
import sys
import zipfile

root = Path.cwd()
paths = subprocess.check_output(["git", "ls-tree", "-rz", "--name-only", "HEAD"], cwd=root).decode().split("\0")
def runtime_input(name):
    return bool(name) and name not in ("README.md", "AGENTS.md") and not name.startswith(("public/", "docs/", "tests/", "recognition/tests/"))
required = [name for name in paths if runtime_input(name)]
with zipfile.ZipFile(sys.argv[1]) as archive:
    import json
    previous = json.loads(archive.read("keeper/SOURCE_FILES.json"))
    if set(required) != {name for name in previous if runtime_input(name)}:
        raise ValueError("Backend/build source file set changed; publish matching source first")
    failures = [name for name in required if "keeper/" + name not in archive.namelist() or archive.read("keeper/" + name) != subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=root)]
if failures:
    raise ValueError("Publish matching recognition/backend source before this full release: " + ", ".join(failures[:12]))
print(f"Verified {len(required)} backend/runtime/build source files; frontend source is packaged separately")
