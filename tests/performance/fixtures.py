"""Deterministic synthetic public-art frames, never physical-device evidence."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFilter, ImageOps

parser=argparse.ArgumentParser()
parser.add_argument("directory", type=Path)
args=parser.parse_args()
root=args.directory
sources=json.loads((root/"sources.json").read_text())
out=root/"frames"
out.mkdir(exist_ok=True)
cases=[]


def save(key,image,kind,oracle=None,printing=None,quality=88):
    file=out/(key+".jpg")
    image.convert("RGB").save(file,quality=quality)
    cases.append({"key":key,"file":file.name,"kind":kind,"oracle":oracle,"printing":printing,"sha256":hashlib.sha256(file.read_bytes()).hexdigest()})


frames=[]
for source in sources:
    raw=(root/(source["key"]+".jpg")).read_bytes()
    assert hashlib.sha256(raw).hexdigest()==source["sha256"]
    card=ImageOps.contain(Image.open(io.BytesIO(raw)).convert("RGB"),(480,670))
    frame=Image.new("RGB",(700,980),(28,60,40))
    left,top=(700-card.width)//2,(980-card.height)//2
    frame.paste(card,(left,top));frames.append(card)
    variants={"clean":frame,"blur":frame.filter(ImageFilter.GaussianBlur(1.6)),"small":frame.resize((280,392)).resize((700,980)),"jpeg":frame}
    pts=np.float32([[left,top],[left+card.width,top],[left+card.width,top+card.height],[left,top+card.height]])
    target=np.float32([[left+55,top+20],[left+card.width-10,top+70],[left+card.width+25,top+card.height-20],[left-25,top+card.height+15]])
    variants["perspective"]=Image.fromarray(cv2.warpPerspective(np.asarray(frame),cv2.getPerspectiveTransform(pts,target),(700,980),borderValue=(28,60,40)))
    overlay=Image.new("RGBA",frame.size)
    ImageDraw.Draw(overlay).ellipse((left+85,top+75,left+360,top+420),fill=(255,255,255,145))
    variants["glare"]=Image.alpha_composite(frame.convert("RGBA"),overlay.filter(ImageFilter.GaussianBlur(28))).convert("RGB")
    for variant,image in variants.items():
        save(source["key"]+"-"+variant,image,"positive",source["oracle_id"],source["id"],25 if variant=="jpeg" else 88)
    hidden=frame.copy()
    ImageDraw.Draw(hidden).rectangle((left,top+int(card.height*.88),left+card.width,top+card.height),fill=(35,35,35))
    save(source["key"]+"-footer-hidden",hidden,"ambiguous-printing",source["oracle_id"])
save("blank",Image.new("RGB",(700,980),(28,60,40)),"negative")
rng=np.random.default_rng(282)
save("noise",Image.fromarray(rng.integers(40,210,(980,700,3),dtype=np.uint8)),"negative",quality=60)
two=Image.new("RGB",(1000,800),(28,60,40))
for index,card in enumerate(frames[:2]): two.paste(ImageOps.contain(card,(400,600)),(50+index*480,100))
save("two-cards",two,"ambiguous-scene")
(root/"fixtures.json").write_text(json.dumps({"schema":1,"physicalDeviceVerified":False,"sources":sources,"cases":cases},indent=2))
print(json.dumps({"cases":len(cases),"positive":18,"ambiguous":4,"negative":2,"physicalDeviceVerified":False}))
