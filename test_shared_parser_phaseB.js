/**
 * test_shared_parser_phaseB.js
 * ------------------------------------------------------------------
 * Phase B accuracy fixes for OCRSharedParser.parseLocalText():
 *   - order-sheet noise filtering (patient/doctor/ward/bed lines never
 *     become fake medicine rows)
 *   - empty order rows (no qty/strength/pack extracted) are dropped
 *   - table-end cutoff on bills (nothing after Grand Total/Terms/
 *     Thank You is ever treated as a medicine row, even address/blank
 *     lines with no noise keyword of their own)
 *   - expanded bill header extraction: purchase_date, supplier GSTIN,
 *     grand_total, tax_amount, discount_amount, total_items
 *
 * Run: node test_shared_parser_phaseB.js
 */
"use strict";
global.window = global;
require("./ocr/shared-parser.js");

let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

// --- Order sheet noise filtering ---
const orderSheetText = [
    "City General Hospital",
    "Patient Name: Ramesh Kumar",
    "Patient ID: P-9981",
    "Doctor Name: Dr. Anita Sharma",
    "Ward: Cardiology  Bed No: 12",
    "PARACETAMOL 500MG 20",
    "AMOXICILLIN 250MG 10",
    "",
    "Notes: give after food",
    "Total: 2 items"
].join("\n");

const orderOut = window.OCRSharedParser.parseLocalText(orderSheetText, "order", {});
check("Patient/Doctor/Ward/Bed lines excluded from order items", orderOut.items.length === 2);
check("Real order rows still parse (PARACETAMOL)", orderOut.items.some(i => i.medicine_name.includes("PARACETAMOL")));
check("Real order rows still parse (AMOXICILLIN)", orderOut.items.some(i => i.medicine_name.includes("AMOXICILLIN")));
check("No patient/doctor/ward text leaked into any item name", !orderOut.items.some(i => /PATIENT|DOCTOR|WARD|BED/i.test(i.medicine_name)));

// --- Empty order rows dropped ---
const orderWithEmptyRow = "SOME RANDOM MEDICINE PLACEHOLDER TEXT\nPARACETAMOL 500MG 10";
const orderOut2 = window.OCRSharedParser.parseLocalText(orderWithEmptyRow, "order", {});
check("Order row with no qty/strength/pack extracted is dropped as empty", orderOut2.items.length === 1 && orderOut2.items[0].medicine_name.includes("PARACETAMOL"));

// --- Table-end cutoff on bills ---
const billWithFooterAddress = [
    "Invoice No: KM-2026-0900",
    "PARACETAMOL 500MG TABLET B123 05/27 10s 100 12.50",
    "Grand Total: 1250.00",
    "123 Anna Salai, Chennai",       // address line with no noise keyword
    "IBUPROFEN 400MG TABLET B456 06/27 10s 50 15.00"  // would look like a real row if not cut off
].join("\n");
const billOut = window.OCRSharedParser.parseLocalText(billWithFooterAddress, "bill", { fallbackSupplier: "Test Supplier" });
check("Table-end cutoff stops processing at Grand Total (footer address not treated as item)", billOut.items.length === 1);
check("Nothing after the table-end line is captured, even a real-looking row", !billOut.items.some(i => i.medicine_name.includes("IBUPROFEN")));

// --- Expanded header field extraction ---
const fullBillText = [
    "Kastoori Medicals",
    "Invoice No: KM-2026-0451",
    "Invoice Date: 15/07/2026",
    "Purchase Date: 14/07/2026",
    "GSTIN: 33ABCDE1234F1Z5",
    "PARACETAMOL 500MG TABLET B123 05/27 10s 100 12.50",
    "Total Items: 1",
    "Discount Amount: 50.00",
    "Tax Amount: 225.00",
    "Grand Total: 4500.00"
].join("\n");
const fullOut = window.OCRSharedParser.parseLocalText(fullBillText, "bill", { fallbackSupplier: "Test Supplier" });
check("purchase_date extracted and normalized to ISO", fullOut.purchase_date === "2026-07-14");
check("supplier_gst_number (GSTIN) extracted", fullOut.supplier_gst_number === "33ABCDE1234F1Z5");
check("grand_total extracted as a number", fullOut.grand_total === 4500.00);
check("tax_amount extracted as a number", fullOut.tax_amount === 225.00);
check("discount_amount extracted as a number", fullOut.discount_amount === 50.00);
check("total_items extracted as a number", fullOut.total_items === 1);

// --- Header fields absent from source text stay null/blank, not fabricated ---
const minimalBillText = "PARACETAMOL 500MG TABLET B123 05/27 10s 100 12.50";
const minimalOut = window.OCRSharedParser.parseLocalText(minimalBillText, "bill", {});
check("Missing header fields stay null rather than being guessed", minimalOut.grand_total === null && minimalOut.tax_amount === null && minimalOut.total_items === null);

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
