FROM public.ecr.aws/lambda/python:3.12@sha256:2710e8cf77565a70da6f65717645e417074bc15c9e3c2a11f236d5a5398183ba
WORKDIR /var/task
RUN dnf install -y mesa-libGL glib2 libgomp && dnf clean all
COPY requirements-linux.txt /tmp/requirements-linux.txt
RUN pip install --no-cache-dir -r /tmp/requirements-linux.txt
COPY vendor/CollectorVision /tmp/collectorvision
RUN pip install --no-cache-dir --no-deps /tmp/collectorvision && pip check
COPY *.py ./
COPY adapters ./adapters
COPY artifacts/weights ./artifacts/weights
COPY artifacts/catalog ./artifacts/catalog
COPY artifacts/ocr-onnx ./artifacts/ocr-onnx
COPY artifacts/artifact-manifest.json artifacts/ocr-onnx.json ./artifacts/
COPY artifacts/public-*-frame.jpg ./artifacts/
COPY notices ./notices
COPY LICENSE source.zip ./
COPY scripts/smoke.py ./smoke.py
ENV RECOGNITION_ARTIFACTS=/var/task/artifacts KEEPER_OCR_ADAPTER=paddle-onnx ORT_DISABLE_TELEMETRY=1 XDG_CACHE_HOME=/tmp/cache HF_HUB_OFFLINE=1 OMP_NUM_THREADS=2 OPENBLAS_NUM_THREADS=2 MKL_NUM_THREADS=2
ENTRYPOINT ["/lambda-entrypoint.sh"]
CMD ["lambda_entry.handler"]
