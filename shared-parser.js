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
        const batch_number = batchMatch ? batchMatch[1] : null;

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

        let stripped = working;
        if (batchMatch) stripped = stripped.replace(batchMatch[0], " ");
        if (expiryMatch) stripped = stripped.replace(expiryMatch[0], " ");
        if (mrpMatch) stripped = stripped.replace(mrpMatch[0], " ");
        if (gstMatch) stripped = stripped.replace(gstMatch[0], " ");
        const medicine_name = stripped.replace(/[^A-Za-z0-9\s\-]/g, " ").replace(/\s+/g, " ").trim();
        if (!medicine_name) return null;

        return {
            medicine_name,
            brand_name: medicine_name,
            batch_number,
            expiry_date,
            pack_size: null,
            quantity: null,      // deliberately left null -- quantity on a
                                  // bill line is too error-prone to guess
                                  // from plain text; forces manual entry
                                  // rather than a fabricated number.
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
                batch_number: fieldConf(!!batchMatch),
                expiry_date: fieldConf(!!expiryMatch),
                mrp: fieldConf(!!mrpMatch)
            }
        };
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
        if (tokens.length < 2) {
            // A single very short token (e.g. "ARN") is a common OCR
            // fragmentation symptom -- a real single-word medicine name is
            // almost always 5+ characters (PARACETAMOL, AMOXICILLIN, ...).
            return tokens.length === 1 && tokens[0].length <= 4;
        }
        const shortTokenRatio = tokens.filter(t => t.length <= 2).length / tokens.length;
        return shortTokenRatio > 0.5; // more than half the "words" are 1-2 characters
    }

    function isNoiseLine(line) {
        if (NOISE_LINE_RE.test(line)) return true;
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
    const GENERIC_DATE_RE = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/;

    function toIsoDate(raw) {
        if (!raw) return null;
        const m = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
        if (!m) return null;
        let [, d, mo, y] = m;
        if (y.length === 2) y = "20" + y;
        d = d.padStart(2, "0"); mo = mo.padStart(2, "0");
        return `${y}-${mo}-${d}`;
    }

    function extractHeaderFields(text) {
        const invoiceNoMatch = text.match(INVOICE_NO_RE);
        const invoiceDateMatch = text.match(INVOICE_DATE_RE) || text.match(GENERIC_DATE_RE);
        return {
            invoice_number: invoiceNoMatch ? invoiceNoMatch[1] : "",
            invoice_date: invoiceDateMatch ? (toIsoDate(invoiceDateMatch[1]) || "") : ""
        };
    }

    function parseLocalText(text, type, options = {}) {
        // Preferred path: real bounding-box-based table row reconstruction
        // (see ocr/table-reconstructor.js). This is what actually fixes the
        // root cause of the fake-row failures -- rows are only created when
        // there is real page-position AND multi-signal evidence for them,
        // instead of "OCR found a line of text, therefore it's a medicine".
        // Falls back to the old flattened-text line parser when no word
        // boxes were provided (e.g. order-sheet flow, or a caller that
        // hasn't been updated yet) -- unchanged behavior in that case.
        let candidateLines;
        if (type === "bill" && Array.isArray(options.words) && options.words.length && global.OCRTableReconstructor) {
            candidateLines = global.OCRTableReconstructor.getMedicineCandidateRows(options.words).map(r => r.text);
        } else {
            candidateLines = cleanLines(text).filter(l => !isNoiseLine(l));
        }

        const items = [];
        candidateLines.forEach(line => {
            const item = type === "bill" ? parseBillLine(line, options.fallbackSupplier) : parseOrderLine(line);
            if (!item) return;
            if (type === "bill" && looksGarbled(item.medicine_name)) {
                // Don't silently drop it (a real, oddly-formatted name could
                // trip this heuristic too) -- just force it into manual
                // review instead of trusting it like a normal 55-confidence
                // local read.
                item.confidence_score = 15;
                item.field_confidence = Object.assign({}, item.field_confidence, { brand_name: 15 });
                item.needsReview = true;
            }
            items.push(item);
        });

        if (type === "bill") {
            const header = extractHeaderFields(text);
            return {
                supplier_name: options.fallbackSupplier || "",
                invoice_number: header.invoice_number,
                invoice_date: header.invoice_date,
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
