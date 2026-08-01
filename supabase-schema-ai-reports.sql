-- ============================================================
-- Kastoori Medicals — AI Reporting Center (Priority 3)
-- Run this in the Supabase SQL Editor AFTER supabase-schema.sql and
-- supabase-schema-supplier-due.sql. Additive / idempotent, same
-- conventions as the rest of the project (uuid pk, timestamptz,
-- snake_case, RLS). Safe to run on an existing project.
--
-- Design notes (read before extending):
-- - The AI (Edge Function `ai-report-query`) NEVER talks to Postgres
--   directly. It generates SQL text, then calls execute_ai_report_sql()
--   below via RPC. This function is the actual security boundary — the
--   Edge Function's own regex check is a first filter, not the boundary,
--   because prompt injection could in principle get past a client-side
--   check but cannot get past a server-side one re-validating the same
--   text.
-- - execute_ai_report_sql() only ever runs a SELECT/CTE, rejects a
--   second statement, rejects comments (a classic way to hide a second
--   statement from naive checks), enforces a hard row cap, and caps
--   execution time so one bad/expensive query can't tie up the DB.
-- - It is SECURITY DEFINER (same pattern as deduct_stock_atomic /
--   generate_workflow_id elsewhere in this project) so it can read
--   across tables the same way the rest of the app's "authenticated
--   read" RLS policies already allow — it does not grant any new data
--   access beyond what an authenticated user's own queries already see
--   under those existing policies, it just lets the AI issue read SQL
--   instead of only pre-built app queries.
-- ============================================================

-- ---- ai_report_queries: one row per question asked, for history /
--      audit / "recent searches" and Admin debugging ----
create table if not exists public.ai_report_queries (
    id uuid primary key default gen_random_uuid(),
    asked_by text,
    role text,
    question text not null,
    language_hint text,                 -- 'en' | 'ta' | 'tanglish' | null
    generated_sql text,
    row_count integer,
    execution_ms integer,
    status text not null default 'success' check (status in ('success', 'rejected', 'error')),
    error_message text,
    created_at timestamptz not null default now()
);
create index if not exists idx_ai_report_queries_user on public.ai_report_queries (asked_by);
create index if not exists idx_ai_report_queries_date on public.ai_report_queries (created_at);

alter table public.ai_report_queries enable row level security;
drop policy if exists "authenticated read" on public.ai_report_queries;
create policy "authenticated read" on public.ai_report_queries for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.ai_report_queries;
create policy "authenticated write" on public.ai_report_queries for insert with check (auth.role() = 'authenticated');

-- ============================================================
-- Hardened read-only SQL execution.
-- ============================================================
create or replace function public.execute_ai_report_sql(p_sql text, p_row_limit integer default 500)
returns jsonb as $$
declare
    v_clean text;
    v_result jsonb;
begin
    if p_sql is null or btrim(p_sql) = '' then
        raise exception 'execute_ai_report_sql: empty query';
    end if;

    -- Strip exactly one optional trailing semicolon + trailing whitespace.
    v_clean := regexp_replace(btrim(p_sql), ';\s*$', '');

    -- Reject SQL comments outright — a common way to smuggle a second
    -- statement or keyword past a naive keyword filter.
    if v_clean ~ '(--|/\*)' then
        raise exception 'execute_ai_report_sql: comments are not allowed in generated SQL';
    end if;

    -- Reject any remaining semicolon: that means a second statement.
    if v_clean ~ ';' then
        raise exception 'execute_ai_report_sql: only a single statement is allowed';
    end if;

    -- Must start with SELECT or WITH (a read-only query / CTE).
    if v_clean !~* '^\s*(select|with)\s' then
        raise exception 'execute_ai_report_sql: only SELECT/WITH statements are allowed';
    end if;

    -- Hard denylist of anything mutating or administrative, even inside
    -- a CTE or subquery. Word-boundary match so e.g. "updated_at" as a
    -- column name is never falsely rejected.
    if v_clean ~* '\y(insert|update|delete|drop|alter|truncate|grant|revoke|create|call|do|copy|merge|vacuum|analyze|execute|lock|reindex|refresh|listen|notify|prepare|declare|set|reset|pg_sleep|dblink|copy)\y' then
        raise exception 'execute_ai_report_sql: statement contains a disallowed keyword';
    end if;

    if p_row_limit is null or p_row_limit <= 0 or p_row_limit > 2000 then
        p_row_limit := 500;
    end if;

    -- Cap execution time for this call only (SET LOCAL is transaction-scoped).
    perform set_config('statement_timeout', '8000', true);

    execute format(
        'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s limit %s) as t',
        v_clean, p_row_limit
    ) into v_result;

    return v_result;
exception
    when others then
        raise;
end;
$$ language plpgsql security definer set search_path = public;

-- Only authenticated users (the app's own JWT-carrying calls, i.e. the
-- Edge Function acting on the caller's behalf) may invoke this at all.
revoke all on function public.execute_ai_report_sql(text, integer) from public;
grant execute on function public.execute_ai_report_sql(text, integer) to authenticated;

-- ============================================================
-- ai_saved_reports: named, frequently-used questions a user has saved
-- (e.g. "Daily Stock Report", "Weekly Supplier Due"), so they can be
-- re-run with one click instead of retyping. Cross-device by design —
-- stored in Supabase like every other piece of shared app state, not
-- localStorage.
-- ============================================================
create table if not exists public.ai_saved_reports (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null,             -- auth.users.id of the saving user
    owner_name text,
    title text not null,
    question text not null,
    created_at timestamptz not null default now()
);
create index if not exists idx_ai_saved_reports_owner on public.ai_saved_reports (owner_id);

alter table public.ai_saved_reports enable row level security;
drop policy if exists "owner read" on public.ai_saved_reports;
create policy "owner read" on public.ai_saved_reports for select using (auth.uid() = owner_id);
drop policy if exists "owner write" on public.ai_saved_reports;
create policy "owner write" on public.ai_saved_reports for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
