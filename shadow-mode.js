/**
 * ocr/shadow-mode.js
 * ------------------------------------------------------------------
 * Stage 2 -- OCR Shadow Mode (PaddleOCR vs. production provider).
 *
 * WHAT THIS DOES
 *   For a sampled subset of real scans, after the REAL production OCR
 *   result has already been produced (via the existing, completely
 *   unmodified recognizeWithProviderFallback in app.js), this module
 *   ALSO calls the new PaddleOCR service, runs the SAME shared parser
 *   used by the local-OCR path over its text, and logs a comparison
 *   of text/confidence/medicine-extraction/invoice-extraction/timing.
 *
 * WHAT THIS NEVER DOES
 *   - Never blocks or delays the user-visible scan flow. The caller
 *     invokes run() WITHOUT awaiting it (fire-and-forget); by the
 *     time this module's network call resolves, the user has already
 *     seen their real (Tesseract/Gemini) result.
 *   - Never changes what's returned to any caller -- this module has
 *     no return value that matters to business logic. It only logs.
 *   - Never shows PaddleOCR output in the UI.
 *   - Never touches Master Data, inventory, or Supabase business
 *     tables. Logging reuses the EXISTING generic audit log
 *     (app.logAudit), so no schema change is needed.
 *   - Never runs unless explicitly enabled (default OFF) and sampled
 *     in (default 10%), so this has zero cost/risk in normal
 *     operation and can be dialed to 0% instantly without a deploy.
 *
 * CONFIGURATION (localStorage, ops-controlled, no deploy needed)
 *   ti_ocr_shadow_enabled     "true"/"false"  (default: false)
 *   ti_ocr_shadow_sample_rate "0.1"           (default: 0.1, i.e. 10%)
 *
 * USAGE (called from app.js, fire-and-forget):
 *   if (window.OCRShadowMode) {
 *       window.OCRShadowMode.run(this, {
 *           base64Data, mimeType, prompt, type, fallbackSupplier,
 *           primaryResult, preprocessingMs
 *       }); // NOT awaited
 *   }
 */
