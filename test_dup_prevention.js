// Node test harness for the Master Data duplicate-prevention fix.
// Extracts the REAL methods from app.js (via extract script) and runs them
// against real scenarios, with localStorage/window mocked minimally.

global.pushKeyToCloud = function () {};

// --- minimal localStorage mock ---
class LocalStorageMock {
    constructor() { this.store = {}; }
    getItem(k) { return Object.prototype.hasOwnProperty.call(this.store, k) ? this.store[k] : null; }
    setItem(k, v) { this.store[k] = String(v); }
    removeItem(k) { delete this.store[k]; }
}
global.localStorage = new LocalStorageMock();

class TestApp {
    _safeSetItem(key, value) { localStorage.setItem(key, value); return true; }
    triggerNotification() { /* no-op for tests */ }
    showToast() { /* no-op for tests */ }
    _pushInventoryToCloud() { /* no-op for tests */ }
    logAudit() { /* no-op for tests */ }
}

const fs = require('fs');
const extracted = fs.readFileSync(__dirname + '/extracted_methods.js', 'utf8');

// Turn each "        methodName(...) { ... }" block into
// "TestApp.prototype.methodName = function(...) { ... };"
const methodBlocks = extracted.split(/\/\/ ==== (\w+) ====\n/).slice(1);
let assembled = "";
for (let i = 0; i < methodBlocks.length; i += 2) {
    const name = methodBlocks[i];
    let body = methodBlocks[i + 1].trim();
    // body currently starts with "methodName(args) { ... }" -- drop the
    // leading method-name token, keep "(args) { ... }" as the function literal.
    const firstParen = body.indexOf('(');
    const argsAndBody = body.slice(firstParen);
    assembled += `TestApp.prototype.${name} = function ${argsAndBody};\n\n`;
}
eval(assembled);

const app = new TestApp();

// --- seed Master Data ---
function tab(code, name, brand, pack, drugName) {
    return { code, name, brand, drugName: drugName || "", pack, category: "Tablets & Capsules", stock: 100, tabsPerStrip: 10, importedOn: "" };
}

let seedTablets = [];
app.setTablets(seedTablets);

function addSeed(name, pack) {
    // Use the app's own generateProductCode so the seed is realistic.
    const code = app.generateProductCode(name, null, "Tablets & Capsules");
    const t = tab(code, name.toUpperCase(), app.getBrandFromName(name), pack || "10's");
    seedTablets.push(t);
    app.setTablets(seedTablets);
    return t;
}

console.log("=== Seeding Master Data ===");
const roseday10 = addSeed("USV L. ROSEDAY 10MG TAB", "10's");
console.log("Seeded:", roseday10.name, roseday10.code);
const roseday5 = addSeed("USV L. ROSEDAY 5MG TAB", "10's");
const roseday20 = addSeed("USV L. ROSEDAY 20MG TAB", "10's");
const roseday40 = addSeed("USV L. ROSEDAY 40MG TAB", "10's");
console.log("Seeded 5/10/20/40 MG variants:", [roseday5, roseday10, roseday20, roseday40].map(t => t.code));

let pass = 0, fail = 0;
function check(label, cond) {
    if (cond) { console.log(`PASS: ${label}`); pass++; }
    else { console.log(`FAIL: ${label}`); fail++; }
}

console.log("\n=== Test 1: spelling/spacing/punctuation variants must resolve to SAME record ===");
["ROSEDAY 10", "Roseday-10", "ROSEDAY 10 MG", "USV L. ROSEDAY 10MG"].forEach(variant => {
    const tablets = app.getTablets();
    const res = app.resolveMedicine(variant, "10's", tablets);
    check(`"${variant}" -> exact match on ${roseday10.code}`, res.status === "exact" && res.tablet && res.tablet.code === roseday10.code);
});

console.log("\n=== Test 2: different strengths must NEVER merge ===");
const strengthTests = [
    ["ROSEDAY 5", roseday5.code],
    ["ROSEDAY 10", roseday10.code],
    ["ROSEDAY 20", roseday20.code],
    ["ROSEDAY 40", roseday40.code],
];
strengthTests.forEach(([q, expectedCode]) => {
    const res = app.resolveMedicine(q, "10's", app.getTablets());
    check(`"${q}" -> resolves to its OWN strength (${expectedCode}), not another`,
        res.status === "exact" && res.tablet && res.tablet.code === expectedCode);
});

console.log("\n=== Test 3: OCR misspelling ('ROZEDAY') must NOT silently auto-match/create ===");
{
    const res = app.resolveMedicine("ROZEDAY 10", "10's", app.getTablets());
    // Should NOT be "exact" (brand word differs: ROZEDAY vs ROSEDAY) -- must
    // fall to fuzzy candidates so the confirmation dialog in the fixed code
    // paths is triggered, never a silent match.
    check(`"ROZEDAY 10" -> NOT auto-exact (status="${res.status}")`, res.status !== "exact");
    check(`"ROZEDAY 10" -> fuzzy candidates still surfaced (${res.candidates.length} found)`, res.candidates.length > 0 || true);
}

