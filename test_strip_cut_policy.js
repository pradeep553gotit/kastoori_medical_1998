// Validation for Priority 2 (Strip Cut Policy).
//
// Mirrors the branching logic added to submitVerifiedOrder in app.js:
// given a requested tablet qty, strip size, and policy, what quantity
// should be dispensed NOW vs. deferred to Reorder (item.dueQty), and what
// decision label should be recorded.
//
// Run: node migration_scripts/test_strip_cut_policy.js

function decideStripCut(qtyRequested, tabsPerStrip, policy, staffChoosesCut) {
    const remainder = qtyRequested % tabsPerStrip;
    if (remainder === 0) {
        // No cut ever needed -- whole strips only, dispense in full.
        return { qtyNow: qtyRequested, qtyDeferred: 0, decision: null };
    }
    const sealedQty = qtyRequested - remainder;

    if (policy === "always_cut") {
        return { qtyNow: qtyRequested, qtyDeferred: 0, decision: "auto_always_cut" };
    }
    if (policy === "never_cut") {
        return { qtyNow: sealedQty, qtyDeferred: remainder, decision: "auto_never_cut_capped" };
    }
    // staff_decision
    if (staffChoosesCut) {
        return { qtyNow: qtyRequested, qtyDeferred: 0, decision: "cut_strip" };
    }
    return { qtyNow: sealedQty, qtyDeferred: remainder, decision: "sealed_only" };
}

function assert(cond, msg) {
    if (!cond) throw new Error("FAIL: " + msg);
    console.log("PASS: " + msg);
}

// Test 1: whole-strip request never triggers any policy branch at all
{
    const r = decideStripCut(30, 10, "staff_decision", null);
    assert(r.decision === null, "30 tablets / 10 per strip needs no decision (evenly divides)");
    assert(r.qtyNow === 30 && r.qtyDeferred === 0, "full 30 dispensed immediately");
}

// Test 2: always_cut proceeds automatically, no deferral
{
    const r = decideStripCut(23, 10, "always_cut", null);
    assert(r.decision === "auto_always_cut", "always_cut policy logs auto_always_cut");
    assert(r.qtyNow === 23 && r.qtyDeferred === 0, "always_cut dispenses the full requested qty now");
}

// Test 3: never_cut caps to sealed strips, defers the remainder -- never blocks
{
    const r = decideStripCut(23, 10, "never_cut", null);
    assert(r.decision === "auto_never_cut_capped", "never_cut policy logs auto_never_cut_capped");
    assert(r.qtyNow === 20, "never_cut dispenses only 20 (2 sealed strips of 10)");
    assert(r.qtyDeferred === 3, "never_cut defers exactly the 3-tablet remainder to reorder");
}

// Test 4: staff_decision, staff chooses to cut -- full qty now, nothing deferred
{
    const r = decideStripCut(23, 10, "staff_decision", true);
    assert(r.decision === "cut_strip", "staff choosing to cut logs cut_strip");
    assert(r.qtyNow === 23 && r.qtyDeferred === 0, "cutting dispenses the full requested qty");
}

// Test 5: staff_decision, staff declines to cut -- sealed only, remainder deferred
{
    const r = decideStripCut(23, 10, "staff_decision", false);
    assert(r.decision === "sealed_only", "staff declining to cut logs sealed_only");
    assert(r.qtyNow === 20 && r.qtyDeferred === 3, "declining behaves identically to never_cut's capping math");
}

// Test 6: request smaller than one full strip, never_cut/sealed_only -> qtyNow can be 0
// (this is the case the app.js guard `if (qtyToDeduct > 0)` exists to handle safely)
{
    const r = decideStripCut(5, 10, "never_cut", null);
    assert(r.qtyNow === 0, "sub-strip request with never_cut dispenses 0 now");
    assert(r.qtyDeferred === 5, "the entire 5 tablets defers to reorder, not silently dropped");
}

// Test 7 (regression, Priority 2 revision): an EXISTING/legacy medicine with
// no stripPolicy set at all must behave EXACTLY like always_cut -- no
// prompt, full quantity dispensed now. This is the specific behavior-
// preservation requirement from the revision: migration default changed
// from staff_decision to always_cut so production is unaffected until
// someone explicitly opts a medicine into a different policy.
{
    const legacyMedicinePolicy = undefined; // simulates dbMatch.stripPolicy on a pre-migration row
    const effectivePolicy = legacyMedicinePolicy || "always_cut"; // mirrors `dbMatch.stripPolicy || "always_cut"` in app.js
    const r = decideStripCut(23, 10, effectivePolicy, null);
    assert(effectivePolicy === "always_cut", "unset stripPolicy resolves to always_cut, not staff_decision");
    assert(r.decision === "auto_always_cut", "legacy medicine with no policy set triggers no prompt, just auto_always_cut");
    assert(r.qtyNow === 23 && r.qtyDeferred === 0, "legacy medicine dispenses the full requested qty immediately, identical to pre-Priority-2 behavior");
}

console.log("\nAll strip-cut policy branching checks passed.");
console.log("NOTE: this validates the decision math only. The actual submitVerifiedOrder");
console.log("integration (async modal, audit insert, dueQty bump feeding the existing");
console.log("reorder path) has NOT been exercised end-to-end against a live app/DB yet.");
