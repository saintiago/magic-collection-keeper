"""Package only tracked public source; backend source keeps authenticated access."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import zipfile

root = Path.cwd().resolve()
output = Path(sys.argv[1])
paths = subprocess.check_output(["git", "ls-tree", "-rz", "--name-only", "HEAD", "public/"], cwd=root).decode().split("\0")
commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip()
files = []
output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(filter(None, paths)):
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root / "public"):
            raise ValueError("Public source must stay inside its source tree")
        if name.startswith("public/vendor/") or name == "public/config.json":
            raise ValueError("Generated config/vendor files must not be tracked as public source")
        body = subprocess.check_output(["git", "show", f"HEAD:{name}"], cwd=root)
        archive.writestr("keeper/" + name, body)
        files.append({"path": name, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
    archive.writestr("frontend-source-manifest.json", json.dumps({"schema": 1, "commit": commit, "files": files}))
if not files or output.stat().st_size > 4_000_000:
    raise ValueError("Frontend source exceeds the bounded download size")
print(f"Prepared public source: {len(files)} files, {output.stat().st_size} bytes")
