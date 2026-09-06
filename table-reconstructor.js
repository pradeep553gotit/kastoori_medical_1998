/**
 * ocr/table-reconstructor.js
 * ------------------------------------------------------------------
 * Root-cause fix for "OCR reads real text but the parser turns nearly
 * every line into a fake medicine row" (see repo history: 49-row and
 * 62-row false-positive scans).
 *
 * Tesseract.js's `.text` output is produced by Tesseract's own guess at
 * paragraph/line order. On a real multi-column invoice table that guess
 * is frequently wrong -- words from different columns get interleaved
 * or split across lines in an order that has nothing to do with the
 * actual table row they belong to. No amount of regex cleanup on that
 * flattened text can recover the real row boundaries, because the
 * information needed (which words share a table row) was already lost
 * when it got flattened to one string.
 *
 * Tesseract.js DOES give us what we need to reconstruct rows correctly:
 * `result.data.words`, an array of { text, confidence, bbox:{x0,y0,x1,y1} }
 * for every recognized word, independent of Tesseract's own line/block
 * guessing. This module clusters those words back into rows using their
 * actual Y position on the page (a real table row is a set of words
 * that are all roughly the same height on the page), which is a strictly
 * more reliable signal than trusting Tesseract's text order.
 *
 * This does NOT do full column detection (product name vs pack vs batch
 * vs MRP as separate fields by X position) -- that is a larger feature
 * that needs real invoice samples to tune column boundaries against,
 * and guessing it blind risks a differently-wrong parser. What this DOES
 * do, safely and immediately:
 *   1. Group words into rows by real page position (fixes interleaving).
 *   2. Reject any row that reads like header/footer/GST/bank noise.
 *   3. Reject any row that doesn't carry at least 2 independent medicine-
 *      row signals (batch-like token, date-like token, a decimal price,
 *      an integer quantity) -- so OCR finding text somewhere on the page
 *      is no longer sufficient, by itself, to manufacture a "medicine".
 *
 * This is the reason the 49/62-fake-row failures happened: the old
 * pipeline created a candidate for every line that survived basic
 * cleanup, with no check that the line actually looked like a table row
 * at all.
 */
(function (global) {
    "use strict";

    const NOISE_ROW_RE = /\b(GSTIN|GST\s*NO|GST\s*AMOUNT|PAN NO|CIN NO|BANK|IFSC|A\/C NO|ACCOUNT NO|TERMS?\s*(AND|&)?\s*CONDITIONS|DECLARATION|SIGNATORY|SIGNATURE|E\s*&\s*O\s*E|SUBJECT TO .* JURISDICTION|AMOUNT IN WORDS|GRAND TOTAL|SUB\s*TOTAL|TOTAL AMOUNT|NET AMOUNT|ROUND\s*OFF|RECEIVED BY|DELIVERY (CHALLAN|NOTE)|THANK YOU|PAGE\s*\d+\s*OF\s*\d+|PHONE|MOBILE|E-?MAIL|WEBSITE|(INVOICE|BILL)\s*(NO|NUMBER|DATE)|CUSTOMER|ADDRESS)\b/i;

    // Independent evidence signals a real medicine row normally carries.
    // A header/footer/decorative line essentially never has 2+ of these
    // at once, which is what makes this a much stronger gate than
    // "does this line have any digit at all".
    const DATE_RE = /\b\d{1,2}[\/\-]\d{2,4}\b/;              // batch expiry MM/YY or MM/YYYY
    const DECIMAL_RE = /\b\d+\.\d{1,2}\b/;                    // a price (MRP/rate/amount)
    const INTEGER_RE = /\b\d{1,4}\b/;                         // a plausible quantity
    const BATCH_LIKE_RE = /\b(?=[A-Z0-9]{4,10}\b)(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,10}\b/; // alnum mix, e.g. "B123X"

    function countSignals(rowText) {
        let signals = 0;
        if (DATE_RE.test(rowText)) signals++;
        if (DECIMAL_RE.test(rowText)) signals++;
        if (BATCH_LIKE_RE.test(rowText)) signals++;
        if (INTEGER_RE.test(rowText)) signals++;
        return signals;
    }

    function median(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * Groups Tesseract.js word boxes into rows by Y-center proximity.
     * words: [{ text, confidence, bbox:{x0,y0,x1,y1} }, ...]
     * Returns: [{ text, wordCount, avgConfidence }, ...] in top-to-bottom order.
     */
    function reconstructRows(words) {
        const valid = (words || []).filter(w => w && w.text && w.text.trim() && w.bbox);
        if (!valid.length) return [];

        const heights = valid.map(w => w.bbox.y1 - w.bbox.y0).filter(h => h > 0);
        const rowTolerance = heights.length ? median(heights) * 0.6 : 8;

        const withCenters = valid
            .map(w => ({ ...w, yCenter: (w.bbox.y0 + w.bbox.y1) / 2 }))
            .sort((a, b) => a.yCenter - b.yCenter);

        const rows = [];
        let current = [];
        let currentY = null;
        withCenters.forEach(w => {
            if (currentY === null || Math.abs(w.yCenter - currentY) <= rowTolerance) {
                current.push(w);
                // Running average keeps the row's reference Y stable even
                // as it grows, instead of drifting off the first word.
                currentY = current.reduce((sum, x) => sum + x.yCenter, 0) / current.length;
            } else {
                rows.push(current);
                current = [w];
                currentY = w.yCenter;
            }
        });
        if (current.length) rows.push(current);

        return rows.map(row => {
            const sorted = [...row].sort((a, b) => a.bbox.x0 - b.bbox.x0);
            return {
                text: sorted.map(w => w.text).join(" ").replace(/\s+/g, " ").trim(),
                wordCount: sorted.length,
                avgConfidence: Math.round(sorted.reduce((s, w) => s + (w.confidence || 0), 0) / sorted.length)
            };
        }).filter(r => r.text.length > 0);
    }

    /**
     * Full pipeline: bounding-box words -> filtered, signal-gated medicine
     * candidate row strings, ready to hand to the existing per-line field
     * parser (parseBillLine / parseOrderLine) exactly as before -- this
     * module only decides WHICH lines are worth parsing, it does not
     * change how a line's fields get extracted.
     */
    function getMedicineCandidateRows(words, { minSignals = 2 } = {}) {
        const rows = reconstructRows(words);
        return rows.filter(row => {
            if (NOISE_ROW_RE.test(row.text)) return false;
            if (countSignals(row.text) < minSignals) return false;
            return true;
        });
    }

    global.OCRTableReconstructor = { reconstructRows, getMedicineCandidateRows, countSignals };
})(typeof window !== "undefined" ? window : globalThis);
