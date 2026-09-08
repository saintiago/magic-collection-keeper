"""Offline runtime smoke; not an accuracy or physical-device test."""
import json
import resource
import socket
import time
from PIL import Image
import numpy as np

def denied(*args, **kwargs):
    raise RuntimeError('Runtime network access forbidden in smoke test')
socket.socket.connect = denied
started = time.perf_counter()
from composition import create_service
service = create_service()
initialized = time.perf_counter()
results = []
for _ in range(3):
    result = service.recognize(Image.new('RGB', (600, 800), 'white'))
    assert result['status'] == 'unknown' and result['selected'] is None
    assert result['reason'] != 'visual_unavailable', result
    results.append(result['timings'])
text_started=time.perf_counter()
text=service.ocr.read(Image.new('RGB',(600,800),'white'),np.array([[0,0],[1,0],[1,1],[0,1]],dtype=np.float32))
assert isinstance(text['title'],list) and isinstance(text['footer'],list)
print(json.dumps({'ocrBlankRegionsMs':(time.perf_counter()-text_started)*1000}))
print(json.dumps({'initializationMs': (initialized-started)*1000, 'blankFrameTimings': results, 'maxRssKiB': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, 'physicalDeviceVerified': False}))
