/**
 * ocr/providers/tesseract-provider.js
 * ------------------------------------------------------------------
 * Local OCR Provider (Phase 3.4) -- NEW. Uses Tesseract.js, which is
 * already loaded via CDN in index.html (tesseract.js@4.0.2) but was
 * never previously wired into the OCR pipeline.
 *
 * Used as a FALLBACK, never the primary provider:
 *   - Gemini quota exceeded
 *   - Gemini unavailable / hard failure (auth, network, service busy
 *     after retries exhausted)
 *   - Offline mode (navigator.onLine === false)
 *   - Manual "Retry with Local OCR" action
 *
 * Tesseract has no structured JSON mode -- it returns plain recognized
 * text plus a confidence score, unlike Gemini's schema-shaped JSON.
 * Callers that need the structured {dispensary_id, items:[...]} shape
 * must run their own light parsing over `.text` (existing regex-based
 * text parsers already exist for the manual-paste order flow --
 * `parseOrderTextWithGemini` shows the schema; a pure-local text
 * parser is listed under Remaining Work, since fabricating one now
 * risks a rushed, untested parser reaching production data).
 *
 * This provider's job, per the interface contract, stops at:
 *   recognize(image) -> { text, confidence, provider, metadata }
 */
(function (global) {
    "use strict";

    class TesseractProvider {
        constructor() {
            this.name = "tesseract";
            this._worker = null;
        }

        isAvailable() {
            return typeof global.Tesseract !== "undefined";
        }

        async _getWorker() {
            if (this._worker) return this._worker;
            if (!this.isAvailable()) {
                throw new Error("Tesseract.js is not loaded -- local OCR provider unavailable.");
            }
            // Tesseract.js v4 API: createWorker(lang) resolves a ready worker.
            this._worker = await global.Tesseract.createWorker("eng");
            return this._worker;
        }

        async recognize(base64Data, mimeType, prompt, onProgress) {
            if (!this.isAvailable()) {
                const err = new Error("Local OCR (Tesseract) is not available in this environment.");
                err.code = "local_ocr_unavailable";
                throw err;
            }

            if (typeof onProgress === "function") {
                onProgress({ phase: "attempting", attempt: 1, total: 1, model: "tesseract-local" });
            }

            const worker = await this._getWorker();
            const dataUrl = mimeType && mimeType.startsWith("image/")
                ? `data:${mimeType};base64,${base64Data}`
                : `data:image/jpeg;base64,${base64Data}`;

            const result = await worker.recognize(dataUrl);
            const text = (result && result.data && result.data.text) || "";
            const confidence = (result && result.data && typeof result.data.confidence === "number")
                ? Math.round(result.data.confidence)
                : null;

            if (typeof onProgress === "function") {
                onProgress({ phase: confidence !== null ? "success" : "warning", attempt: 1, total: 1, model: "tesseract-local" });
            }

            return {
                text,          // plain text, NOT parsed JSON -- see header note
                confidence,
                provider: "tesseract",
                metadata: { local: true, note: "Plain text only -- no structured field extraction." }
            };
        }

        async terminate() {
            if (this._worker) {
                try { await this._worker.terminate(); } catch (e) { /* ignore */ }
                this._worker = null;
            }
        }
    }

    global.OCRProviders = global.OCRProviders || {};
    global.OCRProviders.TesseractProvider = TesseractProvider;
})(typeof window !== "undefined" ? window : globalThis);
