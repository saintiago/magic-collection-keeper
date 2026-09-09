"""Local regression using only the explicit public-art manifest; never camera uploads."""
import argparse, hashlib, io, json, os, sys, time
from pathlib import Path
from urllib.request import Request, urlopen
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from PIL import Image, ImageOps, ImageEnhance, ImageFilter
import numpy as np
from adapters.collectorvision import CollectorVision
from adapters.paddle_onnx import PaddleOnnxText
from adapters.title_names import load_title_names
from service import RecognitionService

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sources = json.loads((root.parent / "tests/performance/phone-sources.json").read_text())
    artifacts = root / "artifacts"
    service = RecognitionService(CollectorVision(artifacts), PaddleOnnxText(artifacts), names=load_title_names(artifacts))
    results = []
    def replay(key, image, oracle):
        result = service.recognize(image)
        top = (result.get("candidates") or [{}])[0]
        results.append({"key": key, "oracle": oracle, "status": result["status"], "correct": result["status"] == "possible" and top.get("oracle_id") == oracle, "wrong": result["status"] == "possible" and top.get("oracle_id") != oracle, "timings": result["timings"], "evidence": result["evidence"]})
    for source in sources:
        path = args.output / (source["key"] + ".jpg")
        if not path.exists():
            time.sleep(.65)
            request = Request(source["url"], headers={"User-Agent": "MagicCollectionKeeper/0.1 (public regression)", "Accept": "image/jpeg"})
            with urlopen(request, timeout=30) as response: path.write_bytes(response.read())
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != source["sha256"]: raise ValueError("Public fixture digest mismatch")
        crop = ImageOps.contain(Image.open(io.BytesIO(raw)).convert("RGB"), (420, 600))
        frame = Image.new("RGB", (588, 824), (28, 60, 40))
        frame.paste(crop, ((588-crop.width)//2, (824-crop.height)//2))
        cast = Image.fromarray(np.clip(np.asarray(frame).astype(float) * np.array([.62, 1.04, .82]), 0, 255).astype("uint8"))
        variants = {"clean": frame, "green-cast": cast, "dark": ImageEnhance.Brightness(frame).enhance(.42), "bright": ImageEnhance.Brightness(frame).enhance(1.55), "small": frame.resize((230,323)).resize(frame.size), "blur": frame.filter(ImageFilter.GaussianBlur(1.8))}
        for variant, image in variants.items(): replay(source["key"]+"-"+variant, image, source["oracle_id"])
    replay("blank", Image.new("RGB", (588,824), (28,60,40)), None)
    replay("noise", Image.fromarray(np.random.default_rng(282).integers(20,240,(824,588,3),dtype=np.uint8)), None)
    report = {"physicalDeviceVerified": False, "sources": len(sources), "runs": results}
    (args.output / "public-results.json").write_text(json.dumps(report, indent=2))
    print(json.dumps({"reads":len(results), "correct":sum(r["correct"] for r in results), "wrong":sum(r["wrong"] for r in results)}))
if __name__ == "__main__": main()
