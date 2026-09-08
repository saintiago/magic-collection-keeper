FROM public.ecr.aws/lambda/python:3.12@sha256:2710e8cf77565a70da6f65717645e417074bc15c9e3c2a11f236d5a5398183ba
WORKDIR /var/task
RUN dnf install -y mesa-libGL glib2 libgomp && dnf clean all
COPY requirements-linux.txt /tmp/requirements-linux.txt
RUN pip install --no-cache-dir -r /tmp/requirements-linux.txt
COPY vendor/CollectorVision /tmp/collectorvision
RUN pip install --no-cache-dir --no-deps /tmp/collectorvision && pip check
COPY *.py ./
COPY adapters ./adapters
COPY artifacts ./artifacts
COPY notices ./notices
COPY LICENSE source.zip ./
COPY scripts/smoke.py ./smoke.py
ENV RECOGNITION_ARTIFACTS=/var/task/artifacts PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True PADDLE_PDX_CACHE_HOME=/tmp/paddlex XDG_CACHE_HOME=/tmp/cache HF_HUB_OFFLINE=1
CMD ["handler.handler"]
