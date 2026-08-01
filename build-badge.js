/* ============================================================
   build-badge.js
   ------------------------------------------------------------
   Self-identifying build verification. Runs on every page load.

   1. Fetches version.json and this page's own style.css / app.js,
      computes a SHA-256 hash of each file's actual bytes (live,
      client-side, via crypto.subtle -- this cannot be faked or
      manually mistyped the way a hardcoded version string can).
   2. Logs all of it to the console immediately on load.
   3. Shows a small floating badge (bottom-left, out of the way of
      the bottom nav) with commit / build time / debug flags.
   4. Adds a full Diagnostics view at ?debug=diagnostics showing
      everything, including the live file hashes, in large
      copy-pasteable text.
   ============================================================ */
(function () {
    async function sha256(text) {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    }

    async function collectBuildInfo() {
        const info = { timestamp: new Date().toISOString() };

        try {
            const vRes = await fetch("./version.json", { cache: "no-store" });
            info.version = vRes.ok ? await vRes.json() : { error: "HTTP " + vRes.status };
        } catch (e) { info.version = { error: e.message }; }

        try {
            const cssRes = await fetch("./style.css", { cache: "no-store" });
            const cssText = await cssRes.text();
            info.cssHash = await sha256(cssText);
            info.cssBytes = cssText.length;
        } catch (e) { info.cssHash = "error: " + e.message; }

        try {
            const jsRes = await fetch("./app.js", { cache: "no-store" });
            const jsText = await jsRes.text();
            info.jsHash = await sha256(jsText);
            info.jsBytes = jsText.length;
        } catch (e) { info.jsHash = "error: " + e.message; }

        info.debugFlags = {
            scrollDiagV2: !!window.__scrollDiagV2,
            noOverlaysActive: new URLSearchParams(location.search).get("debug") === "nooverlays",
            urlDebugParam: new URLSearchParams(location.search).get("debug") || "(none)"
        };

        return info;
    }

    collectBuildInfo().then(function (info) {
        window.__buildInfo = info;
        console.log("[build-badge] BUILD INFO:", JSON.stringify(info, null, 2));

        // --- floating badge ---
        const badge = document.createElement("div");
        badge.id = "__build_badge";
        badge.style.cssText = [
            "position:fixed", "bottom:6px", "left:6px", "z-index:2147483647",
            "background:rgba(8,12,20,0.9)", "color:#7CFFB2", "font:10px monospace",
            "padding:4px 7px", "border-radius:6px", "border:1px solid #223",
            "touch-action:pan-y", "max-width:70vw", "overflow:hidden",
            "text-overflow:ellipsis", "white-space:nowrap", "cursor:pointer"
        ].join(";");
        const commit = (info.version && info.version.commit) ? info.version.commit.slice(0, 7) : "no-version.json";
        badge.textContent = "build:" + commit + " css:" + info.cssHash.slice(0, 8) + " js:" + info.jsHash.slice(0, 8);
        badge.title = "Tap for full diagnostics";
        badge.onclick = function () {
            const url = new URL(location.href);
            url.searchParams.set("debug", "diagnostics");
            location.href = url.toString();
        };
        document.documentElement.appendChild(badge);

        // --- full diagnostics page ---
        if (new URLSearchParams(location.search).get("debug") === "diagnostics") {
            const page = document.createElement("div");
            page.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#0a0e14;color:#e6f1ff;font:12px monospace;padding:16px;overflow:auto;touch-action:pan-y;-webkit-overflow-scrolling:touch;";
            page.innerHTML =
                "<h2 style='color:#00f2fe;margin:0 0 10px'>Diagnostics</h2>" +
                "<pre style='white-space:pre-wrap;word-break:break-all'>" + JSON.stringify(info, null, 2) + "</pre>" +
                "<button id='__diag_close' style='background:#00f2fe;color:#000;border:none;border-radius:4px;padding:8px 14px;font-weight:700;margin-top:10px;'>Close</button>";
            document.documentElement.appendChild(page);
            page.querySelector("#__diag_close").onclick = function () { page.remove(); };
        }
    });
})();
