/**
 * ocr/providers/tesseract-provider.js
 * ------------------------------------------------------------------
 * Local OCR Provider. Uses Tesseract.js, loaded via CDN in index.html
 * (bumped to tesseract.js@5 during the Phase A migration -- v4.0.2
 * had a known worker-init incompatibility that could not even run in
 * OCR_LOAD_TEST_REPORT.md's benchmark; v5 is confirmed working there).
 *
 * PHASE A MIGRATION: this is now the PRIMARY OCR provider, used first
 * on every scan (see app.js's recognizeWithProviderFallback / 
 * _getOCRPolicy). Gemini is opt-in secondary verification only, and is
 * used as a last resort if this provider fails to load at all.
 *
 * Tesseract has no structured JSON mode -- it returns plain recognized
 * text plus a confidence score, unlike Gemini's schema-shaped JSON.
 * ocr/shared-parser.js (OCRSharedParser.parseLocalText) turns that
 * plain text into the same structured shape the rest of the pipeline
 * (normalizeOCRResponse, validateOCRFields, manual-review gating)
 * already expects, deliberately at conservative confidence so
 * uncertain local reads still route to manual review.
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
            // Tesseract.js v5 API: createWorker(lang) resolves a ready worker.
            this._worker = await global.Tesseract.createWorker("eng");
            // Default page segmentation mode (PSM 3, "fully automatic page
            // segmentation") is tuned for free-flowing prose, not a tabular
            // invoice with columns of numbers/codes next to sparse text --
            // on real supplier bills this was the direct cause of medicine
            // names coming out fragmented into pseudo-random short tokens
            // (e.g. "TARAM AO I PEER WE 7 7"), because Tesseract was trying
            // to guess paragraph/column boundaries on a layout that isn't
            // one. PSM 6 ("assume a single uniform block of text") reads a
            // cropped/rectified invoice region far more reliably in
            // practice. preserve_interword_spaces keeps column gaps from
            // Tesseract's internal spacing heuristics, which the shared
            // parser's regexes rely on to separate fields.
            try {
                await this._worker.setParameters({
                    tessedit_pageseg_mode: "6",
                    preserve_interword_spaces: "1"
                });
            } catch (e) {
                console.warn("[OCR] Tesseract setParameters failed (continuing with defaults):", e);
            }
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
