"""Content-free, bounded transport/adapter timing. No request data is accepted."""

import json
import re
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from time import perf_counter

PROCESS_ID = uuid.uuid4().hex
started = perf_counter()
current = ContextVar("recognition_timing", default=None)
request_id_context = ContextVar("recognition_request_id", default=None)
STAGES = frozenset(
    (
        "import.numpy",
        "import.cv2",
        "import.onnxruntime",
        "import.collector_vision",
        "import.rapidocr",
        "import.visual_adapter",
        "import.ocr_adapter",
        "imports.total",
        "prepare.total",
        "visual.files",
        "visual.catalog",
        "visual.detector_session",
        "visual.embedder_session",
        "ocr.files",
        "ocr.detector_session",
        "ocr.recognizer_session",
        "image.decode",
        "recognize.total",
        "visual.preprocess",
        "visual.detect",
        "visual.detect_inference",
        "visual.geometry",
        "visual.card_regions",
        "visual.dewarp",
        "visual.embed",
        "visual.embed_inference",
        "visual.search",
        "visual.result",
        "ocr.preprocess",
        "ocr.detect",
        "ocr.detect_inference",
        "ocr.detect_postprocess",
        "ocr.crops",
        "ocr.recognize",
        "ocr.recognize_preprocess",
        "ocr.recognize_inference",
        "ocr.recognize_postprocess",
        "ocr.result",
    )
)


def emit(**fields):
    print(
        json.dumps(
            {
                "recognitionTiming": {
                    "schema": 1,
                    "processId": PROCESS_ID,
                    "processAgeMs": round((perf_counter() - started) * 1000, 3),
                    **fields,
                }
            }
        ),
        flush=True,
    )


@contextmanager
def stage(name):
    if name not in STAGES:
        raise ValueError("Unregistered timing stage")
    record = current.get()
    began = perf_counter()
    startup = (
        record is None
        or name.startswith(("import", "prepare"))
        or name.endswith((".files", ".catalog", "_session"))
    )
    if startup:
        emit(event="stage-start", stage=name, requestId=request_id_context.get())
    ok = False
    try:
        yield
        ok = True
    finally:
        elapsed = (perf_counter() - began) * 1000
        if record is not None:
            item = record.setdefault(name, {"ms": 0, "calls": 0, "ok": True})
            item.update(
                ms=round(item["ms"] + elapsed, 3),
                calls=item["calls"] + 1,
                ok=item["ok"] and ok,
            )
        if startup:
            emit(
                event="stage-end",
                stage=name,
                elapsedMs=round(elapsed, 3),
                ok=ok,
                requestId=request_id_context.get(),
            )


def measured(name, fn, *args, **kwargs):
    with stage(name):
        return fn(*args, **kwargs)


class TimedCallable:
    """Instrument the pinned provider's session without changing its contract."""

    def __init__(self, target, name):
        self.target, self.name = target, name

    def __call__(self, *args, **kwargs):
        return measured(self.name, self.target, *args, **kwargs)

    def run(self, *args, **kwargs):
        return measured(self.name, self.target.run, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self.target, name)


@contextmanager
def request(request_id=None, models_ready=False):
    safe_id = (
        request_id
        if isinstance(request_id, str) and re.fullmatch(r"[0-9a-f-]{36}", request_id)
        else None
    )
    began = perf_counter()
    record = {}
    token = current.set(record)
    id_token = request_id_context.set(safe_id)
    emit(event="request-start", requestId=safe_id, modelsReady=bool(models_ready))
    try:
        yield
    finally:
        emit(
            event="request-end",
            requestId=safe_id,
            elapsedMs=round((perf_counter() - began) * 1000, 3),
            stages=record,
        )
        current.reset(token)
        request_id_context.reset(id_token)
