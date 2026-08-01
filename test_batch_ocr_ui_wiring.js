/**
 * test_batch_ocr_ui_wiring.js
 * ------------------------------------------------------------------
 * Priority 2 tests: wiring the existing OCRQueue/scanImagesBatch into
 * the production Bill Processing UI (startBatchBillScan /
 * loadNextBatchBillResult / _advanceBatchBillReview).
 *
 * These test the NEW pure-logic pieces in isolation (batch-review-queue
 * advancement, skip-on-zero-items, end-of-batch handling) using a
 * trimmed reimplementation mirroring app.js's actual methods -- same
 * approach test_ocr_integration.js already uses for
 * recognizeWithProviderFallback's decision rule. This does not spin up
 * the full 16k-line app or a real DOM; it verifies the state machine
 * that decides what to load/show next.
 *
 * The concurrency/retry/failure-isolation behavior of OCRQueue itself
 * is already covered by test_ocr_integration.js's "Batch queue" checks
 * and is NOT re-tested here.
 *
 * Run: node test_batch_ocr_ui_wiring.js
 */
"use strict";
let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

// Trimmed reimplementation of the batch-review state machine from
// app.js's _loadBatchBillReviewItem / _advanceBatchBillReview /
// _updateBatchNextButton, with UI calls replaced by recorded events
// (no DOM needed) -- same shape/behavior as the real methods.
function makeReviewController(queue) {
    const state = { index: 0, loaded: [], skipped: [], ended: false, nextButtonVisible: false };

    function updateNextButton() {
        const hasMore = queue && state.index < queue.length - 1;
        state.nextButtonVisible = !!hasMore;
    }

    function loadItem(index) {
        if (!queue || !queue[index]) return;
        const { parsed, fileName } = queue[index];
        const items = (parsed.items || []);
        if (items.length === 0) {
            state.skipped.push(fileName);
            advance(index);
            return;
        }
        state.loaded.push(fileName);
        updateNextButton();
    }

    function advance(fromIndex) {
        const nextIndex = fromIndex + 1;
        if (nextIndex >= queue.length) {
            state.ended = true;
            state.nextButtonVisible = false;
            return;
        }
        state.index = nextIndex;
        loadItem(nextIndex);
    }

    return { state, loadItem, advance };
}

// --- Normal case: 3 successfully-scanned bills, step through all ----
{
    const q = [
        { fileName: "bill1.jpg", parsed: { items: [{ medicine_name: "PARA 500" }] } },
        { fileName: "bill2.jpg", parsed: { items: [{ medicine_name: "AMOX 250" }] } },
        { fileName: "bill3.jpg", parsed: { items: [{ medicine_name: "GLYCOMET" }] } }
    ];
    const c = makeReviewController(q);
    c.loadItem(0);
    check("First batch item loads into review", c.state.loaded[0] === "bill1.jpg");
    check("Next button visible with more items remaining", c.state.nextButtonVisible === true);

    c.advance(0);
    check("Second batch item loads after Next", c.state.loaded[1] === "bill2.jpg");
    check("Next button still visible (1 remaining)", c.state.nextButtonVisible === true);

    c.advance(1);
    check("Third (last) batch item loads after Next", c.state.loaded[2] === "bill3.jpg");
    check("Next button hidden on the last item", c.state.nextButtonVisible === false);

    c.advance(2);
    check("Batch marked ended after the last item", c.state.ended === true);
}

// --- A bill that OCR'd successfully but produced zero medicine rows
// is skipped automatically, without requiring user action ------------
{
    const q = [
        { fileName: "empty-scan.jpg", parsed: { items: [] } },
        { fileName: "good-scan.jpg", parsed: { items: [{ medicine_name: "ROSEDAY 10" }] } }
    ];
    const c = makeReviewController(q);
    c.loadItem(0);
    check("Zero-item bill is skipped, not loaded into review", !c.state.loaded.includes("empty-scan.jpg") && c.state.skipped[0] === "empty-scan.jpg");
    check("The next real bill auto-loads after a skip", c.state.loaded[0] === "good-scan.jpg");
    check("Next button hidden -- the skipped-to bill was the last one", c.state.nextButtonVisible === false);
}

// --- Single-bill batch never shows a Next button ---------------------
{
    const q = [{ fileName: "only-one.jpg", parsed: { items: [{ medicine_name: "TAZLOC 40" }] } }];
    const c = makeReviewController(q);
    c.loadItem(0);
    check("Single-item batch loads its only bill", c.state.loaded[0] === "only-one.jpg");
    check("Single-item batch never shows Next (nothing to advance to)", c.state.nextButtonVisible === false);
}

// --- Real OCRQueue module: batch scan isolates per-file failures,
// exactly what startBatchBillScan relies on to build succeeded/failed
// lists (mirrors the check already in test_ocr_integration.js, run
// again here against the actual filter logic startBatchBillScan uses) -
global.window = global;
require("./ocr/queue.js");
(async () => {
    const queue = new OCRQueue({ concurrency: 2 });
    queue.addAll(
        [{ name: "a.jpg" }, { name: "corrupt.jpg" }, { name: "c.jpg" }],
        async (file) => {
            if (file.name === "corrupt.jpg") throw new Error("corrupted");
            return { fileName: file.name, parsed: { items: [{ medicine_name: "X" }] } };
        }
    );
    // addAll's taskFactory contract is (item) => Promise, matching how
    // scanImagesBatch's buildTask is invoked via createOCRBatchQueue.
    await queue.run();
    const results = queue.results();
    const succeeded = results.filter(r => r.status === "done");
    const failed = results.filter(r => r.status !== "done");
    check("startBatchBillScan-style split: 2 succeeded", succeeded.length === 2);
    check("startBatchBillScan-style split: 1 failed, isolated (not thrown)", failed.length === 1 && failed[0].label === "corrupt.jpg");

    console.log(`\n${pass} passed, ${fail} failed.`);
    if (fail > 0) process.exit(1);
})();
