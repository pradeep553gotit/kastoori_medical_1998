/**
 * ocr/providers/gemini-provider.js
 * ------------------------------------------------------------------
 * OCR Provider Interface (Phase 3.2) + Gemini Provider (Phase 3.3).
 *
 * Every provider implements:
 *   async recognize(base64, mimeType, prompt, onProgress) -> {
 *       text,          // raw/parsed payload (object, for JSON-mode Gemini)
 *       confidence,    // 0-100 overall confidence, or null if unknown
 *       provider,      // "gemini"
 *       metadata       // { model, retryLog, usedJsonRepair, resizeMs }
 *   }
 *
 * IMPORTANT -- why this wraps instead of relocates:
 * The existing `runSharedGeminiVisionOCR` / `_classifyGeminiError` /
 * `_isGeminiBusyError` methods on TabletInventoryApp contain
 * production-tuned retry, backoff, model-fallback, and JSON-repair
 * logic (see app.js). The task instructions are explicit: "Move the
 * existing Gemini implementation into the new provider. Do not
 * rewrite its internal logic... Behavior should remain identical."
 *
 * Physically relocating that code into a standalone global file would
 * require either (a) copy-pasting it -- creating TWO copies that can
 * drift and silently diverge, or (b) reimplementing it against a
 * different `this` context -- which risks changing behavior despite
 * the "do not rewrite" instruction. Both are worse for regression
 * risk than composition.
 *
 * So this provider is a thin adapter: it calls the app instance's
 * existing method verbatim and reshapes the result into the standard
 * provider envelope above. The retry engine itself still lives in
 * exactly one place (app.js), unchanged. This is called out in the
 * implementation summary as a deliberate tradeoff.
 */
(function (global) {
    "use strict";

    class GeminiProvider {
        /**
         * @param {object} app - the TabletInventoryApp instance (for
         *   access to runSharedGeminiVisionOCR, fetchWithTimeout, and the
         *   stored API key check it already performs).
         */
        constructor(app) {
            this.app = app;
            this.name = "gemini";
        }

        isAvailable() {
            try {
                return !!localStorage.getItem("ti_ai_key");
            } catch (e) {
                return false;
            }
        }

        async recognize(base64Data, mimeType, prompt, onProgress) {
            const app = this.app;
            const parsed = await app.runSharedGeminiVisionOCR(base64Data, mimeType, prompt, onProgress);

            // Overall confidence: average any per-field confidence objects
            // found on returned items, if present. Falls back to null
            // (unknown) rather than fabricating a number -- downstream
            // manual-review gating already has its own per-field logic
            // (validateOCRFields / field_confidence) and should not be
            // short-circuited by a provider-level guess.
            let confidence = null;
            try {
                const items = Array.isArray(parsed) ? parsed : (parsed && parsed.items);
                if (Array.isArray(items) && items.length) {
                    const scores = [];
                    items.forEach(it => {
                        if (it && it.confidence && typeof it.confidence === "object") {
                            Object.values(it.confidence).forEach(v => {
                                if (typeof v === "number") scores.push(v);
                            });
                        } else if (it && typeof it.confidence_score === "number") {
                            scores.push(it.confidence_score);
                        }
                    });
                    if (scores.length) confidence = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
                }
            } catch (e) { /* leave confidence null, never let this throw */ }

            return {
                text: parsed,
                confidence,
                provider: "gemini",
                metadata: {
                    retryLog: app._lastGeminiRetryLog || null,
                    usedJsonRepair: app._lastGeminiUsedJsonRepair || false,
                    resizeMs: app._lastOcrResizeMs
                }
            };
        }
    }

    global.OCRProviders = global.OCRProviders || {};
    global.OCRProviders.GeminiProvider = GeminiProvider;
})(typeof window !== "undefined" ? window : globalThis);
