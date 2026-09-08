"""Concrete composition, selected only by service configuration. SPDX-License-Identifier: AGPL-3.0-only"""
import os
from pathlib import Path
from service import RecognitionService

def create_service():
    visual_name=os.environ.get('KEEPER_VISUAL_ADAPTER','collectorvision')
    ocr_name=os.environ.get('KEEPER_OCR_ADAPTER','paddle')
    if visual_name!='collectorvision' or ocr_name!='paddle':
        raise ValueError('Unsupported recognition adapter configuration')
    from adapters.collectorvision import CollectorVision
    from adapters.paddle import PaddleText
    root=Path(os.environ.get('RECOGNITION_ARTIFACTS','recognition/artifacts'))
    # Confirmations deliberately unavailable in the deployment composition.
    return RecognitionService(CollectorVision(root),PaddleText(root),allow_confirmed=False)
