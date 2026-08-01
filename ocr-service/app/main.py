"""
Kastoori Medicals -- PaddleOCR Service (Stage 1/2, Shadow Mode)
------------------------------------------------------------------
Purpose
    A standalone, host-agnostic REST OCR service used ONLY in shadow
    mode for evaluation. It is never in the live user-facing path.
    The existing production flow (Tesseract primary / Gemini opt-in
    verification, in app.js) is completely unmodified by this service
    existing.

Design constraints (per approved migration plan)
    - REST only. No websockets, no gRPC, no Railway-specific SDKs.
    - Host-agnostic: reads PORT from env (Railway sets $PORT
      automatically), has zero hardcoded platform assumptions, and
      will run unmodified on Render, Fly.io, a bare EC2 box, or
      locally via `uvicorn app.main:app`.
    - Does structured extraction internally is OUT OF SCOPE here.
      This service returns raw OCR (text + per-line boxes +
      confidence) only. Medicine/invoice field parsing continues to
      happen client-side via the EXISTING shared parser
      (ocr/shared-parser.js), so both providers are compared on a
      level field -- same downstream parsing logic, different raw
      OCR input.
    - No state, no database connection, no auth to any of Kastoori's
      systems. This service knows nothing about Supabase, Master
      Data, or inventory. It is a pure image-in / text-out function,
      matching the same boundary Tesseract.js and Gemini Vision
      already respect from the browser's point of view.

Endpoints
    GET  /health         -> liveness/readiness check
    POST /ocr             -> { base64, mime_type } -> raw OCR result
"""

import base64
import io
import logging
import time
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("paddleocr-service")

app = FastAPI(
    title="Kastoori Medicals OCR Service (PaddleOCR)",
    description="Shadow-mode raw OCR microservice. Not in the live user path.",
    version="0.1.0",
)

# CORS is permissive by design at this stage: this service is only
# ever called from the browser during shadow-mode evaluation, never
# used to authorize writes, and returns no sensitive data. Tighten to
# an explicit origin allowlist before any Stage 3/4 promotion to a
# user-facing path.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_ocr_engine = None  # lazy-loaded singleton -- PaddleOCR model load is slow (~seconds)


def get_engine():
    """Lazily construct and cache the PaddleOCR engine.

    Lazy + singleton so the (slow) model weights load once per process,
    not once per request. If PaddleOCR/paddlepaddle isn't installed or
    fails to initialize, this raises -- the /ocr endpoint turns that
    into a clean 503 rather than a crash, so the caller's existing
    "provider unavailable -> fall back" logic (already built into the
    browser-side provider contract) works unchanged.
    """
    global _ocr_engine
    if _ocr_engine is None:
        from paddleocr import PaddleOCR  # imported lazily: heavy import

        logger.info("Loading PaddleOCR model (first request only)...")
        _ocr_engine = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
        logger.info("PaddleOCR model loaded.")
    return _ocr_engine


class OCRRequest(BaseModel):
    base64: str = Field(..., description="Base64-encoded image bytes (no data: prefix)")
    mime_type: str = Field(default="image/jpeg", alias="mimeType")

    class Config:
        populate_by_name = True


class OCRLine(BaseModel):
    text: str
    confidence: float  # 0-100
    box: list  # 4 [x, y] corner points, in original-image pixel coords


class OCRResponse(BaseModel):
    text: str  # all recognized lines joined with \n, in reading order top-to-bottom
    confidence: Optional[float]  # overall average confidence, 0-100, or null if no text found
    provider: str = "paddleocr"
    lines: list[OCRLine]
    processing_ms: int


@app.get("/health")
def health():
    """Liveness/readiness probe. Does NOT force-load the model (so an
    idle/cold instance still reports healthy quickly); the model is
    loaded lazily on first real /ocr call."""
    return {"status": "ok", "engine_loaded": _ocr_engine is not None}


@app.post("/ocr", response_model=OCRResponse)
def run_ocr(req: OCRRequest):
    start = time.time()
    try:
        image_bytes = base64.b64decode(req.base64)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image data: {exc}")

    try:
        engine = get_engine()
    except Exception as exc:
        logger.error("PaddleOCR engine unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="OCR engine unavailable") from exc

    try:
        import numpy as np
        from PIL import Image

        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        result = engine.ocr(np.array(img), cls=True)
    except Exception as exc:
        logger.error("OCR inference failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"OCR inference failed: {exc}")

    lines = []
    scores = []
    # PaddleOCR result shape: [[ [box, (text, score)], ... ]] per image
    page = result[0] if result and result[0] else []
    for entry in page:
        box, (text, score) = entry
        conf = round(float(score) * 100, 2)
        lines.append({"text": text, "confidence": conf, "box": box})
        scores.append(conf)

    full_text = "\n".join(l["text"] for l in lines)
    overall_confidence = round(sum(scores) / len(scores), 2) if scores else None
    processing_ms = int((time.time() - start) * 1000)

    return OCRResponse(
        text=full_text,
        confidence=overall_confidence,
        lines=lines,
        processing_ms=processing_ms,
    )
