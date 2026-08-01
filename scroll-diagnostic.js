/* ============================================================
   TEMPORARY DIAGNOSTIC TOOL — NOT A FIX
   ------------------------------------------------------------
   Purpose: capture real evidence of what happens on a touch/scroll
   attempt, directly on the phone, without needing remote DevTools.

   What it does:
   - Draws a small floating panel (bottom-right corner) that logs
     every touchstart/touchmove/touchend it sees.
   - For each event, records: the exact element touched, whether
     preventDefault() was called on it (defaultPrevented), and the
     computed overflow / touch-action / pointer-events / position
     of that element and every ancestor up to <body>.
   - Also shows document.scrollingElement's scrollHeight vs
     clientHeight, so we can see whether the page even *has*
     scrollable content on the page you're testing.
   - Has a "Copy Report" button that puts the full JSON log on the
     clipboard so it can be pasted straight into chat.

   It does NOT modify any scroll behavior, does NOT call
   preventDefault anywhere, and does NOT send any data over the
   network — everything stays in the browser, purely for reading.

   HOW TO REMOVE once we're done: delete the <script src="scroll-
   diagnostic.js"> line from index.html and redeploy. This file
   should never ship as part of the real production app long-term.
   ============================================================ */
(function () {
    if (window.__scrollDiag) return; // avoid double-init
    window.__scrollDiag = true;

    const log = [];
    const MAX_LOG = 40;

    function describeChain(el) {
        const chain = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 25) {
            const cs = getComputedStyle(node);
            chain.push({
                tag: node.tagName,
                id: node.id || undefined,
                cls: (node.className && node.className.toString) ? node.className.toString().slice(0, 60) : undefined,
                overflow: cs.overflow,
                overflowY: cs.overflowY,
                overflowX: cs.overflowX,
                touchAction: cs.touchAction,
                pointerEvents: cs.pointerEvents,
                position: cs.position,
                transform: cs.transform !== "none" ? cs.transform : undefined,
                height: cs.height,
                maxHeight: cs.maxHeight !== "none" ? cs.maxHeight : undefined
            });
            if (node === document.body) break;
            node = node.parentElement;
        }
        return chain;
    }

    function record(type, e) {
        const se = document.scrollingElement;
        const entry = {
            time: new Date().toISOString().slice(11, 23),
            type: type,
            defaultPrevented: e.defaultPrevented,
            targetTag: e.target.tagName,
            targetId: e.target.id || undefined,
            targetCls: (e.target.className && e.target.className.toString) ? e.target.className.toString().slice(0, 60) : undefined,
            scrollingElement: se ? se.tagName : null,
            scrollHeight: se ? se.scrollHeight : null,
            clientHeight: se ? se.clientHeight : null,
            scrollTop: se ? se.scrollTop : null,
            chain: describeChain(e.target)
        };
        log.push(entry);
        if (log.length > MAX_LOG) log.shift();
        render();
    }

    ["touchstart", "touchmove", "touchend"].forEach(function (type) {
        document.addEventListener(type, function (e) { record(type, e); }, { capture: true, passive: true });
    });

    // ---- floating panel UI ----
    const panel = document.createElement("div");
    panel.id = "__scroll_diag_panel";
    panel.style.cssText = [
        "position:fixed", "bottom:8px", "right:8px", "z-index:999999",
        "width:min(94vw,360px)", "max-height:60vh", "overflow:auto",
        "background:rgba(10,14,24,0.95)", "color:#e6f1ff",
        "font:11px/1.4 monospace", "padding:8px", "border-radius:8px",
        "border:1px solid #00f2fe", "box-shadow:0 4px 20px rgba(0,0,0,0.5)",
        "touch-action:pan-y" // deliberately allow scrolling the panel itself
    ].join(";");

    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;";
    header.innerHTML = '<b style="color:#00f2fe">Scroll Diagnostic</b>';

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy Report";
    copyBtn.style.cssText = "background:#00f2fe;color:#000;border:none;border-radius:4px;padding:4px 8px;font-weight:700;font-size:11px;";
    copyBtn.onclick = function () {
        const text = JSON.stringify(log, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                copyBtn.textContent = "Copied!";
                setTimeout(function () { copyBtn.textContent = "Copy Report"; }, 1500);
            }).catch(function () {
                fallbackCopy(text);
            });
        } else {
            fallbackCopy(text);
        }
    };
    function fallbackCopy(text) {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); copyBtn.textContent = "Copied!"; }
        catch (err) { copyBtn.textContent = "Copy failed - select panel text manually"; }
        document.body.removeChild(ta);
    }
    header.appendChild(copyBtn);

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00d7";
    closeBtn.style.cssText = "background:none;border:none;color:#e6f1ff;font-size:16px;margin-left:6px;";
    closeBtn.onclick = function () { panel.remove(); };
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.id = "__scroll_diag_body";

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    function render() {
        const se = document.scrollingElement;
        const summary = se
            ? `scrollingElement=${se.tagName} scrollHeight=${se.scrollHeight} clientHeight=${se.clientHeight} scrollTop=${se.scrollTop} ${se.scrollHeight <= se.clientHeight ? "<< NO OVERFLOW: nothing to scroll on this page" : "(scrollable)"}`
            : "no scrollingElement found";
        const last = log.slice(-6).reverse().map(function (e) {
            const preventedFlag = e.defaultPrevented ? " \u26a0\ufe0f DEFAULT PREVENTED" : "";
            const suspects = e.chain.filter(function (c) {
                return c.touchAction === "none" || c.pointerEvents === "none" || (c.overflow === "hidden" && c.overflowY === "hidden");
            });
            const suspectText = suspects.length
                ? "\n  \u26a0\ufe0f blocking layer(s): " + suspects.map(function (s) { return (s.tag + (s.cls ? "." + s.cls.split(" ")[0] : "")); }).join(", ")
                : "";
            return `[${e.time}] ${e.type} on <${e.targetTag}${e.targetId ? "#" + e.targetId : ""}>${preventedFlag}${suspectText}`;
        }).join("\n\n");
        body.innerHTML = "<div style='margin-bottom:6px;color:#94a3b8'>" + summary + "</div><pre style='white-space:pre-wrap;margin:0'>" + (last || "Touch the screen to capture events...") + "</pre>";
    }

    render();
})();
