// Validation for Priority 1 (FEFO-safe atomic deduction).
//
// This does NOT hit a live database -- it validates that the JS-side
// expectations (what deduct_stock_fefo_atomic in
// 04_fefo_atomic_deduction.sql is supposed to produce) match app.js's
// existing parseExpiryDate() semantics exactly, using the same reference
// implementation copied from app.js (MM/YY, unparseable -> 2099-12-31).
//
// Run: node migration_scripts/test_fefo_deduction.js
//
// For a true end-to-end check, also run this against a real Supabase
// project after applying 04_fefo_atomic_deduction.sql:
//   select * from deduct_stock_fefo_atomic('SOME-CODE', 25, 'test-user');
// and confirm the returned updated_batches/deducted_breakdown match the
// expectations below for equivalent input batches.

function parseExpiryDate(expStr) {
    if (!expStr) return new Date(2099, 11, 31);
    const cleanStr = expStr.trim().replace(/[\-\.\s]/g, '/');
    const parts = cleanStr.split('/');
    if (parts.length !== 2) return new Date(2099, 11, 31);
    let month = parseInt(parts[0], 10);
    let year = parseInt(parts[1], 10);
    if (isNaN(month) || isNaN(year)) return new Date(2099, 11, 31);
    if (year < 100) year += 2000;
    return new Date(year, month, 0, 23, 59, 59);
}

function simulateFefoDeduction(batches, qtyToDeduct) {
    const sorted = [...batches].sort((a, b) => parseExpiryDate(a.expiryDate) - parseExpiryDate(b.expiryDate));
    let remaining = qtyToDeduct;
    const breakdown = [];
    const result = batches.map(b => ({ ...b })); // preserve original order in output, like the SQL function does

    for (const b of sorted) {
        if (remaining <= 0) break;
        if (b.quantity > 0) {
            const deduct = Math.min(b.quantity, remaining);
            const target = result.find(r => r.batchNumber === b.batchNumber);
            target.quantity -= deduct;
            remaining -= deduct;
            breakdown.push({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, qtyDeducted: deduct });
        }
    }
    return { success: remaining === 0, updatedBatches: result, breakdown, shortfall: remaining };
}

function assert(cond, msg) {
    if (!cond) throw new Error("FAIL: " + msg);
    console.log("PASS: " + msg);
}

// Test 1: basic FEFO ordering -- earliest expiry (03/26) deducted before later ones
{
    const batches = [
        { batchNumber: "B-LATE", quantity: 50, expiryDate: "12/27" },
        { batchNumber: "B-EARLY", quantity: 30, expiryDate: "03/26" },
        { batchNumber: "B-MID", quantity: 40, expiryDate: "06/26" }
    ];
    const r = simulateFefoDeduction(batches, 50);
    assert(r.success, "50-unit deduction succeeds across batches");
    assert(r.updatedBatches.find(b => b.batchNumber === "B-EARLY").quantity === 0, "earliest batch (03/26) fully depleted first");
    assert(r.updatedBatches.find(b => b.batchNumber === "B-MID").quantity === 20, "remainder (20) taken from next-earliest (06/26)");
    assert(r.updatedBatches.find(b => b.batchNumber === "B-LATE").quantity === 50, "latest-expiry batch (12/27) untouched");
    assert(r.breakdown.length === 2, "breakdown lists exactly the 2 batches actually touched");
}

// Test 2: insufficient stock is reported as a shortfall, not a silent partial deduction
{
    const batches = [{ batchNumber: "B-1", quantity: 10, expiryDate: "01/27" }];
    const r = simulateFefoDeduction(batches, 25);
    assert(!r.success, "deduction correctly fails when total stock < requested qty");
    assert(r.shortfall === 15, "shortfall correctly computed as 15");
}

// Test 3: missing/unparseable expiry sorts LAST (2099-12-31), matching app.js parseExpiryDate
{
    const batches = [
        { batchNumber: "B-NOEXP", quantity: 20, expiryDate: null },
        { batchNumber: "B-DATED", quantity: 20, expiryDate: "01/26" }
    ];
    const r = simulateFefoDeduction(batches, 20);
    assert(r.updatedBatches.find(b => b.batchNumber === "B-DATED").quantity === 0, "dated batch consumed before undated batch");
    assert(r.updatedBatches.find(b => b.batchNumber === "B-NOEXP").quantity === 20, "undated batch left untouched (sorts last)");
}

console.log("\nAll FEFO logic checks passed. Verify the SQL function produces identical results against a live Supabase project before relying on it in production.");
