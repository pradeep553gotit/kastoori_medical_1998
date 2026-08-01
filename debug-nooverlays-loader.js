(function () {
    if (new URLSearchParams(location.search).get("debug") !== "nooverlays") return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "debug-nooverlays.css";
    document.head.appendChild(link);

    const banner = document.createElement("div");
    banner.textContent = "\u26a0\ufe0f DEBUG MODE: all overlays/sidebar/nav disabled for scroll bisection test";
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#7c3aed;color:#fff;font:bold 12px monospace;padding:6px;text-align:center;";
    document.documentElement.appendChild(banner);

    console.log("[debug-nooverlays] active - every overlay/sidebar/nav component is hidden. Try scrolling now.");
})();
