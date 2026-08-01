-- 07_audit_logs_schema_fix.sql
-- ------------------------------------------------------------------
-- Fixes: "Row sync to audit_logs failed: Could not find the 'log_date'
-- column of 'audit_logs' in the schema cache" (and the same for
-- log_time), seen repeatedly in the browser console.
--
-- Root cause: app.js's syncAuditRow() (see app.js, function
-- syncAuditRow) sends a payload that includes log_date/log_time
-- columns. This is a client-code-vs-database-schema mismatch, not a
-- client bug -- I don't have access to your live Supabase schema from
-- here, so rather than guess and silently change what the client
-- sends (which risks masking a real gap elsewhere), this migration
-- adds the columns the client already expects. It is purely additive
-- (ADD COLUMN IF NOT EXISTS) -- safe to run against a live table with
-- existing rows; existing rows just get NULL in the new columns.
--
-- Before running: quickly confirm in the Supabase Table Editor that
-- `audit_logs` doesn't already have log_date/log_time under different
-- names (e.g. a single `audit_timestamp` column) -- if it does, the
-- real fix is adjusting app.js's payload to match instead of adding
-- redundant columns. I could not verify this myself without DB
-- access, so please check schema in the Supabase Studio before applying this.
-- ------------------------------------------------------------------

ALTER TABLE audit_logs
    ADD COLUMN IF NOT EXISTS log_date date,
    ADD COLUMN IF NOT EXISTS log_time time;

-- Optional but recommended: index for the Reports/Stock Adjustment
-- "search by date" use case mentioned in the Phase B/C spec.
CREATE INDEX IF NOT EXISTS idx_audit_logs_log_date ON audit_logs (log_date);
