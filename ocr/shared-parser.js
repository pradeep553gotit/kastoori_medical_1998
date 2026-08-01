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

    function parseLocalText(text, type, options = {}) {
        const lines = cleanLines(text);
        const items = [];
        lines.forEach(line => {
            const item = type === "bill" ? parseBillLine(line, options.fallbackSupplier) : parseOrderLine(line);
            if (item) items.push(item);
        });

        if (type === "bill") {
            return {
                supplier_name: options.fallbackSupplier || "",
                invoice_number: "",
                invoice_date: "",
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