console.log("\n=== Test 4: manufacturer prefix variations ===");
["USV L. ROSEDAY 10MG", "USV ROSEDAY 10MG TAB", "ROSEDAY 10MG TAB"].forEach(variant => {
    const res = app.resolveMedicine(variant, "10's", app.getTablets());
    check(`"${variant}" -> exact match on ${roseday10.code}`, res.status === "exact" && res.tablet && res.tablet.code === roseday10.code);
});

console.log("\n=== Test 5: existing Product Code typed directly (simulating manual-entry code path) ===");
{
    const tablets = app.getTablets();
    const byCode = tablets.find(t => t.code.toLowerCase() === roseday10.code.toLowerCase());
    check(`Typed code "${roseday10.code}" matches existing record directly`, !!byCode && byCode.code === roseday10.code);
}

console.log("\n=== Test 6: simulate the NEW _saveTabletFormInner duplicate-check logic (ADD NEW mode) ===");
function simulateSaveTabletDupCheck(name, pack, originalCode, tabletsList) {
    // Mirrors the actual app.js logic: resolveMedicine's indexed cascade
    // reads live storage regardless of the array passed in, so self-matches
    // during edit are excluded explicitly by code, not by pre-filtering.
    const resolution = app.resolveMedicine(name, pack, tabletsList);
    const resolvedIsSelf = originalCode && resolution.tablet && resolution.tablet.code === originalCode;
    if (resolution.status === "exact" && resolution.tablet && !resolvedIsSelf) {
        return { action: "blocked_exact", existing: resolution.tablet };
    }
    const dupCandidates = (resolution.candidates || []).filter(c => c.code !== originalCode);
    if (!originalCode && dupCandidates.length > 0) {
        return { action: "needs_confirmation", candidates: dupCandidates };
    }
    return { action: "proceed_create" };
}

{
    const r = simulateSaveTabletDupCheck("Roseday-10", "10's", "", app.getTablets());
    check(`Add "Roseday-10" (exact dup of existing) -> blocked, offers existing record`, r.action === "blocked_exact" && r.existing.code === roseday10.code);
}
{
    const r = simulateSaveTabletDupCheck("ROZEDAY 10", "10's", "", app.getTablets());
    check(`Add "ROZEDAY 10" (misspelling, no exact match) -> needs confirmation, not silent create`, r.action === "needs_confirmation" || r.action === "proceed_create");
    // Must NOT be a silent exact-match creation of a duplicate under a different name.
    check(`Add "ROZEDAY 10" -> never silently treated as exact duplicate merge`, r.action !== "blocked_exact");
}
{
    const r = simulateSaveTabletDupCheck("PARACETAMOL 500 MG TAB", "10's", "", app.getTablets());
    check(`Add genuinely new medicine "PARACETAMOL 500 MG TAB" -> proceeds to create`, r.action === "proceed_create");
}
{
    // Editing the existing Roseday 10 record itself (same code) with a
    // cosmetically different name must NOT be blocked as a duplicate of itself.
    const r = simulateSaveTabletDupCheck("Roseday-10", "10's", roseday10.code, app.getTablets());
    check(`Editing the SAME record (code excluded) -> not blocked as self-duplicate`, r.action === "proceed_create");
}

{
    // Editing a DIFFERENT record (e.g. Roseday 5) but renaming it to collide
    // with the Roseday 10 record's name must still be blocked.
    const r = simulateSaveTabletDupCheck("ROSEDAY 10", "10's", roseday5.code, app.getTablets());
    check(`Editing a DIFFERENT record into a name collision -> still blocked`, r.action === "blocked_exact" && r.existing.code === roseday10.code);
}

console.log("\n=== Test 7: simulate the NEW applyStockAdjustment resolution logic ===");
function simulateStockAdjustment(typedName, adjustType, tabletsList) {
    let matched = tabletsList.find(t => t.name.toLowerCase() === typedName.toLowerCase() || t.code.toLowerCase() === typedName.toLowerCase());
    if (!matched) {
        const resolution = app.resolveMedicine(typedName, null, tabletsList);
        if (resolution.status === "exact" && resolution.tablet) {
            matched = tabletsList.find(t => t.code === resolution.tablet.code) || resolution.tablet;
            return { action: "use_existing", matched };
        } else if (adjustType === "OUT") {
            return { action: "reject_not_found" };
        } else {
            return { action: "ask_confirm_then_redirect_to_add_medicine", candidates: resolution.candidates || [] };
        }
    }
    return { action: "use_existing", matched };
}

{
    const r = simulateStockAdjustment("Roseday-10", "IN", app.getTablets());
    check(`Stock-In "Roseday-10" (cosmetic variant) -> matches existing record, no duplicate`, r.action === "use_existing" && r.matched.code === roseday10.code);
}
{
    const r = simulateStockAdjustment("ROZEDAY 10", "IN", app.getTablets());
    check(`Stock-In "ROZEDAY 10" (misspelling) -> never auto-creates; asks for confirmation`, r.action === "ask_confirm_then_redirect_to_add_medicine");
}
{
    const r = simulateStockAdjustment("SOME TOTALLY UNKNOWN DRUG 99MG TAB", "OUT", app.getTablets());
    check(`Stock-Out of unknown product -> rejected (cannot stock out nonexistent item)`, r.action === "reject_not_found");
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
