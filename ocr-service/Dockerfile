# Kastoori Medicals -- PaddleOCR shadow-mode service
# Deliberately plain Docker + uvicorn, no platform-specific base image
# or build plugin, so this runs unchanged on Railway, Render, Fly.io,
# ECS, or a bare VM -- "move host without code changes" requirement.

FROM python:3.11-slim

# System deps PaddleOCR/OpenCV need for image decoding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Railway (and most PaaS hosts) inject $PORT at runtime; default to
# 8000 for local/other-host runs where it isn't set.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
