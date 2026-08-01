/**
 * test_ocr_worker_lifecycle.js
 * ------------------------------------------------------------------
 * Priority 4 tests. Loads the REAL TesseractProvider (not
 * reimplemented) and exercises its terminate() lifecycle plus a
 * trimmed stand-in for the app's _terminateLocalOCRWorker() wrapper
 * (same guard/no-op/error-swallow logic), mirroring how
 * test_ocr_integration.js isolates OCR pieces from the full app.
 *
 * Run: node test_ocr_worker_lifecycle.js
 */
"use strict";
let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

global.window = global;

// Fake Tesseract.js global so isAvailable()/createWorker() work without
// the real CDN library.
let workersCreated = 0;
let workersTerminated = 0;
global.Tesseract = {
    createWorker: async () => {
        workersCreated++;
        return {
            recognize: async () => ({ data: { text: "fake text", confidence: 80 } }),
            terminate: async () => { workersTerminated++; }
        };
    }
};

require("./ocr/providers/tesseract-provider.js");

// ---- Trimmed stand-in for TabletInventoryApp._terminateLocalOCRWorker,
// same guard/no-op/error-swallow behavior as the real method. ----
async function terminateLocalOCRWorker(appLike) {
    try {
        const tesseract = appLike._ocrProviders && appLike._ocrProviders.tesseract;
        if (tesseract && typeof tesseract.terminate === "function") {
            await tesseract.terminate();
        }
    } catch (e) { /* swallow, matches production */ }
}

(async () => {
    // 1. Worker is lazy -- not created until first recognize() call.
    const provider = new window.OCRProviders.TesseractProvider();
    check("Worker not created before first use", provider._worker === null && workersCreated === 0);

    await provider.recognize("ZmFrZQ==", "image/jpeg", null, null);
    check("Worker created on first recognize()", workersCreated === 1 && provider._worker !== null);

    await provider.recognize("ZmFrZQ==", "image/jpeg", null, null);
    check("Worker reused on second recognize() (no repeated create)", workersCreated === 1);

    // 2. terminate() actually calls through and clears the reference.
    await provider.terminate();
    check("terminate() calls underlying worker.terminate()", workersTerminated === 1);
    check("Worker reference cleared after terminate()", provider._worker === null);

    // 3. terminate() is idempotent -- calling again is a safe no-op.
    await provider.terminate();
    check("Calling terminate() again is a safe no-op", workersTerminated === 1);

    // 4. Next OCR request after termination recreates the worker automatically.
    await provider.recognize("ZmFrZQ==", "image/jpeg", null, null);
    check("Worker automatically recreated after termination", workersCreated === 2);
    await provider.terminate();

    // 5. Failed termination does not crash / propagate.
    const throwingProvider = new window.OCRProviders.TesseractProvider();
    throwingProvider._worker = { terminate: async () => { throw new Error("boom"); } };
    let threw = false;
    try { await throwingProvider.terminate(); } catch (e) { threw = true; }
    check("A worker.terminate() failure does not throw", !threw);
    check("Worker reference still cleared even if terminate() itself failed", throwingProvider._worker === null);

    // 6. App-level wrapper: safe when no provider/worker exists yet
    // (e.g. local OCR was never used this session).
    let wrapperThrew = false;
    try { await terminateLocalOCRWorker({ _ocrProviders: {} }); } catch (e) { wrapperThrew = true; }
    check("App-level wrapper no-ops safely with no tesseract provider", !wrapperThrew);

    try { await terminateLocalOCRWorker({}); } catch (e) { wrapperThrew = true; }
    check("App-level wrapper no-ops safely with no _ocrProviders at all", !wrapperThrew);

    // 7. App-level wrapper: swallows a terminate() rejection (e.g. sign-out
    // must never be blocked by a worker teardown failure).
    const failingApp = { _ocrProviders: { tesseract: { terminate: async () => { throw new Error("fail"); } } } };
    let signOutPathThrew = false;
    try { await terminateLocalOCRWorker(failingApp); } catch (e) { signOutPathThrew = true; }
    check("App-level wrapper never throws, even on termination failure (sign-out safe)", !signOutPathThrew);

    // 8. App-level wrapper: calls through to a real, working provider.
    let calledThrough = false;
    const workingApp = { _ocrProviders: { tesseract: { terminate: async () => { calledThrough = true; } } } };
    await terminateLocalOCRWorker(workingApp);
    check("App-level wrapper calls through to provider.terminate() when present", calledThrough);

    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail > 0 ? 1 : 0);
})();
