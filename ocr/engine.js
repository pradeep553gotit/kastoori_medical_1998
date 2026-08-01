/**
 * ocr/engine.js
 * ------------------------------------------------------------------
 * Phase A -- Dedicated Scanning Engine (shared foundation).
 *
 * This is the new orchestrator that will eventually replace the old
 * "Gemini is primary" flow. It flips the priority requested in the
 * spec: LOCAL OCR (Tesseract) is primary and runs first, avoiding
 * cloud quota entirely for the common case. An external AI provider
 * (Gemini, via the existing GeminiProvider) is only ever called as a
 * SECONDARY verification step, and only when local confidence is
 * below threshold -- never as the default path.
 *
 * IMPORTANT -- SCOPE OF THIS FILE (Phase A only):
 * This module produces RAW recognized text + a document-type guess +
 * confidence + timings. It does NOT do bill-specific or order-specific
 * structured field extraction (medicine names, batch numbers, strip
 * conversion, Master Data matching) -- that is Phase B (Supplier Bill
 * Scanner) and Phase C (Order Processing Scanner), which consume this
 * engine's output. Nothing in app.js calls this file yet; wiring it
 * into the real scan buttons happens when Phase B/C are built on top
 * of it, so there is zero risk to the currently-shipped Gemini-primary
 * flow (Phase 3.11) from adding this file.
 *
 * Providers are dependency-injected (not constructed internally) so
 * this module has no hard dependency on `window.Tesseract` being
 * loaded or an app instance existing -- callers (including tests)
 * supply whatever provider objects they have.
 *
 * Exposes: window.ScanningEngine.scan(base64Data, mimeType, options)
 *   options:
 *     providers.tesseract  -- required for local-primary OCR to run at all
 *     providers.gemini     -- optional; used only for low-confidence verification
 *     preprocess            -- boolean, default true
 *     preprocessOptions      -- passed through to OCRPreprocessor.process
 *     secondaryVerification  -- boolean, default true (only fires if gemini provider given AND confidence low)
 *     lowConfidenceThreshold -- default 45 (0-100)
 *     onProgress(evt)
 *
 *   returns:
 *     {
 *       rawText, confidence, provider,          // "tesseract" | "gemini"
 *       docType, docConfidence,                 // from DocumentClassifier
 *       usedSecondaryVerification,
 *       preprocessing: { steps, skipped },
 *       timings: { preprocessingMs, ocrMs, totalMs }
 *     }
 */
