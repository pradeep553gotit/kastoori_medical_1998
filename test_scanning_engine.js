/**
 * test_scanning_engine.js
 * ------------------------------------------------------------------
 * Phase A tests -- DocumentClassifier + ScanningEngine, using mocked
 * providers so no browser/canvas/Tesseract/network is required.
 * Run: node test_scanning_engine.js
 */
"use strict";
let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

global.window = global;
require("./ocr/document-classifier.js");
require("./ocr/engine.js");

// --- DocumentClassifier ------------------------------------------------
const billText = "TAX INVOICE\nGSTIN: 29ABCDE1234F1Z5\nBATCH: AZ2201  MRP 145.50  GST 12%\nDISCOUNT 5%";
const orderText = "DISPENSARY: Kastoori PHC\nORDER SHEET\nMedicine Required Quantity\nParacetamol 500mg  120";
const ambiguousText = "hello world this has neither signal";

check("Classifier: identifies a bill from GST/MRP/batch/invoice signals", DocumentClassifier.classify(billText).type === "bill");
check("Classifier: identifies an order sheet from dispensary/order-sheet signals", DocumentClassifier.classify(orderText).type === "order");
check("Classifier: returns 'unknown' rather than guessing on ambiguous text", DocumentClassifier.classify(ambiguousText).type === "unknown");
check("Classifier: bill confidence is meaningfully high on strong signal", DocumentClassifier.classify(billText).confidence >= 60);
check("Classifier: unknown confidence is 0 with zero signal", DocumentClassifier.classify(ambiguousText).confidence === 0);

// --- ScanningEngine: local-primary, no secondary needed -----------------
(async () => {
    const highConfTesseract = {
        isAvailable: () => true,
        recognize: async () => ({ text: billText, confidence: 88, provider: "tesseract", metadata: {} })
    };
    const geminiShouldNotBeCalled = {
        isAvailable: () => true,
        recognize: async () => { throw new Error("Gemini should NOT have been called -- local confidence was high"); }
    };

    const result1 = await ScanningEngine.scan("base64stub", "image/jpeg", {
        preprocess: false, // skip canvas/Image() work -- not available in node
        providers: { tesseract: highConfTesseract, gemini: geminiShouldNotBeCalled }
    });
    check("Engine: uses tesseract as primary provider", result1.provider === "tesseract");
    check("Engine: does NOT call Gemini when local confidence is above threshold", result1.usedSecondaryVerification === false);
    check("Engine: classifies the bill text correctly via the returned rawText", result1.docType === "bill");
    check("Engine: returns timings for preprocessing/ocr/total", typeof result1.timings.ocrMs === "number" && typeof result1.timings.totalMs === "number");

    // --- ScanningEngine: low confidence triggers secondary verification --
    const lowConfTesseract = {
        isAvailable: () => true,
        recognize: async () => ({ text: "garb1ed t3xt", confidence: 20, provider: "tesseract", metadata: {} })
    };
    const geminiVerifier = {
        isAvailable: () => true,
        recognize: async () => ({ text: { text: orderText }, confidence: null, provider: "gemini", metadata: {} })
    };
    const result2 = await ScanningEngine.scan("base64stub", "image/jpeg", {
        preprocess: false,
        providers: { tesseract: lowConfTesseract, gemini: geminiVerifier }
    });
    check("Engine: falls back to secondary Gemini verification on low local confidence", result2.usedSecondaryVerification === true);
    check("Engine: adopts the verified text from Gemini", result2.rawText === orderText);
    check("Engine: classifies using the (better) verified text", result2.docType === "order");

    // --- ScanningEngine: low confidence but no gemini provider given -----
    // (spec requirement: local-first, cloud is OPTIONAL -- must work with
    // zero cloud dependency when no secondary provider is configured)
    const result3 = await ScanningEngine.scan("base64stub", "image/jpeg", {
        preprocess: false,
        providers: { tesseract: lowConfTesseract } // no gemini at all
    });
    check("Engine: works with local OCR only (no cloud dependency required)", result3.provider === "tesseract" && result3.usedSecondaryVerification === false);

    // --- ScanningEngine: secondary verification failure doesn't crash ----
    const geminiThatFails = {
        isAvailable: () => true,
        recognize: async () => { throw new Error("simulated Gemini outage"); }
    };
    const result4 = await ScanningEngine.scan("base64stub", "image/jpeg", {
        preprocess: false,
        providers: { tesseract: lowConfTesseract, gemini: geminiThatFails }
    });
    check("Engine: falls back to the low-confidence local result if verification itself fails (never throws)", result4.provider === "tesseract" && result4.rawText === "garb1ed t3xt");

    // --- ScanningEngine: hard requirement -- no tesseract provider = throw
    let threw = false;
    try {
        await ScanningEngine.scan("base64stub", "image/jpeg", { preprocess: false, providers: {} });
    } catch (e) { threw = true; }
    check("Engine: throws clearly if no local provider is supplied at all (no silent no-op)", threw === true);

    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail > 0 ? 1 : 0);
})();
