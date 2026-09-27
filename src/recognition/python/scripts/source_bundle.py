"""Assemble reviewable source without git history, credentials or collection data."""

import subprocess
import json
import hashlib
import zipfile
from pathlib import Path

package = Path(__file__).resolve().parents[1]
root = next(
    (
        parent
        for parent in package.parents
        if (parent / ".git").exists() or (parent / "SOURCE_FILES.json").is_file()
    ),
    package.parent,
)
prefix = package.relative_to(root).as_posix()
if (root / ".git").exists():
    paths = (
        subprocess.check_output(
            ["git", "ls-files", "-z"], cwd=root, stderr=subprocess.DEVNULL
        )
        .decode()
        .split("\0")
    )
else:
    paths = json.loads((root / "SOURCE_FILES.json").read_text())
# Application source is included conservatively alongside the covered service.
# This does not change repository visibility or assert HTTP separation decides licensing.
excluded = ("data/", ".local-secrets/", "test-results/", "public/vendor/")
public_fixtures = {
    f"{prefix}/fixtures/adaptive.jpg",
    f"{prefix}/fixtures/bolt.jpg",
    f"{prefix}/fixtures/ring.jpg",
}
with zipfile.ZipFile(
    package / "source.zip", "w", zipfile.ZIP_DEFLATED
) as archive:
    for name in sorted(paths):
        if (
            not name
            or name.startswith(excluded)
            or (name.endswith((".png", ".jpg", ".jpeg", ".zip")) and name not in public_fixtures)
        ):
            continue
        path = root / name
        if path.is_file():
            archive.write(path, "keeper/" + name)
    vendor = package / "vendor/CollectorVision"
    upstream = json.loads((package / "artifact-manifest.json").read_text())["code"]
    documentation_media = []
    for path in sorted(vendor.rglob("*")):
        rel = path.relative_to(vendor)
        if (
            path.is_file()
            and path.suffix != ".onnx"
            and not any(
                x in (".git", "__pycache__", "build", "dist") or x.endswith(".egg-info")
                for x in rel.parts
            )
        ):
            if rel.parts[0] == "docs" and path.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp", ".gif"):
                documentation_media.append({
                    "path": rel.as_posix(),
                    "url": f"https://raw.githubusercontent.com/HanClinto/CollectorVision/{upstream}/{rel.as_posix()}",
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                })
            else:
                archive.write(path, "CollectorVision/" + rel.as_posix())
    archive.writestr("CollectorVision/DOCUMENTATION_MEDIA.json", json.dumps(documentation_media, indent=2))
    archive.write(package / "LICENSE", "COPYING")
    archive.write(
        package / "artifacts/ocr-onnx.json",
        f"keeper/{prefix}-verified-ocr-onnx.json",
    )
    archive.writestr(
        "keeper/SOURCE_FILES.json",
        json.dumps([name for name in paths if name and not name.startswith(excluded)]),
    )
if (package / "source.zip").stat().st_size > 4_000_000:
    raise ValueError("Source bundle exceeds bounded API download size")
print("Prepared source.zip; public model/catalog fetch scripts and hashes included.")
