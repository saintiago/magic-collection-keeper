"""Export the complete frozen catalog and model bytes; never owner's inventory."""

import gzip
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out = root.parent / "public/vendor/visual"
out.mkdir(parents=True, exist_ok=True)
manifest = json.loads((root / "artifact-manifest.json").read_text())
snapshot = (
    root
    / "artifacts/catalog/catalog-v2/snapshots/milo1--scryfall--mtg/metadata/version-27"
)
descriptor = json.loads((snapshot / "snapshot.json").read_text())
assert descriptor["rows"] == manifest["catalog"]["rows"]
assert descriptor["embedding"]["model"] == manifest["catalog"]["embedding"]
assets = {}


def save(key, raw, extension="bin"):
    digest = hashlib.sha256(raw).hexdigest()
    filename = f"{digest}.{extension}"
    (out / filename).write_bytes(raw)
    assets[key] = {"file": filename, "sha256": digest, "bytes": len(raw)}


for model, digest in manifest["models"].items():
    raw = (root / "artifacts/weights" / model).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == digest
    save(model.removesuffix(".onnx"), raw, "onnx")
for key in ("embeddings", "records"):
    entry = descriptor["assets"][key]
    raw = (snapshot / entry["filename"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == entry["sha256"]
    if key == "records":
        records = [json.loads(line) for line in gzip.decompress(raw).splitlines()]
        # Stable row order is the structural link to the complete embeddings.
        compact = [
            {
                "id": r["id"],
                "oracle_id": r["identifiers"].get("scryfall_oracle"),
                "name": r["name"],
                "finishes": r["finishes"],
                **{
                    k: (r.get("metadata") or {}).get(k)
                    for k in ("set", "collector_number", "lang")
                },
            }
            for r in records
        ]
        assert len(compact) == descriptor["rows"]
        raw = gzip.compress(
            json.dumps(compact, separators=(",", ":")).encode(), mtime=0
        )
    save(key, raw, "gz")
result = {
    "schema": 1,
    "upstream": manifest,
    "rows": descriptor["rows"],
    "dims": descriptor["embedding"]["dimensions"],
    "assets": assets,
}
(out / "manifest.json").write_text(json.dumps(result, indent=2) + "\n")
print(
    json.dumps(
        {
            "bytes": sum(a["bytes"] for a in assets.values()),
            "rows": result["rows"],
            "assets": assets,
        }
    )
)
