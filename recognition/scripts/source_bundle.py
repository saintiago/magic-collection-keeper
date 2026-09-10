"""Assemble reviewable source without git history, credentials or collection data."""

import subprocess
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
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
    "recognition/fixtures/adaptive.jpg",
    "recognition/fixtures/bolt.jpg",
    "recognition/fixtures/ring.jpg",
}
with zipfile.ZipFile(
    root / "recognition/source.zip", "w", zipfile.ZIP_DEFLATED
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
    vendor = root / "recognition/vendor/CollectorVision"
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
            archive.write(path, "CollectorVision/" + rel.as_posix())
    archive.write(root / "recognition/LICENSE", "COPYING")
    archive.write(
        root / "recognition/artifacts/ocr-onnx.json",
        "keeper/recognition/verified-ocr-onnx.json",
    )
    archive.writestr(
        "keeper/SOURCE_FILES.json",
        json.dumps([name for name in paths if name and not name.startswith(excluded)]),
    )
if (root / "recognition/source.zip").stat().st_size > 4_000_000:
    raise ValueError("Source bundle exceeds bounded API download size")
print("Prepared source.zip; public model/catalog fetch scripts and hashes included.")
