# Mobile Scrolling Fix — Verified, Applied, Ready to Deploy

## What changed
One line in style.css:
    touch-action: pan-x;
  -> touch-action: pan-x pan-y;

on the selector group: .table-responsive, .table-responsive table,
.category-filter-container, [style*="overflow-x"]

Confirmed as the only touch-action:pan-x in the entire stylesheet
(grep-verified), and confirmed that .table-responsive covers most of
the mobile content area (width:100%, used in 17 places, no height cap
in its base form). This also fixes the .max-height-300 variant's own
internal vertical scroll, since it shares the same class and is
covered by the same rule.

## Why it works
touch-action:pan-x tells the browser "only handle horizontal panning
here" -- vertical drags starting on this element are not scrolled at
all, for that entire gesture, and this is NOT passed through to an
ancestor (a common misunderstanding). touch-action:pan-x pan-y tells
the browser both axes are native scroll gestures on this element, so
horizontal drags scroll the table and vertical drags scroll the page,
independently, as originally intended.

## Deploy
1. Replace your style.css with the one in this package (or apply
   style.css.diff by hand -- it's a single line).
2. git add style.css
   git commit -m "Fix mobile scroll lock: table touch-action pan-x -> pan-x pan-y"
   git push origin main
3. Wait for Vercel Production to show Ready.

## Verify on real device (do not skip)
1. Real Android phone, Chrome, production URL, fresh load (force-close
   first if installed as PWA).
2. Open Master Data (or any page with a table). Drag vertically
   starting ON a table row -- page must scroll.
3. Drag horizontally on a wide table -- table must still scroll
   sideways if it has overflow columns.
4. Repeat on Reports and Bill Processing pages.
5. Confirm bottom-nav-originated scrolling still works too (unaffected
   either way, but worth the 5 seconds).

## Regression test (keep this for future QA)
"On mobile, start a one-finger vertical drag with the touch point
directly over a data table row -- page must scroll. Start a one-finger
horizontal drag over the same table -- table must scroll sideways if
it overflows. Neither gesture should disable the other."

## If this does NOT fix it after deploying
That is new evidence the root cause is incomplete -- come back with
that fact specifically (which page, still fails after this exact
deploy) rather than a general "still not working," so the next trace
starts from a narrower, already-partially-eliminated search space
instead of from scratch.
