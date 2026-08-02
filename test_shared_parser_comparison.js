// Verifies the root cause: feed lines representative of the screenshot's
// garbage output (invoice header/footer text) through BOTH the OLD
// (currently loaded, ocr/shared-parser.js) and NEW (orphaned, shared-parser.js)
// parsers, and confirm the new one correctly rejects them while the old one
// doesn't -- proving the bug and the fix, not just asserting it.

global.window = global;

// A synthetic raw-OCR text block reproducing the categories of garbage lines
// visible in the screenshot: address, page number, invoice header, GST/PAN
// summary, terms, plus two lines that SHOULD survive as real medicine rows.
const sampleRawText = `
KASTOORI MEDICALS
NO.158, KAR TOWERS EAST FACING, GST ROAD, CHROMPET, CHENNAI-44
TAX INVOICE
Page 1 of 2
Invoice No: SB/26-27/50249
GSTIN: 33AFUPM0568G1Z7
ROSEDAY 20MG TAB 10S BATCH SIH0247A EXP 01/28 MRP 90.94
GLUCORED FORTE 850MG TAB 10S BATCH UC00649 EXP 01/28 MRP 429.10
Terms and Conditions apply
Grand Total: 15547.01
Authorized Signatory
`;

const oldParser = require("./ocr/shared-parser.js");
const OldParser = global.window.OCRSharedParser;
delete global.window.OCRSharedParser;

const newParser = require("./shared-parser.js");
const NewParser = global.window.OCRSharedParser;

const oldResult = OldParser.parseLocalText(sampleRawText, "bill", { fallbackSupplier: "LPH Pharma" });
const newResult = NewParser.parseLocalText(sampleRawText, "bill", { fallbackSupplier: "LPH Pharma" });

console.log("=== OLD parser (ocr/shared-parser.js -- currently loaded) ===");
console.log(`Items extracted: ${oldResult.items.length}`);
oldResult.items.forEach((it, i) => console.log(`  ${i + 1}. "${it.medicine_name}"`));

console.log("\n=== NEW parser (shared-parser.js -- orphaned, not loaded) ===");
console.log(`Items extracted: ${newResult.items.length}`);
newResult.items.forEach((it, i) => console.log(`  ${i + 1}. "${it.medicine_name}"`));

console.log("\n=== Verdict ===");
const oldGarbage = oldResult.items.filter(it => /TOWERS|PAGE|GRAND TOTAL|SIGNATORY|TAX INVOICE|KASTOORI MEDICALS/i.test(it.medicine_name));
const newGarbage = newResult.items.filter(it => /TOWERS|PAGE|GRAND TOTAL|SIGNATORY|TAX INVOICE|KASTOORI MEDICALS/i.test(it.medicine_name));
console.log(`OLD parser garbage rows: ${oldGarbage.length} (root cause confirmed if > 0)`);
console.log(`NEW parser garbage rows: ${newGarbage.length} (fix confirmed if 0)`);
const newHasRoseday = newResult.items.some(it => /ROSEDAY/i.test(it.medicine_name));
const newHasGlucored = newResult.items.some(it => /GLUCORED/i.test(it.medicine_name));
console.log(`NEW parser still extracts real medicines: ROSEDAY=${newHasRoseday}, GLUCORED=${newHasGlucored}`);
