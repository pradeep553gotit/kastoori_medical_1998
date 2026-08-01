/**
 * ocr/providers/paddleocr-provider.js
 * ------------------------------------------------------------------
 * PaddleOCR Provider (Stage 1 -- Shadow Mode Evaluation ONLY).
 *
 * IMPORTANT: this provider is intentionally NEVER placed in the
 * primary/fallback chain used by recognizeWithProviderFallback(). It
 * is only ever invoked by the separate shadow-mode comparison hook
 * (ocr/shadow-mode.js), which runs it in parallel to the real
 * Tesseract/Gemini path, logs the comparison, and discards its output
 * without showing it to the user or feeding it into any business
 * logic. See the approved Stage 1-2 migration plan.
 *
 * Interface contract (IDENTICAL to gemini-provider.js / tesseract-provider.js):
 *   async recognize(base64, mimeType, prompt, onProgress) -> {
 *       text,        // string -- raw recognized text, newline-joined, reading order
 *       confidence,  // 0-100 overall confidence, or null if unknown
 *       provider,    // "paddleocr"
 *       metadata     // { lines, serviceUrl, processingMs, boxes... }
 *   }
 *
 * `prompt` is accepted for interface parity only -- PaddleOCR has no
 * prompt-driven extraction mode (unlike Gemini); it is ignored. This
 * matches how tesseract-provider.js already treats `prompt` as a
 * no-op, so callers written against the shared contract don't need a
 * provider-specific branch.
 *
 * Backend location is configurable, NOT hardcoded, so the service can
 * move hosts (Railway -> anywhere) with zero code changes here --
 * only the stored URL changes:
 *   1. window.PADDLEOCR_SERVICE_URL (set at page load / build time), or
 *   2. localStorage "ti_paddleocr_url" (ops override without a deploy)
 *   Falls back to null -- isAvailable() returns false, meaning the
 *   shadow-mode hook skips this provider cleanly rather than throwing.
 */
(function (global) {
    "use strict";

    const DEFAULT_TIMEOUT_MS = 15000;

    class PaddleOCRProvider {
        constructor(options = {}) {
            this.name = "paddleocr";
            this._timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
        }

        _getServiceUrl() {
            if (global.PADDLEOCR_SERVICE_URL) return global.PADDLEOCR_SERVICE_URL;
            try {
                const stored = localStorage.getItem("ti_paddleocr_url");
                if (stored) return stored;
            } catch (e) { /* localStorage unavailable -- treat as not configured */ }
            return null;
        }

        isAvailable() {
            return !!this._getServiceUrl();
        }

        async recognize(base64Data, mimeType, prompt, onProgress) {
            const serviceUrl = this._getServiceUrl();
            if (!serviceUrl) {
                const err = new Error("PaddleOCR service URL is not configured (shadow-mode only provider).");
                err.code = "paddleocr_not_configured";
                throw err;
            }

            if (typeof onProgress === "function") {
                onProgress({ phase: "attempting", attempt: 1, total: 1, model: "paddleocr-remote" });
            }

            const controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
            const timeoutId = controller ? setTimeout(() => controller.abort(), this._timeoutMs) : null;

            let response;
            const requestStart = (typeof performance !== "undefined" ? performance.now() : Date.now());
            try {
                response = await fetch(`${serviceUrl.replace(/\/$/, "")}/ocr`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ base64: base64Data, mimeType: mimeType || "image/jpeg" }),
                    signal: controller ? controller.signal : undefined
                });
            } catch (err) {
                if (typeof onProgress === "function") {
                    onProgress({ phase: "failed", attempt: 1, total: 1, model: "paddleocr-remote" });
                }
                const wrapped = new Error(
                    err && err.name === "AbortError"
                        ? `PaddleOCR service timed out after ${this._timeoutMs}ms`
                        : `PaddleOCR service request failed: ${err.message}`
                );
                wrapped.code = err && err.name === "AbortError" ? "paddleocr_timeout" : "paddleocr_network_error";
                throw wrapped;
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const bodyText = await response.text().catch(() => "");
                const err = new Error(`PaddleOCR service returned HTTP ${response.status}: ${bodyText}`);
                err.code = "paddleocr_http_error";
                err.status = response.status;
                if (typeof onProgress === "function") {
                    onProgress({ phase: "failed", attempt: 1, total: 1, model: "paddleocr-remote" });
                }
                throw err;
            }

            const data = await response.json();
            const clientRoundTripMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - requestStart);

            if (typeof onProgress === "function") {
                onProgress({ phase: "success", attempt: 1, total: 1, model: "paddleocr-remote" });
            }

            return {
                text: data.text || "",
                confidence: typeof data.confidence === "number" ? data.confidence : null,
                provider: "paddleocr",
                metadata: {
                    lines: Array.isArray(data.lines) ? data.lines : [],
                    serviceUrl,
                    serverProcessingMs: typeof data.processing_ms === "number" ? data.processing_ms : null,
                    clientRoundTripMs,
                    note: "Shadow-mode only -- not used for any business decision or user-visible output."
                }
            };
        }
    }

    global.OCRProviders = global.OCRProviders || {};
    global.OCRProviders.PaddleOCRProvider = PaddleOCRProvider;
})(typeof window !== "undefined" ? window : globalThis);
