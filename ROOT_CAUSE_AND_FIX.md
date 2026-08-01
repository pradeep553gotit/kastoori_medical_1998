# CONFIRMED ROOT CAUSE — Mobile Scrolling Bug

## Root Cause
In `style.css`, the rule targeting `.table-responsive`, `.table-responsive table`,
`.category-filter-container`, and `[style*="overflow-x"]` set:

    touch-action: pan-x;

This is a single-axis value: it tells the browser this element **only**
handles horizontal panning, and vertical panning is disabled on it for
the entire touch gesture -- not "passed through" to the parent as the
original comment assumed. `.table-responsive` wraps 17 separate tables
across the app (Master Data, Reports, Bill Processing, Order
Verification, etc.), covering most of the visible content area on
nearly every screen. Any single-finger drag that starts on or over one
of these tables is therefore locked to horizontal-only and cannot
scroll the page vertically -- exactly matching the reported symptom:
scrolling only works when the drag starts below the tables (near the
bottom nav / empty space), never when it starts over content.

## Why Previous Investigation Took This Long
Static review confirmed touch-action was declared correctly and
deliberately almost everywhere (a real, thoughtful prior fix existed).
The bug wasn't a missing declaration -- it was one existing declaration
using the wrong value, based on a mistaken understanding of what
`pan-x` actually restricts. That's invisible to a "does touch-action
exist here?" scan; it only shows up when you know *where on the
screen* scrolling fails, which is the runtime evidence that pinned it
down.

## Files Responsible
- `style.css` (the touch-action rule above)

## Exact Fix
Change:
    touch-action: pan-x;
to:
    touch-action: pan-x pan-y;

on that same rule (applies to `.table-responsive`, `.table-responsive table`,
`.category-filter-container`, `[style*="overflow-x"]`). This lets the
browser handle both axes: a horizontal drag scrolls the table
sideways, a vertical drag scrolls the page -- both work as intended,
undoing exactly the bug and nothing else.

## How To Deploy
1. Open `style.css` in your repo.
2. Find the rule block (search for `touch-action: pan-x;` -- it appears
   exactly once, in the "Horizontal-only scrollers" section).
3. Change that one line to `touch-action: pan-x pan-y;`
4. Commit and push:
   git add style.css
   git commit -m "Fix mobile scroll lock: table wrappers were blocking vertical page scroll (touch-action: pan-x -> pan-x pan-y)"
   git push origin main
5. Wait for Vercel Production deployment to show Ready.

## Verification Steps (do all of these before calling it resolved)
1. On real Android Chrome, production URL, force-close/reopen if PWA.
2. Go to a page with a wide table (e.g. Master Data).
3. Start a one-finger drag directly ON the table -- confirm the page
   now scrolls vertically.
4. Also confirm you can still swipe the table horizontally if it has
   more columns than fit on screen (this must still work -- that's the
   regression check for the fix itself).
5. Repeat on at least 2 other pages with tables (Reports, Bill
   Processing) to confirm it's not page-specific.
6. Confirm scrolling still works starting from the bottom nav area too
   (should be unaffected either way).

## Regression Test (add to your manual QA checklist / any future E2E suite)
"On mobile, open any page containing a data table (Master Data,
Reports, Order Verification). Start a one-finger vertical drag with
the touch point directly over a table row. The page must scroll
vertically. Then start a one-finger horizontal drag over the same
table -- the table must scroll horizontally if it overflows. Both must
work independently without one disabling the other."

## Status
NOT YET APPLIED -- fix identified and packaged, awaiting your deploy
and the verification steps above on the real production app before
this can be marked Resolved.
