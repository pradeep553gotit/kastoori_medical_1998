/**
 * ocr/shared-parser.js
 * ------------------------------------------------------------------
 * Priority 3.11, Requirement 3 -- Shared Parsing Pipeline.
 *
 * Gemini already returns structured JSON matching the app's existing
 * schemas (see the prompts in parseOrderSheet/parseSupplierBill).
 * Local OCR (Tesseract) only returns plain recognized text. This
 * module is the ONE place that turns that plain text into the exact
 * same raw shape Gemini would have produced, so that:
 *   - normalizeOCRResponse(parsed, type)
 *   - validateOCRFields(item, type, fallbackSupplier)
 *   - the whole medicine-matching / manual-review / import pipeline
 * never need to know or care which provider produced the data.
 *
 * This is a best-effort heuristic line parser, NOT an LLM. Local OCR
 * is only ever used as an emergency fallback (Gemini quota/timeout/
 * outage/offline) -- so every field it produces is deliberately
 * capped at a moderate-to-low confidence. That is intentional: it
 * ensures the EXISTING confidence gates (validateExtractedItem's
 * combinedConf < 80 => "manual_review", already shipped and unchanged
 * by this work) reliably route locally-parsed rows to staff for
 * confirmation instead of silently auto-importing a heuristic guess.
 *
 * Exposes: window.OCRSharedParser.parseLocalText(text, type)
 */
