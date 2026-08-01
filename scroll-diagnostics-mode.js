/* ============================================================
   SCROLL DIAGNOSTICS MODE — temporary, self-verifying, removable
   ------------------------------------------------------------
   Activate with: https://your-app-url/?debug=scroll
   (Any other URL, including plain production URLs used by staff,
   is completely unaffected — this file does nothing unless the
   query flag is present.)

   This file intentionally does NOT rely on you opening DevTools.
   It renders its own on-screen panel, verifies its own successful
   load, and shows an visible error state if anything about it
   fails — rather than silently doing nothing.
   ============================================================ */
(function () {
    const params = new URLSearchParams(window.location.search);
    if (params.get("debug") !== "scroll") return; // inert on every normal page load

    if (window.__scrollDiagV2) return;
    window.__scrollDiagV2 = true;

    const BUILD_INFO_URL = "./version.json";
    const state = {
        buildInfo: null,
        buildInfoError: null,
        swState: "checking...",
        events: []
    };

    // ---------- panel scaffold ----------
    const panel = document.createElement("div");
    panel.id = "__scroll_diag_v2";
    panel.style.cssText = [
        "position:fixed", "top:8px", "right:8px", "z-index:2147483647",
        "width:min(94vw,380px)", "max-height:80vh", "overflow:auto",
        "background:rgba(8,12,20,0.97)", "color:#e6f1ff",
        "font:11px/1.45 -apple-system,Roboto,monospace", "padding:10px",
        "border-radius:10px", "border:2px solid #00f2fe",
        "box-shadow:0 6px 24px rgba(0,0,0,0.6)", "touch-action:pan-y"
    ].join(";");
    document.documentElement.appendChild(panel); // documentElement, not body -- survives even if body gets swapped

    function section(title) {
        const h = document.createElement("div");
        h.textContent = title;
        h.style.cssText = "color:#00f2fe;font-weight:700;margin:8px 0 3px;border-top:1px solid #223;padding-top:6px;";
        return h;
    }

    const banner = document.createElement("div");
    banner.style.cssText = "font-weight:800;font-size:13px;color:#0f0;margin-bottom:4px;";
    banner.textContent = "\u2713 Scroll Diagnostics Enabled";
    panel.appendChild(banner);

    const loadStatus = document.createElement("div");
    loadStatus.style.cssText = "font-size:10px;color:#94a3b8;margin-bottom:4px;";
    loadStatus.textContent = "scroll-diagnostics-mode.js loaded successfully at " + new Date().toISOString();
    panel.appendChild(loadStatus);

    const versionBox = document.createElement("div");
    versionBox.textContent = "Loading version.json...";
    versionBox.style.cssText = "font-size:10px;color:#fbbf24;";
    panel.appendChild(versionBox);

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;gap:6px;margin:8px 0;";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy Diagnostic Report";
    copyBtn.style.cssText = "background:#00f2fe;color:#000;border:none;border-radius:4px;padding:5px 8px;font-weight:700;font-size:11px;flex:1;";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "\u00d7";
    closeBtn.style.cssText = "background:#333;color:#fff;border:none;border-radius:4px;padding:5px 10px;font-weight:700;";
    closeBtn.onclick = function () { panel.remove(); };
    controls.appendChild(copyBtn);
    controls.appendChild(closeBtn);
    panel.appendChild(controls);

    const staticInfo = document.createElement("pre");
    staticInfo.style.cssText = "white-space:pre-wrap;margin:4px 0;font-size:10px;";
    panel.appendChild(section("Environment"));
    panel.appendChild(staticInfo);

    const swInfo = document.createElement("pre");
    swInfo.style.cssText = "white-space:pre-wrap;margin:4px 0;font-size:10px;";
    panel.appendChild(section("Service Worker"));
    panel.appendChild(swInfo);

    const layoutInfo = document.createElement("pre");
    layoutInfo.style.cssText = "white-space:pre-wrap;margin:4px 0;font-size:10px;";
    panel.appendChild(section("Scroll / Layout State (live)"));
    panel.appendChild(layoutInfo);

    panel.appendChild(section("Touch / Scroll Events (most recent 6)"));
    const eventsInfo = document.createElement("pre");
    eventsInfo.style.cssText = "white-space:pre-wrap;margin:4px 0;font-size:10px;";
    panel.appendChild(eventsInfo);

    // ---------- version.json fetch + verification ----------
    fetch(BUILD_INFO_URL, { cache: "no-store" })
        .then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        })
        .then(function (json) {
            state.buildInfo = json;
            versionBox.style.color = "#0f0";
            versionBox.textContent = "commit=" + (json.commit || "unknown") + "  built=" + (json.builtAt || "unknown");
        })
        .catch(function (err) {
            state.buildInfoError = err.message;
            versionBox.style.color = "#ff4d4d";
            versionBox.textContent = "\u26a0\ufe0f version.json missing or failed to load (" + err.message + "). Add version.json at the site root so builds can be identified -- see HOW_TO_DEPLOY.md.";
        });

    // ---------- static environment snapshot ----------
    function renderStaticInfo() {
        staticInfo.textContent = [
            "URL: " + location.href,
            "UA: " + navigator.userAgent,
            "Viewport: " + window.innerWidth + "x" + window.innerHeight,
            "visualViewport: " + (window.visualViewport ? (window.visualViewport.width + "x" + window.visualViewport.height) : "unsupported"),
            "devicePixelRatio: " + window.devicePixelRatio,
            "display-mode standalone (installed PWA): " + window.matchMedia("(display-mode: standalone)").matches
        ].join("\n");
    }
    renderStaticInfo();
    window.addEventListener("resize", renderStaticInfo);

    // ---------- service worker state ----------
    function renderSW() {
        if (!("serviceWorker" in navigator)) {
            swInfo.textContent = "serviceWorker API not available in this browser context.";
            return;
        }
        navigator.serviceWorker.getRegistrations().then(function (regs) {
            if (!regs.length) {
                swInfo.textContent = "No service worker registered.";
                return;
            }
            const lines = regs.map(function (reg) {
                return [
                    "scope: " + reg.scope,
                    "active: " + (reg.active ? reg.active.scriptURL + " (state=" + reg.active.state + ")" : "none"),
                    "waiting: " + (reg.waiting ? reg.waiting.scriptURL + " (state=" + reg.waiting.state + ") -- an update is downloaded but NOT yet controlling this page" : "none"),
                    "installing: " + (reg.installing ? reg.installing.scriptURL : "none"),
                    "controller matches active: " + (navigator.serviceWorker.controller ? (navigator.serviceWorker.controller === reg.active) : "no controller on this page load")
                ].join("\n  ");
            });
            swInfo.textContent = lines.join("\n\n");
        });
    }
    renderSW();

    // ---------- live scroll/layout state ----------
    function findOverlays() {
        const all = document.querySelectorAll("body *");
        const overlays = [];
        for (let i = 0; i < all.length && overlays.length < 8; i++) {
            const el = all[i];
            const cs = getComputedStyle(el);
            if ((cs.position === "fixed" || cs.position === "sticky") &&
                cs.display !== "none" && cs.visibility !== "hidden" &&
                parseFloat(cs.opacity) > 0) {
                const rect = el.getBoundingClientRect();
                const coversSignificantArea = rect.width * rect.height > (window.innerWidth * window.innerHeight * 0.3);
                if (coversSignificantArea) {
                    overlays.push((el.id ? "#" + el.id : el.tagName) + (el.className ? "." + String(el.className).split(" ")[0] : "") +
                        " [pointer-events:" + cs.pointerEvents + ", touch-action:" + cs.touchAction + ", z-index:" + cs.zIndex + "]");
                }
            }
        }
        return overlays;
    }

    function renderLayout() {
        const se = document.scrollingElement;
        const bodyCS = getComputedStyle(document.body);
        const htmlCS = getComputedStyle(document.documentElement);
        const overlays = findOverlays();
        layoutInfo.textContent = [
            "scrollingElement: " + (se ? se.tagName : "null"),
            se ? ("  scrollHeight=" + se.scrollHeight + " clientHeight=" + se.clientHeight + " scrollTop=" + se.scrollTop) : "",
            se ? ("  " + (se.scrollHeight <= se.clientHeight ? "NO OVERFLOW -- this page/view has nothing to scroll right now" : "content overflows, should be scrollable")) : "",
            "window.scrollY: " + window.scrollY,
            "html: overflow=" + htmlCS.overflow + " touch-action=" + htmlCS.touchAction,
            "body: overflow=" + bodyCS.overflow + " overflow-y=" + bodyCS.overflowY + " touch-action=" + bodyCS.touchAction + " position=" + bodyCS.position,
            "Large fixed/sticky elements currently on top of the page (potential overlays):",
            overlays.length ? overlays.map(function (o) { return "  " + o; }).join("\n") : "  none detected"
        ].filter(Boolean).join("\n");
    }
    renderLayout();
    setInterval(renderLayout, 1000);

    // ---------- touch/pointer/scroll event capture ----------
    function describeChain(el) {
        const chain = [];
        let node = el, depth = 0;
        while (node && node.nodeType === 1 && depth < 20) {
            const cs = getComputedStyle(node);
            chain.push((node.tagName) + (node.id ? "#" + node.id : "") + (node.className ? "." + String(node.className).split(" ")[0] : "") +
                " [overflow-y:" + cs.overflowY + " touch-action:" + cs.touchAction + " pointer-events:" + cs.pointerEvents + " position:" + cs.position + "]");
            if (node === document.body) break;
            node = node.parentElement;
            depth++;
        }
        return chain;
    }

    function record(type, e) {
        const target = e.target && e.target.nodeType === 1 ? e.target : document.body;
        state.events.push({
            t: new Date().toISOString().slice(11, 23),
            type: type,
            defaultPrevented: e.defaultPrevented,
            chain: describeChain(target)
        });
        if (state.events.length > 30) state.events.shift();
        renderEvents();
    }

    ["touchstart", "touchmove", "touchend", "pointerdown", "pointermove", "pointerup", "scroll", "wheel"].forEach(function (type) {
        document.addEventListener(type, function (e) { record(type, e); }, { capture: true, passive: true });
    });

    function renderEvents() {
        const last = state.events.slice(-6).reverse().map(function (e) {
            const blocked = e.chain.find(function (c) { return c.indexOf("touch-action:none") !== -1 || c.indexOf("pointer-events:none") !== -1; });
            return "[" + e.t + "] " + e.type + (e.defaultPrevented ? " \u26a0\ufe0fDEFAULT-PREVENTED" : "") +
                (blocked ? "\n  \u26a0\ufe0f blocking layer: " + blocked : "") +
                "\n  path: " + e.chain.slice(0, 3).join(" > ");
        }).join("\n\n");
        eventsInfo.textContent = last || "Touch/scroll the page to capture events here.";
    }

    // ---------- copy report ----------
    copyBtn.onclick = function () {
        const report = [
            "=== SCROLL DIAGNOSTICS REPORT ===",
            "Generated: " + new Date().toISOString(),
            "",
            "--- Build ---",
            state.buildInfo ? JSON.stringify(state.buildInfo, null, 2) : ("version.json error: " + state.buildInfoError),
            "",
            "--- Environment ---",
            staticInfo.textContent,
            "",
            "--- Service Worker ---",
            swInfo.textContent,
            "",
            "--- Layout (at copy time) ---",
            layoutInfo.textContent,
            "",
            "--- Full Event Log (" + state.events.length + " events) ---",
            state.events.map(function (e) {
                return "[" + e.t + "] " + e.type + " defaultPrevented=" + e.defaultPrevented + "\n  " + e.chain.join("\n  ");
            }).join("\n\n")
        ].join("\n");

        const ta = document.createElement("textarea");
        ta.value = report;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
        if (!ok && navigator.clipboard) {
            navigator.clipboard.writeText(report).then(function () {
                copyBtn.textContent = "Copied!";
                setTimeout(function () { copyBtn.textContent = "Copy Diagnostic Report"; }, 1500);
            });
        } else {
            copyBtn.textContent = ok ? "Copied!" : "Copy failed - select text below manually";
            if (ok) setTimeout(function () { copyBtn.textContent = "Copy Diagnostic Report"; }, 1500);
        }
    };
})();
