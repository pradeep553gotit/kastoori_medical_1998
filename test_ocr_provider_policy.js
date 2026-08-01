/**
 * test_ocr_provider_policy.js
 * ------------------------------------------------------------------
 * Phase A migration: verifies the REVISED recognizeWithProviderFallback
 * priority -- local Tesseract is primary by default, Gemini is called
 * ONLY when explicitly enabled via policy AND local confidence is low.
 * A default-policy scan must NEVER touch the Gemini provider, which is
 * the concrete fix for "every scan hits Gemini and dies on a leaked/
 * revoked API key (403)".
 *
 * This is a trimmed reimplementation of the decision logic (same
 * approach as test_ocr_integration.js / test_batch_ocr_ui_wiring.js),
 * not a full DOM/app.js harness.
 *
 * Run: node test_ocr_provider_policy.js
 */
"use strict";
let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

// Mirrors recognizeWithProviderFallback's decision structure without the
// real network/Tesseract worker calls.
async function recognize({ tesseractLoaded, tesseractConfidence, geminiAvailable, policy }) {
    const calls = { tesseract: 0, gemini: 0 };
    const runTesseract = async () => { calls.tesseract++; return { provider: "tesseract", confidence: tesseractConfidence }; };
    const runGemini = async () => { calls.gemini++; return { provider: "gemini", confidence: 95 }; };

    if (tesseractLoaded) {
        const local = await runTesseract();
        const lowConfidence = local.confidence < policy.lowConfidenceThreshold;
        const geminiEligible = policy.enableGeminiVerification && lowConfidence && geminiAvailable;
        if (!geminiEligible) return { result: local, calls };
        const verified = await runGemini();
        return { result: verified, calls };
    }
    if (geminiAvailable) {
        const result = await runGemini();
        return { result, calls };
    }
    throw new Error("No OCR provider available");
}

(async () => {
    // --- Default policy, healthy Tesseract confidence: Gemini never called ---
    {
        const { calls, result } = await recognize({
            tesseractLoaded: true, tesseractConfidence: 88, geminiAvailable: true,
            policy: { enableGeminiVerification: false, lowConfidenceThreshold: 60 }
        });
        check("Default policy + good local confidence: Tesseract used, Gemini never called", calls.gemini === 0 && result.provider === "tesseract");
    }

    // --- Default policy, LOW Tesseract confidence: Gemini STILL never called (opt-in required) ---
    {
        const { calls, result } = await recognize({
            tesseractLoaded: true, tesseractConfidence: 20, geminiAvailable: true,
            policy: { enableGeminiVerification: false, lowConfidenceThreshold: 60 }
        });
        check("Default policy + LOW local confidence: Gemini still never called (opt-in required)", calls.gemini === 0 && result.provider === "tesseract");
    }

    // --- Verification explicitly enabled + low confidence: Gemini called as SECONDARY ---
    {
        const { calls, result } = await recognize({
            tesseractLoaded: true, tesseractConfidence: 20, geminiAvailable: true,
            policy: { enableGeminiVerification: true, lowConfidenceThreshold: 60 }
        });
        check("Verification enabled + low confidence: Tesseract runs first, then Gemini verifies", calls.tesseract === 1 && calls.gemini === 1 && result.provider === "gemini");
    }

    // --- Verification enabled but confidence is HIGH: Gemini still not called ---
    {
        const { calls, result } = await recognize({
            tesseractLoaded: true, tesseractConfidence: 90, geminiAvailable: true,
            policy: { enableGeminiVerification: true, lowConfidenceThreshold: 60 }
        });
        check("Verification enabled + HIGH confidence: Gemini not called (nothing to verify)", calls.gemini === 0 && result.provider === "tesseract");
    }

    // --- Tesseract failed to load entirely: Gemini used as last resort ---
    {
        const { calls, result } = await recognize({
            tesseractLoaded: false, tesseractConfidence: null, geminiAvailable: true,
            policy: { enableGeminiVerification: false, lowConfidenceThreshold: 60 }
        });
        check("Tesseract unavailable: Gemini used as last-resort (scanner still works)", calls.gemini === 1 && result.provider === "gemini");
    }

    // --- Neither provider available: throws, does not silently return nothing ---
    {
        let threw = false;
        try {
            await recognize({ tesseractLoaded: false, tesseractConfidence: null, geminiAvailable: false, policy: { enableGeminiVerification: false, lowConfidenceThreshold: 60 } });
        } catch (e) { threw = true; }
        check("No provider available: throws instead of silently failing", threw === true);
    }

    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail > 0 ? 1 : 0);
})();
