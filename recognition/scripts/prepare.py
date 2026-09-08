"""Fetch only public, frozen artifacts. SPDX-License-Identifier: AGPL-3.0-only"""
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen

root = Path(__file__).resolve().parents[1]
artifacts = root / 'artifacts'
artifacts.mkdir(exist_ok=True)
manifest = json.loads((root / 'artifact-manifest.json').read_text())
vendor = root / 'vendor' / 'CollectorVision'
if not vendor.exists():
    subprocess.run(['git', 'clone', 'https://github.com/HanClinto/CollectorVision.git', str(vendor)], check=True)
subprocess.run(['git', '-C', str(vendor), 'checkout', '--detach', manifest['code']], check=True)
subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', str(vendor)], check=True)

def fetch(url, path, digest):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
        return
    with urlopen(url, timeout=90) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Public artifact digest mismatch: ' + path.name)
    path.write_bytes(data)

for name, digest in manifest['models'].items():
    fetch(f'https://raw.githubusercontent.com/HanClinto/CollectorVision/{manifest["code"]}/collector_vision/weights/{name}', artifacts / 'weights' / name, digest)

revisions = {'PP-OCRv5_mobile_det': '0d63e78e2b680928f6b1747d76a08db6e645efb7', 'latin_PP-OCRv5_mobile_rec': 'ab2cd5cc5fa6309be2e5acdfe66eca2c2c127d57'}
for model, files in json.loads((root / 'ocr-models.json').read_text()).items():
    for filename, digest in files.items():
        fetch(f'https://huggingface.co/PaddlePaddle/{model}/resolve/{revisions[model]}/{filename}', artifacts / 'ocr-models' / model / filename, digest)

from collector_vision import CatalogV2Downloader
CatalogV2Downloader.install('mtg', version=manifest['catalog']['version'], cache_dir=artifacts / 'catalog', feed_url=(root / 'catalog-feed.json').as_uri())
for name in ('artifact-manifest.json', 'ocr-models.json'):
    shutil.copyfile(root / name, artifacts / name)
print('Frozen public models and catalog prepared.')
