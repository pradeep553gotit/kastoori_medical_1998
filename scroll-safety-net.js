/* ============================================================
   scroll-safety-net.js
   ------------------------------------------------------------
   Two things, both defensive, both safe to add/remove at any time:

   1. Confirms (via console.log, visible in a real device's remote
      inspector, but doesn't require it) that this file loaded.

   2. Every 500ms, scans for any element that is position:fixed or
      position:absolute, covers more than 40% of the viewport, is
      visible (not display:none/opacity:0/visibility:hidden), and
      currently has pointer-events other than "none" -- i.e. a
      candidate for silently intercepting touches meant for the
      page underneath. For each one found, it logs a clear warning
      identifying exactly which element it is, so the culprit shows
      up in the console even without deep manual inspection.

   This does NOT blindly disable things -- it only reports, so nothing
   about the app's real behavior changes except vertical touch-action
   (handled separately in style.css). If something IS found here, that
   is the smoking gun and the fix becomes trivial and specific.
   ============================================================ */
(function () {
    console.log("[scroll-safety-net] loaded and scanning");

    function scan() {
        const found = [];
        const all = document.querySelectorAll("body *");
        for (let i = 0; i < all.length; i++) {
            const el = all[i];
            const cs = getComputedStyle(el);
            if (cs.position !== "fixed" && cs.position !== "absolute") continue;
            if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
            if (cs.pointerEvents === "none") continue;
            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            const viewportArea = window.innerWidth * window.innerHeight;
            if (area > viewportArea * 0.4) {
                found.push({
                    el: el,
                    tag: el.tagName,
                    id: el.id || "(no id)",
                    cls: el.className ? String(el.className).slice(0, 80) : "(no class)",
                    rect: { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) },
                    zIndex: cs.zIndex,
                    pointerEvents: cs.pointerEvents
                });
            }
        }
        if (found.length) {
            console.warn("[scroll-safety-net] " + found.length + " large fixed/absolute element(s) with active pointer-events currently covering the page:");
            found.forEach(function (f) {
                console.warn("  <" + f.tag + " id='" + f.id + "' class='" + f.cls + "'> " +
                    "rect=" + JSON.stringify(f.rect) + " z-index=" + f.zIndex + " pointer-events=" + f.pointerEvents);
                // Visually mark it so it's obvious on screen too, without changing behavior
                f.el.style.outline = "4px solid red";
            });
        }
    }

    scan();
    setInterval(scan, 1500);
})();
