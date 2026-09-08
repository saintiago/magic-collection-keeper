"""Assemble reviewable source without git history, credentials or collection data."""
import subprocess
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[2]
paths = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
# Application source is included conservatively alongside the covered service.
# This does not change repository visibility or assert HTTP separation decides licensing.
excluded = ('data/', '.local-secrets/', 'test-results/', 'public/vendor/')
with zipfile.ZipFile(root/'recognition/source.zip', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(paths):
        if not name or name.startswith(excluded) or name.endswith(('.png','.jpg','.jpeg','.zip')):
            continue
        path = root/name
        if path.is_file():
            archive.write(path, 'keeper/'+name)
    vendor = root/'recognition/vendor/CollectorVision'
    for path in sorted(vendor.rglob('*')):
        rel=path.relative_to(vendor)
        if path.is_file() and not any(x in ('.git','__pycache__','build','dist') or x.endswith('.egg-info') for x in rel.parts):
            archive.write(path, 'CollectorVision/'+rel.as_posix())
print('Prepared source.zip; public model/catalog fetch scripts and hashes included.')
