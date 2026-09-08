FROM public.ecr.aws/lambda/python:3.12
WORKDIR /var/task
COPY requirements.in /tmp/requirements.in
RUN pip install --no-cache-dir -r /tmp/requirements.in
COPY vendor/CollectorVision /tmp/collectorvision
RUN pip install --no-cache-dir --no-deps /tmp/collectorvision && pip check
COPY *.py ./
COPY adapters ./adapters
COPY artifacts ./artifacts
COPY notices ./notices
COPY LICENSE source.zip ./
COPY scripts/smoke.py ./smoke.py
ENV RECOGNITION_ARTIFACTS=/var/task/artifacts PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True PADDLE_PDX_CACHE_HOME=/tmp/paddlex
CMD ["handler.handler"]
