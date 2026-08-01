# Backend Issue: v_outstanding_supplier_due 404 (separate from scrolling)

## Root Cause
`supabase-schema-supplier-due.sql` (in repo root) defines the
`supplier_due` and `supplier_due_items` tables and the
`v_outstanding_supplier_due` view. Its own header states it must be run
in the Supabase SQL Editor AFTER `supabase-schema.sql` — there is no
record in DEPLOYMENT.md/README.md/BACKUP_README.md that this file was
ever actually executed against the live database. app.js (lines 3227,
3269) correctly queries this view; the frontend code is not at fault.

## Evidence
- Live network request: `HEAD .../v_outstanding_supplier_due?select=due_item_...` → 404 Not Found
- View only exists as CREATE VIEW statement in an unapplied .sql file, not in the live schema

## Fix
Run `supabase-schema-supplier-due.sql` in the Supabase SQL editor for the
production project. Per its own header it is additive/idempotent
(`create table if not exists`), safe to run without touching existing
data -- but as with any migration on a Free-tier project with no
point-in-time recovery, review it once yourself first and confirm you
have a current backup before running.

## Status
NOT YET APPLIED. Do not mark resolved until run on production and the
404 is confirmed gone via a fresh network request.
