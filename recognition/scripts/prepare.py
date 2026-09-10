"""Fetch only public, frozen artifacts. SPDX-License-Identifier: AGPL-3.0-only"""

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import Request, urlopen

root = Path(__file__).resolve().parents[1]
artifacts = root / "artifacts"
artifacts.mkdir(exist_ok=True)
manifest = json.loads((root / "artifact-manifest.json").read_text())
visual_only = "--visual-only" in sys.argv
vendor = root / "vendor" / "CollectorVision"
if not vendor.exists():
    subprocess.run(
        [
            "git",
            "clone",
            "https://github.com/HanClinto/CollectorVision.git",
            str(vendor),
        ],
        check=True,
    )
subprocess.run(
    ["git", "-C", str(vendor), "checkout", "--detach", manifest["code"]], check=True
)
subprocess.run(
    [sys.executable, "-m", "pip", "install", "--no-deps", str(vendor)], check=True
)


def fetch(url, path, digest):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
        return
    request = Request(
        url,
        headers={
            "User-Agent": "MagicCollectionKeeper/0.1 (+https://github.com/saintiago/magic-collection-keeper)"
        },
    )
    with urlopen(request, timeout=90) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Public artifact digest mismatch: " + path.name)
    path.write_bytes(data)


for name, digest in manifest["models"].items():
    fetch(
        f'https://raw.githubusercontent.com/HanClinto/CollectorVision/{manifest["code"]}/collector_vision/weights/{name}',
        artifacts / "weights" / name,
        digest,
    )

revisions = {
    "PP-OCRv5_mobile_det": "0d63e78e2b680928f6b1747d76a08db6e645efb7",
    "latin_PP-OCRv5_mobile_rec": "ab2cd5cc5fa6309be2e5acdfe66eca2c2c127d57",
}
for model, files in json.loads((root / "ocr-models.json").read_text()).items():
    if visual_only:
        continue
    for filename, digest in files.items():
        fetch(
            f"https://huggingface.co/PaddlePaddle/{model}/resolve/{revisions[model]}/{filename}",
            artifacts / "ocr-models" / model / filename,
            digest,
        )

from collector_vision import CatalogV2Downloader

CatalogV2Downloader.install(
    "mtg",
    version=manifest["catalog"]["version"],
    cache_dir=artifacts / "catalog",
    feed_url=(root / "catalog-feed.json").as_uri(),
)
for name in ("artifact-manifest.json", "ocr-models.json"):
    shutil.copyfile(root / name, artifacts / name)
print("Frozen public models and catalog prepared.")
# Exact public artwork is checked in so provider downtime cannot invalidate
# an otherwise reproducible model build. The original digest remains enforced.
fetch(
    (root / "fixtures/adaptive.jpg").as_uri(),
    artifacts / "public-card.jpg",
    "03a53910a88381e2e1e3320d8039b7cc25527c9b4caa1a9f16743b44421c04c4",
)
from PIL import Image, ImageOps

with Image.open(artifacts / "public-card.jpg") as card:
    card = ImageOps.contain(card.convert("RGB"), (480, 670))
    frame = Image.new("RGB", (700, 980), (28, 60, 40))
    frame.paste(card, ((700 - card.width) // 2, (980 - card.height) // 2))
    frame.save(artifacts / "public-card-frame.jpg", quality=88)

if visual_only:
    subprocess.run(
        [sys.executable, str(root / "scripts/browser_assets.py")], check=True
    )
    sys.exit(0)

names = json.loads((root / "name-catalog.json").read_text())
fetch(names["url"], artifacts / "title-names.json.gz", names["sha256"])
shutil.copyfile(root / "name-catalog.json", artifacts / "name-catalog.json")


for source in json.loads((root.parent / "tests/performance/sources.json").read_text()):
    if source["key"] not in ("bolt", "ring"):
        continue
    path = artifacts / ("public-" + source["key"] + ".jpg")
    fetch((root / "fixtures" / (source["key"] + ".jpg")).as_uri(), path, source["sha256"])
    with Image.open(path) as card:
        card = ImageOps.contain(card.convert("RGB"), (480, 670))
        frame = Image.new("RGB", (700, 980), (28, 60, 40))
        frame.paste(card, ((700 - card.width) // 2, (980 - card.height) // 2))
        frame.save(artifacts / ("public-" + source["key"] + "-frame.jpg"), quality=88)
