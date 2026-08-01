# Kastoori Medicals -- PaddleOCR Shadow-Mode Service

Stage 1/2 deliverable per the approved OCR migration plan. This service is
**never in the live user-facing path**. It exists solely so `ocr/shadow-mode.js`
can compare PaddleOCR's raw output against the real production result
(Tesseract-primary / Gemini-opt-in-verification) for a sampled percentage
of scans, for evaluation purposes only.

## Run locally
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

## Deploy to Railway
1. Push this folder to its own GitHub repo (or a subdirectory Railway can target).
2. In Railway: New Project -> Deploy from GitHub repo -> select this repo/folder.
3. Railway auto-detects `railway.json` and builds via the included `Dockerfile`.
4. Railway injects `$PORT` automatically -- no environment variable setup needed.
5. Once deployed, copy the public URL Railway assigns.

## Wiring it into the app (browser side)
No code change needed to point at your deployed URL -- set either:
- `window.PADDLEOCR_SERVICE_URL = "https://your-service.up.railway.app"` (e.g. in `index.html`), or
- In the browser console / a settings screen: `localStorage.setItem("ti_paddleocr_url", "https://your-service.up.railway.app")`

Then enable shadow mode itself (separately, since the provider being
configured and shadow mode being *enabled* are independent switches by design):
```js
localStorage.setItem("ti_ocr_shadow_enabled", "true");
localStorage.setItem("ti_ocr_shadow_sample_rate", "0.1"); // 10% of scans
```

## Moving to a different host later
Nothing in `app/main.py` or the `Dockerfile` references Railway. To move:
1. Deploy the same Dockerfile to the new host (Render, Fly.io, EC2 + any
   container runtime, etc.).
2. Update the stored URL (`ti_paddleocr_url` / `PADDLEOCR_SERVICE_URL`).
That's the entire migration -- `railway.json` is the only Railway-specific
file, and it is inert on any other host (they simply ignore it).

## Endpoints
- `GET /health` -- liveness/readiness, does not force-load the model.
- `POST /ocr` -- `{ "base64": "...", "mimeType": "image/jpeg" }` ->
  `{ text, confidence, provider, lines, processing_ms }`

## Scope reminder
This service does **not** do medicine/invoice field extraction, Master Data
matching, or strip-to-tablet conversion. Those stay exactly where they are
today (`ocr/shared-parser.js`, `app.js`), unchanged, and are applied
identically to whichever provider's raw text is being evaluated -- that's
what makes the Stage 2 comparison apples-to-apples.
