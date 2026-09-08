"""API Gateway HTTP API adapter, isolated evaluation deployment only."""
import base64, binascii, io, json, threading
from pathlib import Path
from PIL import Image, UnidentifiedImageError

MAX_BYTES=524288
MAX_PIXELS=4000000
_lock=threading.Lock()
_engine=None

def response(code,data):
    return {'statusCode':code,'headers':{'content-type':'application/json','cache-control':'no-store'},'body':json.dumps(data)}

def handle(event, engine):
    # Only trusted API Gateway authorizer context is accepted, never a body owner.
    owner=event.get('requestContext',{}).get('authorizer',{}).get('jwt',{}).get('claims',{}).get('sub')
    if not isinstance(owner,str) or not owner:
        return response(401,{'error':'Sign in to scan'})
    if event.get('isBase64Encoded') or not isinstance(event.get('body'),str) or len(event['body'])>710000:
        return response(413,{'error':'Image request too large'})
    try:
        payload=json.loads(event['body'])
        if not isinstance(payload,dict) or set(payload)-{'image','attempt'} or not isinstance(payload.get('image'),str):
            return response(400,{'error':'Invalid image request'})
        if not isinstance(payload.get('attempt'),int) or isinstance(payload['attempt'],bool) or not 1<=payload['attempt']<=100000:
            return response(400,{'error':'Invalid attempt'})
        raw=base64.b64decode(payload['image'],validate=True)
        if not raw or len(raw)>MAX_BYTES:
            return response(413,{'error':'Image request too large'})
        with Image.open(io.BytesIO(raw)) as image:
            if image.format not in ('JPEG','PNG') or image.width*image.height>MAX_PIXELS or min(image.size)<100:
                return response(400,{'error':'Unsupported image dimensions or format'})
            image.load()
            rgb=image.convert('RGB')
    except (ValueError,TypeError,KeyError,binascii.Error,UnidentifiedImageError,OSError,Image.DecompressionBombError):
        return response(400,{'error':'Invalid image'})
    if not _lock.acquire(blocking=False):
        rgb.close()
        return response(429,{'error':'Scanner busy. Retry this card'})
    try:
        result=engine.recognize(rgb)
        return response(200,{'attempt':payload['attempt'],**result})
    except Exception:
        # No pixels, raw OCR, tokens or provider exceptions in logs/responses.
        return response(503,{'error':'Recognition unavailable. Retry this card'})
    finally:
        rgb.close()
        _lock.release()

def handler(event,context):
    global _engine
    if not event.get('requestContext',{}).get('authorizer',{}).get('jwt',{}).get('claims',{}).get('sub'):
        return response(401,{'error':'Sign in to scan'})
    if event.get('routeKey') == 'GET /api/recognition/source':
        try:
            source=Path(__file__).with_name('source.zip').read_bytes()
            return {'statusCode':200,'headers':{'content-type':'application/zip','content-disposition':'attachment; filename="keeper-recognition-source.zip"','cache-control':'no-store'},'isBase64Encoded':True,'body':base64.b64encode(source).decode()}
        except OSError:
            return response(503,{'error':'Recognition source download unavailable'})
    if _engine is None:
        try:
            from composition import create_service
            _engine=create_service()
        except Exception:
            return response(503,{'error':'Recognition unavailable'})
    return handle(event,_engine)
