"""CollectorVision model/catalog adapter. SPDX-License-Identifier: AGPL-3.0-only"""
import hashlib,json
import cv2,numpy as np
import collector_vision as cv

class CollectorVision:
    def __init__(self,root):
        manifest=json.loads((root/'artifact-manifest.json').read_text())
        weights=root/'weights'
        for name,sha in manifest['models'].items():
            if hashlib.sha256((weights/name).read_bytes()).hexdigest()!=sha:
                raise ValueError('Visual model digest mismatch')
        self.catalog=cv.Catalog.load('mtg',cache_dir=root/'catalog',offline=True)
        if self.catalog.version!=manifest['catalog']['version'] or self.catalog.embedding_model!=manifest['catalog']['embedding']:
            raise ValueError('Incompatible model/catalog version')
        self.detector=cv.NeuralCornerDetector(checkpoint=weights/'cornelius.onnx',provider='cpu',num_threads=2)
        self.embedder=cv.NeuralEmbedder(checkpoint=weights/'milo.onnx',provider='cpu',num_threads=2)
        self.version={'adapter':'collectorvision','code':manifest['code'],'models':manifest['models'],'catalog':manifest['catalog'],'calibration':'research-cosine-v1-not-approved'}
    def inspect(self,image):
        bgr=cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR)
        found=self.detector.detect(bgr)
        result={'identity_supported':False,'candidates':[],'confirmation_calibrated':False,'evidence':{'scoreKind':'cosine_similarity','isProbability':False,'calibration':self.version['calibration']}}
        if not found.card_present:return result
        h,w=bgr.shape[:2];pts=found.corners*np.array([w,h],dtype=np.float32)
        area=abs(cv2.contourArea(pts))/(w*h)
        if not .12<area<.98 or not cv2.isContourConvex(pts):return result
        matches=self.catalog.search_records(self.embedder.embed(found.dewarp(bgr)),top_k=5)
        if not matches:return result
        first=matches[0];identity=first['identifiers'].get('scryfall_oracle')
        other=next((x['score'] for x in matches[1:] if x['identifiers'].get('scryfall_oracle')!=identity),1)
        # These conservative research thresholds only admit optional candidates.
        result['identity_supported']=first['score']>=.8 and first['score']-other>=.08
        result['evidence'].update(topScore=first['score'],differentIdentityMargin=first['score']-other,sharpness=found.sharpness)
        result['corners']=found.corners
        result['candidates']=[{'id':x['id'],'oracle_id':x['identifiers'].get('scryfall_oracle'),'name':x['name'],'finishes':x['finishes'],**{k:(x.get('metadata') or {}).get(k) for k in ('set','collector_number','lang')}} for x in matches]
        return result
