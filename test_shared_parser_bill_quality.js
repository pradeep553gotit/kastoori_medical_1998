/**
 * test_shared_parser_bill_quality.js
 * ------------------------------------------------------------------
 * Real-bill quality fixes for OCRSharedParser.parseLocalText("bill"):
 *   - noise-line filtering (GSTIN/bank/terms/totals/letterhead lines
 *     no longer become fake medicine rows)
 *   - invoice_number / invoice_date header extraction from raw text
 *   - garbled-token detection routes fragmented OCR reads to manual
 *     review (low confidence) instead of silently importing junk
 *
 * Run: node test_shared_parser_bill_quality.js
 */
"use strict";
global.window = global;
require("./ocr/shared-parser.js");

let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

const realisticBillText = [
    "Kastoori Medicals",
    "Invoice No: KM-2026-0451",
    "Invoice Date: 15/07/2026",
    "GSTIN: 33ABCDE1234F1Z5",
    "PARACETAMOL 500MG TABLET B123 05/27 10s 100 12.50",
    "AMOXICILLIN 250MG CAPSULE",
    "TARAM AO I PEER WE 7 7",
    "Sub Total 4500.00",
    "Terms and Conditions apply",
    "Thank you for your business"
].join("\n");

const out = window.OCRSharedParser.parseLocalText(realisticBillText, "bill", { fallbackSupplier: "Test Supplier" });

check("Header/footer/GST/letterhead noise lines are excluded from items", out.items.length === 3);
check("Invoice number extracted from raw text", out.invoice_number === "KM-2026-0451");
check("Invoice date extracted and normalized to ISO", out.invoice_date === "2026-07-15");
check("Legitimate medicine row with digits parses normally", out.items.some(i => i.medicine_name.includes("PARACETAMOL") && i.confidence_score === 55));
check("Legitimate short medicine row with no digits still parses (not over-filtered)", out.items.some(i => i.medicine_name.includes("AMOXICILLIN")));
check("Garbled OCR row is flagged for manual review, not silently imported", out.items.some(i => i.medicine_name.includes("TARAM") && i.needsReview === true && i.confidence_score < 55));
check("No 'Sub Total'/'Terms'/'Thank you' rows leaked into items", !out.items.some(i => /SUB TOTAL|TERMS|THANK YOU/i.test(i.medicine_name)));

// A perfectly ordinary multi-word medicine name (not garbled) must NOT be
// flagged low-confidence just because it has more than one short token.
const normalOut = window.OCRSharedParser.parseLocalText("VITAMIN B12 500MCG TABLET B99 06/28 10s 50 8.00", "bill", {});
check("Ordinary multi-word medicine name is NOT flagged as garbled", normalOut.items.length === 1 && normalOut.items[0].confidence_score === 55);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