(function (global) {
    "use strict";

    const STRENGTH_UNIT_RE = /(\d+(?:\.\d+)?)\s*(MG|MCG|ML|G|IU|%)\b/i;
    const PACK_RE = /(\d+)\s*['’]?S\b/i;
    const TRAILING_QTY_RE = /(\d+)\s*$/;
    const BATCH_RE = /\b(?:BATCH|B\.?NO\.?)[:\s]*([A-Z0-9\-\/]{3,15})\b/i;
    const EXPIRY_RE = /\b(0[1-9]|1[0-2])\s*[\/\-]\s*(\d{2}|\d{4})\b/;
    const MRP_RE = /\bM\.?R\.?P\.?[:\s]*₹?\s*(\d+(?:\.\d+)?)/i;
    const GST_RE = /\bG\.?S\.?T\.?[:\s]*(\d+(?:\.\d+)?)\s*%?/i;
    const CURRENCY_RE = /₹?\s*(\d+(?:\.\d{1,2})?)\b/;
    const DOSAGE_FORM_RE = /\b(TABLET|TABLETS|TAB|TABS|CAPSULE|CAPSULES|CAP|CAPS|SYRUP|SYP|SUSPENSION|SUSP|INJECTION|INJ|DROPS?|GEL|CREAM|OINTMENT|LOTION|SPRAY|INHALER|ROTACAPS?|RESPULES?)\b/i;
    const PHONE_RE = /\b(?:\+?91[\s-]?)?[6-9]\d{9}\b|\b(?:PHONE|MOBILE|PH|TEL)[:\s-]*\d/i;
    const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const ADDRESS_RE = /\b(STREET|ROAD|RD\.?|NAGAR|COLONY|BUILDING|TOWER|FLOOR|CHENNAI|TAMIL\s*NADU|PIN\s*CODE|PINCODE)\b/i;

    function cleanLines(text) {
        return (text || "")
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l.length > 2 && /[A-Za-z]/.test(l));
    }

    // Local-OCR confidence is deliberately conservative (see header).
    // A field that pattern-matched cleanly still only reaches 65; a
    // field we had to guess at (e.g. no strength found) drops to 35.
    function fieldConf(matched) { return matched ? 65 : 35; }

    function parseOrderLine(line) {
        let working = line;

        const strengthMatch = working.match(STRENGTH_UNIT_RE);
        let strength = "", unit = "MG";
        if (strengthMatch) {
            strength = strengthMatch[1];
            unit = strengthMatch[2].toUpperCase();
            working = working.replace(strengthMatch[0], " ");
        }

        const packMatch = working.match(PACK_RE);
        let pack = "";
        if (packMatch) {
            pack = packMatch[1];
            working = working.replace(packMatch[0], " ");
        }

        let quantity_tablets = 0;
        const qtyMatch = working.match(TRAILING_QTY_RE);
        if (qtyMatch) {
            quantity_tablets = parseInt(qtyMatch[1], 10);
            working = working.replace(TRAILING_QTY_RE, "");
        }

        const dosageFormMatch = working.match(/\b(TABLET|CAPSULE|ROTACAP|SYRUP|SUSPENSION|INJECTION|DROPS|GEL|CREAM|OINTMENT|LOTION|OIL|POWDER|TUBE|SPRAY|INHALER|TAB|CAP)\b/i);
        const dosage_form = dosageFormMatch
            ? (dosageFormMatch[1].toUpperCase() === "TAB" ? "TABLET" : dosageFormMatch[1].toUpperCase() === "CAP" ? "CAPSULE" : dosageFormMatch[1].toUpperCase())
            : "TABLET";
        if (dosageFormMatch) working = working.replace(dosageFormMatch[0], " ");

        const medicine_name = working.replace(/[^A-Za-z0-9\s\-]/g, " ").replace(/\s+/g, " ").trim();
        if (!medicine_name) return null;

        return {
            medicine_name,
            strength,
            unit,
            dosage_form,
            pack,
            quantity_tablets,
            confidence: {
                brand: fieldConf(medicine_name.length > 3),
                strength: fieldConf(!!strengthMatch),
                pack: fieldConf(!!packMatch)
            }
        };
    }

    function parseBillLine(line, fallbackSupplier) {
        let working = line;

        const batchMatch = working.match(BATCH_RE);
        const looseBatchMatch = working.match(/\b[A-Z]{1,4}\d[A-Z0-9\-\/]{2,14}\b/);
        const batch_number = batchMatch ? batchMatch[1] : (looseBatchMatch ? looseBatchMatch[0] : null);

        const expiryMatch = working.match(EXPIRY_RE);
        let expiry_date = null;
        if (expiryMatch) {
            const yr = expiryMatch[2].length === 2 ? "20" + expiryMatch[2] : expiryMatch[2];
            expiry_date = `${expiryMatch[1]}/${yr}`;
        }

        const mrpMatch = working.match(MRP_RE) || working.match(CURRENCY_RE);
        const mrp = mrpMatch ? parseFloat(mrpMatch[1]) : null;

        const gstMatch = working.match(GST_RE);
        const gst_percent = gstMatch ? `${gstMatch[1]}%` : "5%";

        const strengthMatch = working.match(STRENGTH_UNIT_RE);
        const strength = strengthMatch ? strengthMatch[1] : "";
        const packMatch = working.match(PACK_RE);
        const qtyMatch = working.match(/\b(\d{1,5})\b(?=\s+(?:\d+(?:\.\d{1,2})|₹|MRP|M\.R\.P))/i);
        const quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

        if (!isPlausibleBillTableRow(working, {
            batch_number,
            expiry_date,
            mrp,
            strength,
            pack_size: packMatch ? packMatch[0] : null,
            quantity
        })) {
            return null;
        }

        let stripped = working;
        if (batchMatch) stripped = stripped.replace(batchMatch[0], " ");
        if (!batchMatch && looseBatchMatch) stripped = stripped.replace(looseBatchMatch[0], " ");
        if (expiryMatch) stripped = stripped.replace(expiryMatch[0], " ");
        if (mrpMatch) stripped = stripped.replace(mrpMatch[0], " ");
        if (gstMatch) stripped = stripped.replace(gstMatch[0], " ");
        if (packMatch) stripped = stripped.replace(packMatch[0], " ");
        if (qtyMatch) stripped = stripped.replace(qtyMatch[0], " ");
        const medicine_name = stripped.replace(/[^A-Za-z0-9\s\-]/g, " ").replace(/\s+/g, " ").trim();
        if (!medicine_name) return null;

        return {
            medicine_name,
            brand_name: medicine_name,
            batch_number,
            expiry_date,
            pack_size: packMatch ? packMatch[0].toUpperCase().replace(/\s+/g, "") : null,
            quantity,
            free_qty: 0,
            discount_percent: "0%",
            purchase_rate: mrp !== null ? Math.round((mrp / 1.4) * 100) / 100 : null,
            mrp,
            gst_percent,
            supplier_name: fallbackSupplier || null,
            confidence_score: 55, // capped low -- see header note
            field_confidence: {
                brand_name: fieldConf(true),
                strength: fieldConf(!!strengthMatch),
                batch_number: fieldConf(!!batch_number),
                expiry_date: fieldConf(!!expiryMatch),
                pack_size: fieldConf(!!packMatch),
                quantity: fieldConf(quantity !== null),
                mrp: fieldConf(!!mrpMatch)
            }
        };
    }

    function isPlausibleBillTableRow(line, fields) {
        if (!line || PHONE_RE.test(line) || EMAIL_RE.test(line) || ADDRESS_RE.test(line)) return false;
        if (NOISE_LINE_RE.test(line)) return false;
        if (/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d\b/i.test(line)) return false; // GSTIN/PAN-like tax id, not a row.

        const hasBatch = !!fields.batch_number;
        const hasExpiry = !!fields.expiry_date;
        const hasPrice = fields.mrp !== null && !isNaN(fields.mrp);
        const hasStrength = !!fields.strength;
        const hasPack = !!fields.pack_size;
        const hasQty = fields.quantity !== null && !isNaN(fields.quantity) && fields.quantity > 0;
        const hasDosage = DOSAGE_FORM_RE.test(line);
        const tableSignals = [hasBatch, hasExpiry, hasPrice, hasStrength, hasPack, hasQty, hasDosage].filter(Boolean).length;

        // Supplier bill rows need a row-like combination of batch/expiry/price
        // plus medicine cues. Loose letterhead or address text must not become
        // inventory candidates just because OCR saw a number nearby.
        if (!hasExpiry || !hasPrice) return false;
        if (!hasBatch && !(hasStrength && (hasPack || hasDosage))) return false;
        if (tableSignals < 4) return false;

        const letters = (line.match(/[A-Za-z]/g) || []).length;
        const digits = (line.match(/\d/g) || []).length;
        if (letters < 4 || digits < 4) return false;

        return true;
    }

    // Lines that are clearly invoice header/footer/GST-summary noise, not
    // medicine rows -- real supplier bills always have several of these,
    // and the old line-by-line parser had no way to tell them apart from
    // a medicine row, so they were pushed into `items` as garbage. This is
    // a keyword denylist, not a layout/table detector (a real table
    // detector is a much larger feature -- see header note on this
    // module's scope) but it removes the single biggest source of
    // obviously-wrong "items" cheaply and safely.
    const NOISE_LINE_RE = /\b(GSTIN|GST NO|PAN NO|CIN NO|BANK|IFSC|A\/C NO|ACCOUNT NO|TERMS?\s*(AND|&)?\s*CONDITIONS|DECLARATION|SIGNATORY|SIGNATURE|E\s*&\s*O\s*E|SUBJECT TO .* JURISDICTION|AMOUNT IN WORDS|GRAND TOTAL|SUB\s*TOTAL|TOTAL AMOUNT|NET AMOUNT|ROUND\s*OFF|RECEIVED BY|DELIVERY (CHALLAN|NOTE)|THANK YOU|PAGE\s*\d+\s*OF\s*\d+|(INVOICE|BILL)\s*(NO|NUMBER|DATE)|S(R)?\.?\s*NO\b|PARTICULARS?)\b/i;

    // Order-sheet-specific noise: a hospital/ward order sheet carries an
    // entirely different set of irrelevant fields than a supplier bill
    // (patient/doctor/ward identifiers instead of GST/bank/terms). Kept as
    // its own list rather than folded into NOISE_LINE_RE so bill parsing
    // behavior is untouched -- these keywords only ever apply to type
    // "order", never "bill".
    const ORDER_NOISE_RE = /\b(PATIENT\s*(NAME|ID|NO|CODE|NUMBER)?|DOCTOR|DR\.?\s*NAME|NURSE|WARD\s*(NO)?|ROOM\s*(NO)?|BED\s*(NO)?|CONSULTANT|ADMISSION|DISCHARGE|DIAGNOSIS|PRESCRIB(ED|ING))\b/i;

    // Marks the point in a bill's raw text where the medicine table has
    // ended -- everything at or after this line (grand total, terms, bank
    // details, signature block) is footer, even if a later footer line
    // doesn't itself match NOISE_LINE_RE (e.g. an address line sitting
    // right under "Thank you for your business" has no keyword of its
    // own). Per-line noise filtering alone can't express "and stop
    // entirely from here on", so table-end detection is a separate,
    // one-way cutoff applied only to the bill item loop.
    const TABLE_END_RE = /\b(GRAND\s*TOTAL|SUB\s*TOTAL|TOTAL AMOUNT|NET AMOUNT|TERMS?\s*(AND|&)?\s*CONDITIONS|DECLARATION|THANK YOU|RECEIVED BY|AUTHORIZED SIGNATORY)\b/i;

    // A crude but effective sanity check for the OCR-garbling failure mode
    // seen on real bills (Tesseract mis-segmenting a table into strings of
    // 1-3 letter pseudo-tokens, e.g. "TARAM AO I PEER WE 7 7"). A real
    // medicine name is normally a small number of real words; a garbled
    // line is mostly very short fragments. This does not attempt to
    // RECONSTRUCT the text (a safe, general reconstruction of arbitrary
    // OCR fragmentation isn't something a regex pass can do reliably) --
    // it only decides whether to trust the field at a normal confidence
    // or flag it as low-confidence so the existing manual-review gate
    // (validateExtractedItem's combinedConf < 80) catches it instead of
    // silently importing junk.
    function looksGarbled(name) {
        if (!name) return true;
        const tokens = name.split(/\s+/).filter(Boolean);
        if (tokens.length < 2) return false; // single-token names are normal, not a fragmentation symptom
        const shortTokenRatio = tokens.filter(t => t.length <= 2).length / tokens.length;
        return shortTokenRatio > 0.5; // more than half the "words" are 1-2 characters
    }

    function isNoiseLine(line, type) {
        if (NOISE_LINE_RE.test(line)) return true;
        if (type === "order" && ORDER_NOISE_RE.test(line)) return true;
        // A line that's almost entirely digits/punctuation (e.g. a lone
        // totals figure, a page number) is never a medicine row on its own.
        const letters = (line.match(/[A-Za-z]/g) || []).length;
        if (letters < 3) return true;
        // A short line with NO digits anywhere (e.g. a letterhead/company
        // name line, a section title) is almost never a real medicine row
        // -- real rows carry at least one of batch/expiry/pack/qty/price.
        const wordCount = line.trim().split(/\s+/).length;
        const hasDigit = /\d/.test(line);
        return wordCount <= 3 && !hasDigit;
    }

    // Best-effort extraction of invoice header fields from the FULL raw
    // OCR text (not per-line), since these fields can appear anywhere in
    // the first several lines of a real bill and the old parser left them
    // permanently blank/fallback. Any field this can't find stays null/
    // fallback exactly as before -- this only adds coverage, it never
    // removes the existing fallback behavior.
    const INVOICE_NO_RE = /\b(?:INVOICE|BILL)\s*(?:NO|NUMBER|#)?[:\s.\-]*([A-Z0-9\/\-]{3,20})\b/i;
    const INVOICE_DATE_RE = /\b(?:INVOICE|BILL)\s*DATE[:\s.\-]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/i;
    const PURCHASE_DATE_RE = /\bPURCHASE\s*DATE[:\s.\-]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/i;
    const GENERIC_DATE_RE = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/;
    // Indian GSTIN format: 2-digit state code + 10-char PAN + 1 entity code
    // + Z + 1 checksum char, e.g. "33ABCDE1234F1Z5".
    const GSTIN_RE = /\b(\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d)\b/i;
    const GRAND_TOTAL_RE = /\bGRAND\s*TOTAL[:\s.\-]*₹?\s*(\d+(?:,\d{2,3})*(?:\.\d{1,2})?)/i;
    const TAX_AMOUNT_RE = /\b(?:TAX|GST)\s*AMOUNT[:\s.\-]*₹?\s*(\d+(?:,\d{2,3})*(?:\.\d{1,2})?)/i;
    const DISCOUNT_AMOUNT_RE = /\bDISCOUNT(?:\s*AMOUNT)?[:\s.\-]*₹?\s*(\d+(?:,\d{2,3})*(?:\.\d{1,2})?)/i;
    const TOTAL_ITEMS_RE = /\bTOTAL\s*ITEMS?[:\s.\-]*(\d+)\b/i;

    function toIsoDate(raw) {
        if (!raw) return null;
        const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        if (!m) return null;
        let [, d, mo, y] = m;
        if (y.length === 2) y = "20" + y;
        d = d.padStart(2, "0"); mo = mo.padStart(2, "0");
        return `${y}-${mo}-${d}`;
    }

    function toNumber(raw) {
        if (!raw) return null;
        const n = parseFloat(raw.replace(/,/g, ""));
        return isNaN(n) ? null : n;
    }

    function extractHeaderFields(text) {
        const invoiceNoMatch = text.match(INVOICE_NO_RE);
        const invoiceDateMatch = text.match(INVOICE_DATE_RE) || text.match(GENERIC_DATE_RE);
        const purchaseDateMatch = text.match(PURCHASE_DATE_RE);
        const gstinMatch = text.match(GSTIN_RE);
        const grandTotalMatch = text.match(GRAND_TOTAL_RE);
        const taxAmountMatch = text.match(TAX_AMOUNT_RE);
        const discountMatch = text.match(DISCOUNT_AMOUNT_RE);
        const totalItemsMatch = text.match(TOTAL_ITEMS_RE);
        return {
            invoice_number: invoiceNoMatch ? invoiceNoMatch[1] : "",
            invoice_date: invoiceDateMatch ? (toIsoDate(invoiceDateMatch[1]) || "") : "",
            purchase_date: purchaseDateMatch ? (toIsoDate(purchaseDateMatch[1]) || "") : "",
            supplier_gst_number: gstinMatch ? gstinMatch[1].toUpperCase() : "",
            grand_total: toNumber(grandTotalMatch ? grandTotalMatch[1] : null),
            tax_amount: toNumber(taxAmountMatch ? taxAmountMatch[1] : null),
            discount_amount: toNumber(discountMatch ? discountMatch[1] : null),
            total_items: totalItemsMatch ? parseInt(totalItemsMatch[1], 10) : null
        };
    }

    function parseLocalText(text, type, options = {}) {
        const rawLines = cleanLines(text);
        const items = [];
        for (const line of rawLines) {
            // Table-end cutoff (bill only): once we hit the totals/terms/
            // signature block, everything from here on is footer -- stop
            // considering further lines as medicine rows entirely, rather
            // than relying on each individual line matching a noise
            // keyword (an address or blank-ish line right after "Grand
            // Total" has no keyword of its own to be caught by).
            if (type === "bill" && TABLE_END_RE.test(line)) break;
            if (isNoiseLine(line, type)) continue;

            const item = type === "bill" ? parseBillLine(line, options.fallbackSupplier) : parseOrderLine(line);
            if (!item) continue;

            if (type === "bill" && looksGarbled(item.medicine_name)) {
                // Don't silently drop it (a real, oddly-formatted name could
                // trip this heuristic too) -- just force it into manual
                // review instead of trusting it like a normal 55-confidence
                // local read.
                item.confidence_score = 15;
                item.field_confidence = Object.assign({}, item.field_confidence, { brand_name: 15 });
                item.needsReview = true;
            }
            if (type === "order") {
                // Empty rows (spec: ignore "Empty Rows") -- a row with no
                // quantity and nothing else useful extracted is noise, not
                // a real order line.
                if (!item.quantity_tablets && !item.strength && !item.pack) continue;
                if (looksGarbled(item.medicine_name)) {
                    item.confidence.brand = Math.min(item.confidence.brand, 15);
                    item.needsReview = true;
                }
            }
            items.push(item);
        }

        if (type === "bill") {
            const header = extractHeaderFields(text);
            return {
                supplier_name: options.fallbackSupplier || "",
                invoice_number: header.invoice_number,
                invoice_date: header.invoice_date,
                purchase_date: header.purchase_date,
                supplier_gst_number: header.supplier_gst_number,
                grand_total: header.grand_total,
                tax_amount: header.tax_amount,
                discount_amount: header.discount_amount,
                total_items: header.total_items,
                items,
                confidence_score: items.length ? Math.round(items.reduce((a, i) => a + i.confidence_score, 0) / items.length) : 0
            };
        }
        return {
            dispensary_id: "",
            dispensary_name: "",
            items
        };
    }

    global.OCRSharedParser = { parseLocalText };
})(typeof window !== "undefined" ? window : globalThis);
