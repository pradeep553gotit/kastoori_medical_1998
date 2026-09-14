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
    "AMOXICILLIN 250MG CAPSULE B456 06/28 10s 25 42.00",
    "TARAM AO I PEER WE 7 7",
    "Sub Total 4500.00",
    "Terms and Conditions apply",
    "Thank you for your business"
].join("\n");

const out = window.OCRSharedParser.parseLocalText(realisticBillText, "bill", { fallbackSupplier: "Test Supplier" });

check("Header/footer/GST/letterhead noise lines are excluded from items", out.items.length === 2);
check("Invoice number extracted from raw text", out.invoice_number === "KM-2026-0451");
check("Invoice date extracted and normalized to ISO", out.invoice_date === "2026-07-15");
check("Legitimate medicine row with digits parses normally", out.items.some(i => i.medicine_name.includes("PARACETAMOL") && i.confidence_score === 55));
check("Legitimate second table row parses when it has bill-row structure", out.items.some(i => i.medicine_name.includes("AMOXICILLIN")));
check("Garbled non-table OCR row is rejected, not surfaced as a medicine", !out.items.some(i => i.medicine_name.includes("TARAM")));
check("No 'Sub Total'/'Terms'/'Thank you' rows leaked into items", !out.items.some(i => /SUB TOTAL|TERMS|THANK YOU/i.test(i.medicine_name)));

// A perfectly ordinary multi-word medicine name (not garbled) must NOT be
// flagged low-confidence just because it has more than one short token.
const normalOut = window.OCRSharedParser.parseLocalText("VITAMIN B12 500MCG TABLET B99 06/28 10s 50 8.00", "bill", {});
check("Ordinary multi-word medicine name is NOT flagged as garbled", normalOut.items.length === 1 && normalOut.items[0].confidence_score === 55);

const noisyInvoice = window.OCRSharedParser.parseLocalText([
    "ANGEL PHARMACEUTICALS PRIVATE LIMITED",
    "No 44 Mount Road Chennai Tamil Nadu 600002",
    "Mobile 9876543210",
    "GSTIN 33ABCDE1234F1Z5",
    "Bank Account 123456789 IFSC HDFC0001234",
    "ROSUVASTATIN 10MG TAB RS10A 08/27 10s 12 98.50",
    "CGST 2.5  SGST 2.5",
    "Grand Total 1182.00",
    "Authorized Signature"
].join("\n"), "bill", {});

check("Mixed invoice keeps exactly the genuine medicine table row", noisyInvoice.items.length === 1 && noisyInvoice.items[0].medicine_name.includes("ROSUVASTATIN"));
check("Address/phone/GST/bank/footer text never becomes a medicine", !noisyInvoice.items.some(i => /CHENNAI|MOBILE|GST|BANK|SIGNATURE|ANGEL/i.test(i.medicine_name)));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
