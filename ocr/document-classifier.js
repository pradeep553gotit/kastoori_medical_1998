/**
 * ocr/document-classifier.js
 * ------------------------------------------------------------------
 * Phase A -- shared foundation. Given raw recognized text (from either
 * provider), decides whether the document is a Supplier Bill or an
 * Order Sheet, so the ScanningEngine can route it to the right
 * dedicated pipeline (Phase B / Phase C -- not built yet).
 *
 * This is a keyword/structure scoring classifier, not a trained model.
 * It is intentionally conservative: if the signal is weak or the two
 * scores are close, it returns "unknown" rather than guessing, because
 * routing a bill through the order pipeline (or vice versa) would
 * silently produce wrong structured data. An "unknown" result should
 * be surfaced to the user to pick manually -- never auto-guessed.
 *
 * Exposes: window.DocumentClassifier.classify(text)
 *   -> { type: "bill" | "order" | "unknown", confidence, signals: {bill, order} }
 */
(function (global) {
    "use strict";

    // Signals strongly associated with a supplier purchase invoice.
    const BILL_SIGNALS = [
        { re: /\bG\.?S\.?T\.?\b/i, weight: 3 },
        { re: /\bM\.?R\.?P\.?\b/i, weight: 3 },
        { re: /\bBATCH\b|\bB\.?NO\.?\b/i, weight: 3 },
        { re: /\bINVOICE\b|\bBILL\s*NO\b|\bTAX\s+INVOICE\b/i, weight: 4 },
        { re: /\bHSN\b/i, weight: 3 },
        { re: /\bDISCOUNT\b|\bDISC\.?\s*%/i, weight: 2 },
        { re: /\bPURCHASE\s+RATE\b|\bRATE\b/i, weight: 1 },
        { re: /\bDISTRIBUTOR|\bWHOLESALER|\bPHARMA\s+DISTRIB/i, weight: 2 },
        { re: /\bGSTIN\b/i, weight: 3 },
        { re: /\bE-?WAY\s*BILL\b/i, weight: 2 },
        { re: /₹|\bRS\.?\s*\d/i, weight: 1 }
    ];

    // Signals strongly associated with a government/dispensary order sheet.
    const ORDER_SIGNALS = [
        { re: /\bDISPENSARY\b/i, weight: 4 },
        { re: /\bORDER\s+SHEET\b|\bINDENT\b|\bREQUISITION\b/i, weight: 4 },
        { re: /\bREQUIRED\s+QUANTITY\b|\bQTY\s+REQUIRED\b|\bQUANTITY\s+REQUIRED\b/i, weight: 3 },
        { re: /\bGOVT\.?\b|\bGOVERNMENT\b|\bPHC\b|\bCHC\b/i, weight: 3 },
        { re: /\bMEDICAL\s+OFFICER\b|\bDRUG\s+STORE\b/i, weight: 2 },
        { re: /\bSTOCK\s+ON\s+HAND\b|\bBALANCE\s+STOCK\b/i, weight: 2 },
        { re: /\bINDENT\s+NO\b|\bDISPENSARY\s+ID\b/i, weight: 3 }
    ];

    // Signals that are noise for classification purposes and should be
    // ignored entirely (per the spec's "ignore addresses, signatures,
    // notes, bank details..." instruction for the order pipeline) -- kept
    // here only as a documented non-signal list, not stripped from text.
    // (Actual stripping is a Phase C parsing concern, not classification.)

    function score(text, signals) {
        let total = 0;
        const matched = [];
        signals.forEach(({ re, weight }) => {
            if (re.test(text)) { total += weight; matched.push(re.source); }
        });
        return { total, matched };
    }

    function classify(text) {
        const safeText = text || "";
        const billScore = score(safeText, BILL_SIGNALS);
        const orderScore = score(safeText, ORDER_SIGNALS);

        const total = billScore.total + orderScore.total;
        if (total === 0) {
            return { type: "unknown", confidence: 0, signals: { bill: billScore, order: orderScore } };
        }

        const diff = Math.abs(billScore.total - orderScore.total);
        // Require a clear margin, not just "slightly ahead" -- a tie or
        // near-tie means the classifier isn't sure, and unsure should
        // mean "ask the user", not "flip a coin".
        if (diff < 3) {
            return {
                type: "unknown",
                confidence: Math.round((Math.max(billScore.total, orderScore.total) / (total || 1)) * 50),
                signals: { bill: billScore, order: orderScore }
            };
        }

        const winner = billScore.total > orderScore.total ? "bill" : "order";
        const confidence = Math.min(95, Math.round((Math.max(billScore.total, orderScore.total) / total) * 100));
        return { type: winner, confidence, signals: { bill: billScore, order: orderScore } };
    }

    global.DocumentClassifier = { classify };
})(typeof window !== "undefined" ? window : globalThis);
