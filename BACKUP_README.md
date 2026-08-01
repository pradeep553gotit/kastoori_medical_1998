# Kastoori Medicals — Pre-Schema-B-Migration Backup (v1)

**Created:** 2026-07-15
**Purpose:** Code-level rollback point, captured immediately before applying
the Schema B reporting-center migration (`03_reporting_data_model_v2_PENDING.sql`).

## What this backup IS

- The complete application source code as of this point: `app.js`, `index.html`,
  `style.css`, `sw.js`, `manifest.json`, deployment/config files
  (`netlify.toml`, `vercel.json`, `DEPLOYMENT.md`), Edge Functions
  (`create-user`, `delete-user`, `reset-password`), brand/icon assets,
  and the original `supabase-schema.sql`.
- Two migration scripts under `migration_scripts/`, kept for reference:
  - `02_reporting_data_model_ATTEMPT1_DO_NOT_RUN.sql` — the FIRST migration
    attempt from this session. **Do not run this one.** It assumed a
    text-id (`code`) schema for `medicines` that conflicted with the
    live uuid-based `medicines`/`dispensaries`/`inventory` tables, and
    running it against a fresh `medicines` table will fail or produce
    the wrong key structure.
  - `03_reporting_data_model_v2_PENDING.sql` — the corrected migration,
    not yet applied at the time of this backup.

## What this backup is NOT

- **This is not a database backup.** The Supabase project is on the Free
  plan, which has no scheduled backups and no Point-in-Time Recovery.
  There is no way to snapshot or restore the actual database state
  (tables, rows, RLS policies) from outside the dashboard.
- This zip cannot be used to "undo" any SQL migration. If a future
  migration needs to be reversed, it must be done manually — e.g.
  `drop table if exists public.<new_table>` for tables added after
  this point, or `alter table ... drop column` for added columns —
  and only for objects that don't yet hold real data.

## Known state of the database at time of this backup

- Live tables in `public` schema include (non-exhaustive): `workflows`,
  `workflow_events`, `workflow_id_counters`, `inventory_items`,
  `not_available_items`, `reorders`, `due_orders`, `purchase_images`,
  `supplier_bills`, `ocr_uploads`, `ocr_results`, `medicine_history`,
  `inventory_transactions`, `report_exports`, `dashboard_metrics`,
  `upload_statistics`, `profiles`, `activity_logs`, `login_logs`,
  `dispensaries`, `inventory`, `inventory_movements`, `app_data`,
  `bills`, `history`, `developer_logs`, `notifications`,
  `scanned_orders`.
- `public.medicines` (uuid-keyed) previously existed as unused
  scaffolding — confirmed via code search that `app.js` contains
  zero `.from('medicines')` calls — and was accidentally dropped
  earlier in this session. It held no data (nothing in the codebase
  ever wrote to it). It is being recreated by the pending migration.
- A malformed duplicate table literally named `public."public.profiles"`
  exists (composite primary key across every column) — not yet
  cleaned up, tracked as a separate open item.
- `supabase_schema_auth.sql` / `supabase_schema_lockout.sql` referenced
  in `DEPLOYMENT.md` were never located/uploaded in any session — the
  live `profiles`/`activity_logs` schema exists in the database but
  its original creation SQL is not in this backup.

## Verification performed on this ZIP

- File count and paths checked against the original uploaded project
  archive — all source files, Edge Functions, assets, and config
  present.
- Archive integrity tested with `unzip -t` (see below).
