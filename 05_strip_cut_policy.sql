-- ============================================================
-- Priority 2: Strip Cut Policy (ADDITIVE ONLY)
-- ============================================================
-- No existing strip-cut logic was found anywhere in the repository -- this
-- is new functionality, not a correction of an existing implementation.
--
-- alter table ... add column ... if not exists is non-destructive: existing
-- rows get the default ('staff_decision'), nothing is dropped or rewritten.
-- ============================================================

alter table public.inventory_items
    add column if not exists strip_policy text not null default 'always_cut'
    check (strip_policy in ('always_cut', 'never_cut', 'staff_decision'));

comment on column public.inventory_items.strip_policy is
    'always_cut (default -- preserves current production behavior: today the app already
       dispenses any tablet quantity without ever asking, so every existing medicine keeps
       behaving EXACTLY as before this migration until someone explicitly opts it into a
       different policy in Master Data):
       cutting a sealed strip to fulfil a non-multiple quantity happens automatically, no prompt.
     never_cut: only whole sealed strips are ever dispensed; a non-multiple request is capped down
       to the nearest full strip and the remainder is treated as a shortfall (same path as Out of Stock).
     staff_decision: pause ONLY this line item and ask staff to choose "sealed strips only" vs
       "cut one strip" before it is deducted. Opt-in only -- never the default for existing data.';

-- ---- Immutable audit trail for strip-cut decisions (Priority 2 requirement:
--      "Persist decision in audit trail"). Append-only, like medicine_history --
--      never updated or deleted, only inserted. ----
create table if not exists public.strip_cut_decisions (
    id uuid primary key default gen_random_uuid(),
    medicine_code text not null,
    medicine_name text,
    batch_number text,                    -- earliest-expiry batch this decision would open (informational; the
                                           -- actual atomic FEFO split still determines the real batch(es) touched)
    order_ref text,
    workflow_id text,
    requested_tablets numeric not null,
    dispensed_tablets numeric not null default 0,   -- how many were actually dispensed now
    deferred_tablets numeric not null default 0,    -- how many were sent to Reorder as a result of this decision
    tabs_per_strip numeric not null,
    policy_at_decision text not null,     -- snapshot of strip_policy at the moment of decision
    decision text not null check (decision in ('sealed_only', 'cut_strip', 'auto_always_cut', 'auto_never_cut_capped', 'cancelled')),
    decided_by text,
    decided_at timestamptz not null default now()
);
create index if not exists idx_strip_cut_decisions_order on public.strip_cut_decisions (order_ref);
create index if not exists idx_strip_cut_decisions_medicine on public.strip_cut_decisions (medicine_code);

alter table public.strip_cut_decisions enable row level security;
drop policy if exists "authenticated read" on public.strip_cut_decisions;
create policy "authenticated read" on public.strip_cut_decisions for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.strip_cut_decisions;
create policy "authenticated write" on public.strip_cut_decisions for insert with check (auth.role() = 'authenticated');

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'strip_cut_decisions'
    ) then
        alter publication supabase_realtime add table public.strip_cut_decisions;
    end if;
end $$;
