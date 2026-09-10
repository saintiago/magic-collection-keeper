import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


class PublicFixtureTests(unittest.TestCase):
    def test_frozen_fixtures_and_exported_source_keep_exact_original_bytes(self):
        repo = Path(__file__).resolve().parents[2]
        sources = json.loads((repo / "tests/performance/sources.json").read_text())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            recognition = root / "recognition"
            (recognition / "scripts").mkdir(parents=True)
            (recognition / "fixtures").mkdir()
            (recognition / "artifacts").mkdir()
            (recognition / "artifacts/ocr-onnx.json").write_text("{}")
            (recognition / "LICENSE").write_text("Test licence fixture")
            script = recognition / "scripts/source_bundle.py"
            script.write_bytes((repo / "recognition/scripts/source_bundle.py").read_bytes())
            expected = {}
            for source in sources:
                name = "recognition/fixtures/" + source["key"] + ".jpg"
                data = (repo / name).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), source["sha256"])
                (root / name).write_bytes(data)
                expected["keeper/" + name] = data
            # Unrelated photos must not enter source even if a manifest lists them.
            (root / "private-photo.jpg").write_bytes(b"not a public fixture")
            (root / "SOURCE_FILES.json").write_text(json.dumps([
                name.removeprefix("keeper/") for name in expected
            ] + ["private-photo.jpg"]))
            subprocess.run([sys.executable, str(script)], check=True, capture_output=True)
            with zipfile.ZipFile(recognition / "source.zip") as archive:
                self.assertNotIn("keeper/private-photo.jpg", archive.namelist())
                for name, data in expected.items():
                    self.assertEqual(archive.read(name), data)


if __name__ == "__main__":
    unittest.main()
