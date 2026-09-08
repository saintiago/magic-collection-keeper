"""Paddle text adapter; independently replaceable. SPDX-License-Identifier: AGPL-3.0-only"""
import hashlib,json
import cv2,numpy as np
from paddleocr import PaddleOCR

class PaddleText:
    def __init__(self,root):
        manifest=json.loads((root/'ocr-models.json').read_text())
        for name,files in manifest.items():
            for filename,digest in files.items():
                if hashlib.sha256((root/'ocr-models'/name/filename).read_bytes()).hexdigest()!=digest:
                    raise ValueError('Text model digest mismatch')
        self.model=PaddleOCR(text_detection_model_dir=str(root/'ocr-models/PP-OCRv5_mobile_det'),text_recognition_model_dir=str(root/'ocr-models/latin_PP-OCRv5_mobile_rec'),text_detection_model_name='PP-OCRv5_mobile_det',text_recognition_model_name='latin_PP-OCRv5_mobile_rec',use_doc_orientation_classify=False,use_doc_unwarping=False,use_textline_orientation=False,device='cpu',cpu_threads=2,enable_mkldnn=False)
        self.version={'adapter':'paddle','package':'3.7.0','weights':manifest,'calibration':'research-text-v1-not-approved'}
    def read(self,image,corners):
        bgr=cv2.cvtColor(np.asarray(image),cv2.COLOR_RGB2BGR);h,w=bgr.shape[:2]
        pts=np.asarray(corners,dtype=np.float32)*np.array([w,h],dtype=np.float32)
        dst=np.array([[0,0],[799,0],[799,1119],[0,1119]],dtype=np.float32)
        flat=cv2.warpPerspective(bgr,cv2.getPerspectiveTransform(pts,dst),(800,1120));regions=[]
        for a,b in ((.02,.12),(.92,1)):
            result=list(self.model.predict(flat[int(1120*a):int(1120*b),:]))[0]
            regions.append([text for text,score in zip(result['rec_texts'],result['rec_scores']) if score>=.8])
        return {'title':regions[0],'footer':regions[1],'confirmation_calibrated':False,'evidence':{'calibration':self.version['calibration'],'titleRead':bool(regions[0]),'footerRead':bool(regions[1])}}
