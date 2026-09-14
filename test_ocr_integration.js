/**
 * test_ocr_integration.js
 * ------------------------------------------------------------------
 * Priority 3.11 integration tests. These test the NEW pieces in
 * isolation (provider selection / fallback rules, shared parser
 * output shape) using lightweight mocks -- they do not spin up the
 * full 16k-line app or touch Supabase/localStorage, mirroring how
 * test_fefo_deduction.js / test_strip_cut_policy.js already isolate
 * pure logic from the rest of the app.
 *
 * Run: node test_ocr_integration.js
 */
"use strict";
let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

// ---- Load the real modules (not reimplemented) ----------------------
global.window = global;
require("./ocr/queue.js");
require("./ocr/shared-parser.js");

// ---- Minimal stand-in for the app's _classifyGeminiError, copied
// verbatim in spirit (same codes/labels) so fallback-decision tests
// exercise the real rule set without needing the whole app class. ----
function classifyGeminiError(err) {
    const status = err.httpStatus;
    const msg = (err.message || "").toLowerCase();
    if (err.isTimeout || /timed out/.test(msg)) return { code: "timeout", label: "Timeout", retryable: true };
    if (status === 401 || status === 403) return { code: "auth", label: "Invalid API Key", retryable: false };
    if (status === 429) return { code: "quota", label: "Quota Exceeded", retryable: true };
    if (status === 503) return { code: "service_busy", label: "Service Busy", retryable: true };
    if (/invalid ai response format/.test(msg)) return { code: "invalid_json", label: "JSON Parse Failed", retryable: false };
    return { code: "unknown", label: "OCR Extraction Failed", retryable: false };
}

// A trimmed reimplementation of just the DECISION rule from
// recognizeWithProviderFallback (Requirement 2), so we can test it
// against many error types without instantiating the whole app.
function shouldFallBackToLocal(err, tesseractAvailable, offline) {
    const classification = classifyGeminiError(err);
    const isInfraFailure = classification.code === "quota" || classification.code === "service_busy" || classification.code === "timeout";
    return tesseractAvailable && (isInfraFailure || offline);
}

// --- Requirement 2: automatic fallback rules -------------------------
check("Falls back on quota exceeded (429)", shouldFallBackToLocal({ httpStatus: 429, message: "429" }, true, false) === true);
check("Falls back on timeout", shouldFallBackToLocal({ isTimeout: true, message: "timed out" }, true, false) === true);
check("Falls back on service unavailable (503)", shouldFallBackToLocal({ httpStatus: 503, message: "503" }, true, false) === true);
check("Falls back when offline regardless of error", shouldFallBackToLocal({ message: "network error" }, true, true) === true);
check("Does NOT fall back on invalid JSON (business/parsing failure)", shouldFallBackToLocal({ message: "invalid ai response format" }, true, false) === false);
check("Does NOT fall back on auth failure (misconfiguration, not infra)", shouldFallBackToLocal({ httpStatus: 401, message: "invalid api key" }, true, false) === false);
check("Does NOT fall back if Tesseract isn't available, even on quota", shouldFallBackToLocal({ httpStatus: 429, message: "429" }, false, false) === false);

// --- Requirement 3: shared parser produces the same schema shape -----
const orderText = "PARACETAMOL 500MG TABLET 10'S 30\nAMOXICILLIN 250MG CAPSULE 20";
const orderParsed = OCRSharedParser.parseLocalText(orderText, "order");
check("Shared parser (order) returns an items array", Array.isArray(orderParsed.items));
check("Shared parser (order) extracted both lines", orderParsed.items.length === 2);
check("Shared parser (order) extracted strength+unit", orderParsed.items[0].strength === "500" && orderParsed.items[0].unit === "MG");
check("Shared parser (order) extracted quantity_tablets", orderParsed.items[0].quantity_tablets === 30);
check("Shared parser (order) confidence object matches Gemini's shape", 
    orderParsed.items[0].confidence && typeof orderParsed.items[0].confidence.brand === "number" &&
    typeof orderParsed.items[0].confidence.strength === "number" && typeof orderParsed.items[0].confidence.pack === "number");
check("Shared parser (order) confidence values are capped low (heuristic fallback, forces manual review)",
    orderParsed.items.every(it => it.confidence.brand <= 65 && it.confidence.strength <= 65));

const billText = "AZITHROMYCIN 500MG TAB BATCH AZ2201 03/27 10s 4 MRP 145.50 GST 12%";
const billParsed = OCRSharedParser.parseLocalText(billText, "bill", { fallbackSupplier: "ABC Distributors" });
check("Shared parser (bill) returns an items array", Array.isArray(billParsed.items));
check("Shared parser (bill) extracted batch_number", billParsed.items[0] && billParsed.items[0].batch_number === "AZ2201");
check("Shared parser (bill) extracted expiry_date as MM/YYYY", billParsed.items[0] && billParsed.items[0].expiry_date === "03/2027");
check("Shared parser (bill) extracted mrp", billParsed.items[0] && billParsed.items[0].mrp === 145.5);
check("Shared parser (bill) confidence_score is capped low (55), guaranteeing existing <80 manual_review gate fires",
    billParsed.items[0] && billParsed.items[0].confidence_score === 55);
check("Shared parser (bill) extracts quantity only from a plausible table row",
    billParsed.items[0] && billParsed.items[0].quantity === 4);
check("Shared parser (bill) carries the fallback supplier through",
    billParsed.items[0] && billParsed.items[0].supplier_name === "ABC Distributors");

// --- Requirement 5: OCRQueue used for batch, with per-job failure
// isolation (a corrupted file must not crash the batch) -------------
(async () => {
    const queue = new OCRQueue({ concurrency: 2, maxRetries: 0 });
    queue.addAll(
        [{ name: "good1.jpg" }, { name: "corrupted.jpg" }, { name: "good2.jpg" }],
        async (file) => {
            if (file.name === "corrupted.jpg") throw new Error("Unsupported or corrupted file");
            return "parsed:" + file.name;
        }
    );
    await queue.run();
    const results = queue.results();
    check("Batch queue: 2 of 3 jobs succeed despite 1 corrupted file", results.filter(r => r.status === "done").length === 2);
    check("Batch queue: the corrupted file is isolated as failed, not thrown", results.find(r => r.label === "corrupted.jpg").status === "failed");
    check("Batch queue: failure does not crash the process (we got here)", true);

    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail > 0 ? 1 : 0);
})();