(function (global) {
    "use strict";

    // Minimal, business-agnostic verbatim-transcription prompt for the
    // OPTIONAL secondary Gemini verification pass. Deliberately does NOT
    // ask for structured bill/order fields -- that would duplicate
    // Phase B/C's job and reintroduce a second parsing path. It only asks
    // Gemini to transcribe what it sees, in the same shape
    // (`{"text": "..."}`) the existing JSON-repair machinery expects.
    const VERIFICATION_PROMPT = `You are transcribing a photographed document for a pharmacy inventory system.
Return ONLY valid JSON, nothing else, in this exact shape:
{"text": "<the full verbatim text you can read in the image, preserving line breaks as \\n>"}
Do not summarize, translate, or reformat. Do not omit any line, even if you are unsure of it -- transcribe your best reading.`;

    async function scan(base64Data, mimeType, options = {}) {
        const opts = Object.assign({
            preprocess: true,
            preprocessOptions: {
                autoRotate: true, deskew: true, autoCrop: true,
                normalizeBrightness: true, contrast: true, sharpen: true,
                denoise: false, adaptiveThreshold: false
            },
            secondaryVerification: true,
            lowConfidenceThreshold: 45,
            onProgress: null
        }, options);

        const providers = options.providers || {};
        const emit = (evt) => { if (typeof opts.onProgress === "function") { try { opts.onProgress(evt); } catch (e) { /* ignore */ } } };

        const totalStart = now();

        // --- Stage 1: preprocessing -----------------------------------
        let processed = { base64: base64Data, mimeType, steps: [], skipped: ["preprocessing-disabled"] };
        const preStart = now();
        if (opts.preprocess) {
            emit({ phase: "preprocessing" });
            if (!global.OCRPreprocessor) {
                processed = { base64: base64Data, mimeType, steps: [], skipped: ["module-not-loaded"] };
            } else {
                try {
                    processed = await global.OCRPreprocessor.process(base64Data, mimeType, opts.preprocessOptions);
                } catch (e) {
                    console.warn("[ScanningEngine] Preprocessing failed, using original image:", e);
                    processed = { base64: base64Data, mimeType, steps: [], skipped: ["exception: " + e.message] };
                }
            }
        }
        const preprocessingMs = Math.round(now() - preStart);

        // --- Stage 2: local-primary OCR ---------------------------------
        if (!providers.tesseract) {
            throw new Error("ScanningEngine.scan requires providers.tesseract -- local OCR is the primary engine and has no default fallback within this module.");
        }

        emit({ phase: "ocr", provider: "tesseract" });
        const ocrStart = now();
        let ocrResult;
        try {
            ocrResult = await providers.tesseract.recognize(processed.base64, processed.mimeType, null, (p) => emit(Object.assign({ phase: "ocr-progress" }, p)));
        } catch (err) {
            emit({ phase: "ocr-failed", provider: "tesseract", error: err.message });
            throw err; // no silent fallback to guessed data -- caller decides what to do with a hard local-OCR failure
        }
        const ocrMs = Math.round(now() - ocrStart);

        let finalText = ocrResult.text;
        let finalConfidence = ocrResult.confidence;
        let finalProvider = "tesseract";
        let usedSecondaryVerification = false;

        // --- Stage 3: optional secondary verification --------------------
        const confidenceIsLow = finalConfidence === null || finalConfidence < opts.lowConfidenceThreshold;
        if (opts.secondaryVerification && confidenceIsLow && providers.gemini && providers.gemini.isAvailable()) {
            emit({ phase: "secondary-verification", provider: "gemini", reason: `local confidence ${finalConfidence} < ${opts.lowConfidenceThreshold}` });
            try {
                const verified = await providers.gemini.recognize(processed.base64, processed.mimeType, VERIFICATION_PROMPT, (p) => emit(Object.assign({ phase: "ocr-progress" }, p)));
                const verifiedText = (verified.text && typeof verified.text === "object" && typeof verified.text.text === "string")
                    ? verified.text.text
                    : (typeof verified.text === "string" ? verified.text : null);
                if (verifiedText) {
                    finalText = verifiedText;
                    finalConfidence = verified.confidence != null ? verified.confidence : 70; // Gemini verification pass with no per-field score -- moderate default, not a guessed structured value
                    finalProvider = "gemini";
                    usedSecondaryVerification = true;
                }
            } catch (err) {
                // Secondary verification is best-effort -- if it fails, we
                // still return the local OCR result rather than throwing,
                // since local text (even low-confidence) is strictly more
                // useful than nothing.
                emit({ phase: "secondary-verification-failed", error: err.message });
            }
        }

        // --- Stage 4: document classification -----------------------------
        let docType = "unknown", docConfidence = 0;
        if (global.DocumentClassifier && typeof finalText === "string") {
            try {
                const classification = global.DocumentClassifier.classify(finalText);
                docType = classification.type;
                docConfidence = classification.confidence;
            } catch (e) { /* classification is advisory -- never block on it */ }
        }

        const totalMs = Math.round(now() - totalStart);

        return {
            rawText: finalText,
            confidence: finalConfidence,
            provider: finalProvider,
            docType, docConfidence,
            usedSecondaryVerification,
            preprocessing: { steps: processed.steps, skipped: processed.skipped },
            timings: { preprocessingMs, ocrMs, totalMs }
        };
    }

    function now() {
        return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }

    global.ScanningEngine = { scan };
})(typeof window !== "undefined" ? window : globalThis);