(function (global) {
    "use strict";

    function isEnabled() {
        try {
            return localStorage.getItem("ti_ocr_shadow_enabled") === "true";
        } catch (e) {
            return false;
        }
    }

    function getSampleRate() {
        try {
            const raw = localStorage.getItem("ti_ocr_shadow_sample_rate");
            const parsed = raw != null ? parseFloat(raw) : 0.1;
            return (typeof parsed === "number" && !isNaN(parsed) && parsed >= 0 && parsed <= 1) ? parsed : 0.1;
        } catch (e) {
            return 0.1;
        }
    }

    function sampledIn(rate) {
        return Math.random() < rate;
    }

    // Extracts a comparable item list from either provider's structured
    // output. Both the existing Tesseract-path (parseLocalText) and
    // Gemini-path (Gemini's own JSON schema) already normalize into
    // `{ items: [...] }` (or a bare array) by the time this module sees
    // primaryResult.text -- see wrapTesseract() and GeminiProvider in
    // app.js/gemini-provider.js. This does not re-parse or alter that
    // value; it only reads it for comparison.
    function extractItems(structured) {
        if (Array.isArray(structured)) return structured;
        if (structured && Array.isArray(structured.items)) return structured.items;
        return [];
    }

    function summarizeItems(items) {
        return items.map(it => ({
            name: (it && (it.medicine_name || it.name)) || null,
            strength: (it && it.strength) || null,
            qty: (it && (it.quantity_tablets != null ? it.quantity_tablets : it.quantity)) || null
        }));
    }

    // Simple, conservative diff: counts and name-overlap only. This is
    // an evaluation aid for a human reviewer, NOT an auto-scoring
    // decision system -- deliberately no fuzzy-match business logic
    // duplicated here (that already lives in app.js's real matcher and
    // must not be duplicated/forked).
    function diffItemSets(primaryItems, paddleItems) {
        const primaryNames = new Set(primaryItems.map(i => (i.name || "").trim().toLowerCase()).filter(Boolean));
        const paddleNames = new Set(paddleItems.map(i => (i.name || "").trim().toLowerCase()).filter(Boolean));
        let overlap = 0;
        primaryNames.forEach(n => { if (paddleNames.has(n)) overlap++; });
        return {
            primaryItemCount: primaryItems.length,
            paddleItemCount: paddleItems.length,
            nameOverlapCount: overlap,
            countDelta: paddleItems.length - primaryItems.length
        };
    }

    async function run(app, ctx) {
        try {
            if (!isEnabled()) return;
            if (typeof navigator !== "undefined" && navigator.onLine === false) return; // don't spend a shadow call while offline
            if (!sampledIn(getSampleRate())) return;

            const providers = (app && typeof app._getOCRProviders === "function") ? app._getOCRProviders() : {};
            let paddle = providers.paddleocr;
            if (!paddle && global.OCRProviders && global.OCRProviders.PaddleOCRProvider) {
                paddle = new global.OCRProviders.PaddleOCRProvider();
            }
            if (!paddle || !paddle.isAvailable()) return; // not configured -- silently skip, never throw into the caller

            const shadowStart = (typeof performance !== "undefined" ? performance.now() : Date.now());
            let paddleResult;
            try {
                paddleResult = await paddle.recognize(ctx.base64Data, ctx.mimeType, ctx.prompt, null);
            } catch (err) {
                logComparison(app, ctx, { failed: true, error: err.message });
                return;
            }
            const paddleMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - shadowStart);

            // Run the SAME shared parser the local-OCR path already uses,
            // so both sides of the comparison went through identical
            // downstream extraction logic -- only the raw OCR text differs.
            let paddleStructured = paddleResult.text;
            try {
                if (global.OCRSharedParser && typeof paddleResult.text === "string") {
                    paddleStructured = global.OCRSharedParser.parseLocalText(paddleResult.text, ctx.type, { fallbackSupplier: ctx.fallbackSupplier });
                }
            } catch (e) {
                paddleStructured = { items: [] };
            }

            const primaryItems = summarizeItems(extractItems(ctx.primaryResult && ctx.primaryResult.text));
            const paddleItems = summarizeItems(extractItems(paddleStructured));
            const itemDiff = diffItemSets(primaryItems, paddleItems);

            logComparison(app, ctx, {
                failed: false,
                primary: {
                    provider: ctx.primaryResult && ctx.primaryResult.provider,
                    confidence: ctx.primaryResult && ctx.primaryResult.confidence,
                    ocrMs: ctx.primaryResult && ctx.primaryResult.metadata && ctx.primaryResult.metadata.ocrMs
                },
                paddleocr: {
                    confidence: paddleResult.confidence,
                    totalMs: paddleMs,
                    serverProcessingMs: paddleResult.metadata && paddleResult.metadata.serverProcessingMs
                },
                itemDiff,
                preprocessingMs: ctx.preprocessingMs,
                scanType: ctx.type
            });
        } catch (e) {
            // Shadow mode must NEVER throw into a real scan flow --
            // this catch-all is deliberate defense in depth on top of
            // the inner try/catches above.
            console.warn("[OCRShadowMode] Unexpected error (non-fatal, evaluation only):", e);
        }
    }

    function logComparison(app, ctx, summary) {
        try {
            if (app && typeof app.logAudit === "function") {
                app.logAudit("OCR", "shadow_comparison", null, summary, `paddleocr shadow ${ctx.type || ""}`.trim());
            } else {
                console.log("[OCRShadowMode] comparison:", summary);
            }
        } catch (e) { /* logging failure must never break anything else */ }
    }

    global.OCRShadowMode = { run, isEnabled, getSampleRate };
})(typeof window !== "undefined" ? window : globalThis);
