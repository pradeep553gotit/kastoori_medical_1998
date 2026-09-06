/**
 * test_table_reconstructor.js
 * ------------------------------------------------------------------
 * Verifies the bounding-box-based table reconstruction that replaced
 * naive flattened-text line parsing as the root-cause fix for the
 * 49/62 fake-medicine-row failures seen on real supplier bills.
 *
 * Run: node test_table_reconstructor.js
 */
"use strict";
global.window = global;
require("./ocr/table-reconstructor.js");
require("./ocr/shared-parser.js");

let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

function w(text, x0, y0, x1, y1, confidence = 90) { return { text, confidence, bbox: { x0, y0, x1, y1 } }; }

// A synthetic invoice: header row, 2 real medicine rows (built with words
// in a deliberately non-reading-order sequence, mimicking a case where
// Tesseract's own text flow would have interleaved columns), a GST/noise
// row, and a decorative letterhead line with no real signals.
const words = [
    w("Invoice", 10, 5, 60, 15), w("No:", 62, 5, 80, 15), w("KM-2026-0451", 85, 5, 160, 15),
    w("Kastoori", 10, 25, 60, 35), w("Medicals", 62, 25, 120, 35),
    // Row 1 (y ~ 50) -- words appended out of x-order on purpose
    w("12.50", 290, 50, 330, 58), w("PARACETAMOL", 10, 48, 90, 60), w("100", 265, 50, 285, 58),
    w("500MG", 92, 49, 130, 59), w("B123", 185, 49, 220, 59), w("TABLET", 132, 48, 180, 60), w("05/27", 225, 49, 260, 59),
    // Row 2 (y ~ 80)
    w("AMOXICILLIN", 10, 78, 95, 90), w("250MG", 97, 79, 135, 89),
    w("B456", 190, 79, 225, 89), w("08/27", 230, 79, 265, 89), w("50", 270, 80, 285, 88), w("8.00", 290, 80, 325, 88),
    // Noise row: GST summary line (has a decimal number, but should still be rejected by keyword)
    w("GST", 10, 300, 40, 310), w("Amount:", 42, 300, 90, 310), w("225.50", 95, 300, 140, 310),
    // Decorative line: no real signals (no date/price/batch/qty)
    w("Pharmaceutical", 10, 350, 100, 360), w("Excellence", 102, 350, 170, 360),
];

const rows = window.OCRTableReconstructor.reconstructRows(words);
check("All 6 rows reconstructed by Y-position", rows.length === 6);

const rowTexts = rows.map(r => r.text);
check("Row 1 words reordered correctly by X position despite out-of-order input", rowTexts.some(t => t === "PARACETAMOL 500MG TABLET B123 05/27 100 12.50"));
check("Row 2 reconstructed correctly", rowTexts.some(t => t === "AMOXICILLIN 250MG B456 08/27 50 8.00"));

const candidates = window.OCRTableReconstructor.getMedicineCandidateRows(words);
check("Exactly 2 medicine candidate rows survive filtering (not 6)", candidates.length === 2);
check("Invoice header row rejected", !candidates.some(c => c.text.includes("KM-2026-0451")));
check("Letterhead/company-name row rejected (no signals)", !candidates.some(c => c.text.includes("Kastoori")));
check("GST summary row rejected by noise keyword despite having a decimal number", !candidates.some(c => c.text.includes("GST Amount")));
check("Decorative line with zero signals rejected", !candidates.some(c => c.text.includes("Pharmaceutical Excellence")));

// End-to-end through parseLocalText using the bbox path. The flattened
// `text` argument is passed separately from `words` in the real pipeline
// (both come from the same OCR pass) -- header extraction reads `text`,
// row extraction reads `words` when available. Using a realistic string
// here (not a meaningless placeholder) so header extraction has something
// real to find, exactly as it would from the real OCR text.
const flattenedText = "Kastoori Medicals Invoice No: KM-2026-0451 PARACETAMOL 500MG TABLET B123 05/27 100 12.50 AMOXICILLIN 250MG B456 08/27 50 8.00 GST Amount: 225.50";
const parsed = window.OCRSharedParser.parseLocalText(flattenedText, "bill", { fallbackSupplier: "Munot Pharmaceuticals", words });
check("parseLocalText produces exactly 2 items via the bbox path (not the flattened-text path)", parsed.items.length === 2);
check("Invoice number still extracted from the flattened text", parsed.invoice_number === "KM-2026-0451");
check("Both items are real medicine names, not header/footer/noise", parsed.items.every(i => /PARACETAMOL|AMOXICILLIN/.test(i.medicine_name)));

// Backward compatibility: no bbox data -> falls back to old flattened-text path unchanged
const fallbackParsed = window.OCRSharedParser.parseLocalText("PARACETAMOL 500MG TABLET B123 05/27 10s 100 12.50", "bill", { fallbackSupplier: "Test" });
check("No words provided: falls back to flattened-text line parser (backward compatible)", fallbackParsed.items.length === 1);

// A bare, meaningless fragment (e.g. "ARN" from real-bill testing) is
// filtered out entirely by the existing short-no-digit noise rule --
// it never becomes a phantom row at all, which is a stricter (and
// equally acceptable) outcome than showing it flagged for review.
check("Bare short fragment ('ARN') produces zero phantom items", window.OCRSharedParser.parseLocalText("ARN", "bill", {}).items.length === 0);
// A short garbled fragment that DOES carry a digit (so it survives the
// noise filter) must still be caught by looksGarbled's single-token check.
check("Short garbled token with a digit ('AR3X') is flagged, not trusted", (() => {
    const r = window.OCRSharedParser.parseLocalText("AR3X", "bill", {});
    return r.items.length === 1 && r.items[0].needsReview === true && r.items[0].confidence_score === 15;
})());
check("A genuine multi-word medicine name with a real strength token is NOT flagged as garbled", (() => {
    const r = window.OCRSharedParser.parseLocalText("PARACETAMOL 500MG", "bill", {});
    return r.items.length === 1 && !r.items[0].needsReview;
})());

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
