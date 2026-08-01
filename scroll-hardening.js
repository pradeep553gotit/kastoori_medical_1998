/* ============================================================
   scroll-hardening.js
   ------------------------------------------------------------
   HONESTY NOTE: this is NOT a confirmed root-cause fix. Deep
   static review of the existing CSS/JS found no code-level bug
   causing scroll to lock. This file is a defensive hardening
   patch covering a few remaining possibilities that can't be
   fully verified from source alone:

   1. Missing momentum/inertia scrolling on some older Android
      WebViews (-webkit-overflow-scrolling was never set).
   2. A runtime guard that actively removes any overflow:hidden
      or touch-action:none it finds on <html>/<body> every 500ms
      -- in case something outside this codebase (a browser
      extension, an injected script, a stray inline style) is
      setting one after page load.
   3. Explicit height/overflow reset on <html>/<body> in case an
      inherited/UA-default value is interacting badly with a
      specific Android Chrome version.

   Load this AFTER app.js. Safe to add and safe to remove.
   ============================================================ */
(function () {
    // --- 1. force momentum scrolling everywhere it matters ---
    const style = document.createElement("style");
    style.textContent = `
        html, body {
            -webkit-overflow-scrolling: touch;
            height: auto;
            overflow-y: auto;
        }
        .main-content, .view-panel, .sidebar-menu, .modal-content,
        .modal-box, .notification-drawer {
            -webkit-overflow-scrolling: touch;
        }
    `;
    document.head.appendChild(style);

    // --- 2. runtime guard against anything re-locking scroll ---
    function unlock() {
        [document.documentElement, document.body].forEach(function (el) {
            if (!el) return;
            const cs = getComputedStyle(el);
            if (cs.overflowY === "hidden" && !el.matches(":has(.modal-backdrop.active)")) {
                el.style.setProperty("overflow-y", "auto", "important");
            }
            if (cs.touchAction === "none") {
                el.style.setProperty("touch-action", "pan-y", "important");
            }
        });
    }
    unlock();
    setInterval(unlock, 500);

    // Log so we can confirm this actually ran, without needing a full panel
    console.log("[scroll-hardening] active - forcing momentum scrolling + runtime overflow/touch-action guard");
})();
