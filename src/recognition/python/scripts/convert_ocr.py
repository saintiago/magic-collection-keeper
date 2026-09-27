"""Build-only conversion of the original frozen weights; no runtime Paddle dependency."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import yaml

root = Path(__file__).resolve().parents[1]
artifacts = root / "artifacts"
output = artifacts / "ocr-onnx"
output.mkdir(exist_ok=True)
original = json.loads((root / "ocr-models.json").read_text())
for name, short in (
    ("PP-OCRv5_mobile_det", "det"),
    ("latin_PP-OCRv5_mobile_rec", "rec"),
):
    folder = artifacts / "ocr-models" / name
    for filename, digest in original[name].items():
        if hashlib.sha256((folder / filename).read_bytes()).hexdigest() != digest:
            raise ValueError("Original text model digest mismatch")
    subprocess.run(
        [
            sys.executable,
            "-m",
            "paddle2onnx.command",
            "--model_dir",
            str(folder),
            "--model_filename",
            "inference.json",
            "--params_filename",
            "inference.pdiparams",
            "--save_file",
            str(output / f"{short}.onnx"),
            "--opset_version",
            "17",
        ],
        check=True,
    )
characters = yaml.safe_load(
    (artifacts / "ocr-models/latin_PP-OCRv5_mobile_rec/inference.yml").read_text(
        encoding="utf-8"
    )
)["PostProcess"]["character_dict"]
(output / "latin.txt").write_text("\n".join(characters) + "\n", encoding="utf-8")
manifest = {
    "original": original,
    "converter": "paddle2onnx-2.1.0",
    "opset": 17,
    "files": {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(output.iterdir())
        if path.is_file()
    },
}
(artifacts / "ocr-onnx.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("Converted and hashed original frozen text weights.")
