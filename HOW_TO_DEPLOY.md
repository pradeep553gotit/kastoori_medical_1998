# scroll-hardening.js — Deploy Instructions

IMPORTANT: This is a best-effort hardening patch, not a confirmed fix.
Deep code review found no bug in the existing CSS/JS. This adds momentum
scrolling + a runtime guard that strips any overflow:hidden/touch-action:none
found on html/body every 500ms, in case something outside the reviewed
source is causing it.

## Steps

1. Copy `scroll-hardening.js` into your repo root (same folder as app.js).

2. In `index.html`, add this line right before `</body>`, AFTER the
   existing `<script src="app.js"></script>` line:

   <script src="scroll-hardening.js"></script>

3. Commit and push to main:
   git add index.html scroll-hardening.js
   git commit -m "Add scroll hardening patch (momentum scroll + runtime overflow guard)"
   git push origin main

4. Wait for Vercel to finish deploying (check Deployments tab shows Ready).

5. On your real Android phone, force-close the app fully if it's the
   installed PWA, then reopen (or just open kastoori-medicals.vercel.app
   fresh in Chrome). Try scrolling on the page that was failing.

6. Tell me plainly: did it change anything, yes or no. If yes, that's a
   real clue about which of the three causes it was. If no, we know this
   wasn't it either, and the remaining path is the diagnostics panel from
   the earlier package -- there's no way around getting real runtime
   evidence from your device at that point.

## To remove
Delete the added <script> line and scroll-hardening.js, commit, push.
