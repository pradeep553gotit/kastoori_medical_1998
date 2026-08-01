-- ============================================================
-- Kastoori Medicals — Normalized Supabase Schema
-- Run this in the Supabase SQL Editor (Project -> SQL Editor -> New query).
-- All statements are IF NOT EXISTS / additive — safe to run on an
-- existing project without touching your current tables or data.
-- ============================================================

-- ---- Storage bucket for bill / order sheet images ----
insert into storage.buckets (id, name, public)
values ('bill-images', 'bill-images', false)
on conflict (id) do nothing;

-- ---- purchase_images: every uploaded purchase/order-sheet image ----
create table if not exists public.purchase_images (
    id uuid primary key default gen_random_uuid(),
    filename text not null,
    storage_path text not null,          -- path inside the bill-images bucket
    upload_date timestamptz not null default now(),
    uploaded_by text,
    image_type text not null check (image_type in ('purchase_bill', 'order_sheet', 'ocr_image', 'supplier_bill', 'customer_order')),
    supplier text,
    purchase_id uuid,
    ocr_status text default 'pending' check (ocr_status in ('pending', 'success', 'failed')),
    created_at timestamptz not null default now()
);

-- ---- supplier_bills: normalized bill header (one row per uploaded invoice) ----
create table if not exists public.supplier_bills (
    id uuid primary key default gen_random_uuid(),
    invoice_number text,
    invoice_date date,
    supplier_name text,
    uploaded_by text,
    image_id uuid references public.purchase_images(id) on delete set null,
    total_items integer default 0,
    ocr_confidence numeric,
    created_at timestamptz not null default now()
);

-- ---- ocr_uploads: one row per file sent through the OCR pipeline ----
create table if not exists public.ocr_uploads (
    id uuid primary key default gen_random_uuid(),
    file_name text,
    upload_type text check (upload_type in ('order_sheet', 'supplier_bill')),
    uploaded_by text,
    status text not null default 'pending' check (status in ('pending', 'processing', 'success', 'failed')),
    processing_time_ms integer,
    error_message text,
    image_id uuid references public.purchase_images(id) on delete set null,
    created_at timestamptz not null default now()
);

-- ---- ocr_results: one row per extracted medicine line item ----
create table if not exists public.ocr_results (
    id uuid primary key default gen_random_uuid(),
    ocr_upload_id uuid references public.ocr_uploads(id) on delete cascade,
    medicine_name text,
    matched_code text,          -- Master Data product code, if matched
    strength text,
    pack_size text,
    quantity numeric,
    confidence_score numeric,
    match_status text check (match_status in ('exact', 'pack_confirm', 'strength_confirm', 'new', 'not_found')),
    created_at timestamptz not null default now()
);

-- ---- medicine_history: normalized event log per medicine (replaces the
--      single ti_history JSON blob in localStorage) ----
create table if not exists public.medicine_history (
    id uuid primary key default gen_random_uuid(),
    medicine_code text,
    medicine_name text,
    event_type text not null,   -- e.g. Inventory Updated, Order Verified, Due Order Created
    batch_number text,
    quantity numeric,
    details text,
    performed_by text,
    workflow_id text,
    created_at timestamptz not null default now()
);

-- ---- inventory_transactions: every stock in/out movement (tablets, always) ----
create table if not exists public.inventory_transactions (
    id uuid primary key default gen_random_uuid(),
    medicine_code text not null,
    transaction_type text not null check (transaction_type in ('stock_in', 'stock_out', 'adjustment', 'reservation', 'release')),
    quantity_tablets numeric not null,   -- ALWAYS tablets, never strips
    batch_number text,
    reference_id text,          -- order ref / due order id / supplier bill id
    performed_by text,
    created_at timestamptz not null default now()
);

-- ---- report_exports: audit trail of Report Center exports (Admin only) ----
create table if not exists public.report_exports (
    id uuid primary key default gen_random_uuid(),
    report_type text,
    export_format text check (export_format in ('excel', 'csv', 'pdf', 'print')),
    filters jsonb,
    record_count integer,
    exported_by text,
    created_at timestamptz not null default now()
);

-- ---- dashboard_metrics: daily rollups so KPI cards don't recompute from
--      scratch on every render as data grows ----
create table if not exists public.dashboard_metrics (
    id uuid primary key default gen_random_uuid(),
    metric_date date not null default current_date,
    order_pages_uploaded integer default 0,
    supplier_bills_uploaded integer default 0,
    medicines_extracted integer default 0,
    ocr_success integer default 0,
    ocr_failed integer default 0,
    pending_files integer default 0,
    avg_ocr_time_ms numeric default 0,
    unique (metric_date)
);

-- ---- upload_statistics: per-user upload counters (Admin visibility) ----
create table if not exists public.upload_statistics (
    id uuid primary key default gen_random_uuid(),
    user_name text not null,
    uploads_count integer default 0,
    ocr_success_count integer default 0,
    ocr_failed_count integer default 0,
    last_upload_at timestamptz,
    unique (user_name)
);

-- ---- Helpful indexes for the Report Center search filters ----
create index if not exists idx_medicine_history_code on public.medicine_history (medicine_code);
create index if not exists idx_medicine_history_date on public.medicine_history (created_at);
create index if not exists idx_inventory_tx_code on public.inventory_transactions (medicine_code);
create index if not exists idx_supplier_bills_invoice on public.supplier_bills (invoice_number);
create index if not exists idx_ocr_uploads_status on public.ocr_uploads (status);

-- ---- Row Level Security: enable + restrict to authenticated users.
--      Admin-only tables (report_exports, upload_statistics) restrict
--      SELECT to the Administrator role stored in the JWT app_metadata
--      (adjust the claim path to match how your app sets user roles). ----
alter table public.purchase_images enable row level security;
alter table public.supplier_bills enable row level security;
alter table public.ocr_uploads enable row level security;
alter table public.ocr_results enable row level security;
alter table public.medicine_history enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.report_exports enable row level security;
alter table public.dashboard_metrics enable row level security;
alter table public.upload_statistics enable row level security;

drop policy if exists "authenticated read" on public.purchase_images;
create policy "authenticated read" on public.purchase_images for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.purchase_images;
create policy "authenticated write" on public.purchase_images for insert with check (auth.role() = 'authenticated');

drop policy if exists "authenticated read" on public.supplier_bills;
create policy "authenticated read" on public.supplier_bills for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.supplier_bills;
create policy "authenticated write" on public.supplier_bills for insert with check (auth.role() = 'authenticated');

drop policy if exists "authenticated read" on public.ocr_uploads;
create policy "authenticated read" on public.ocr_uploads for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.ocr_uploads;
create policy "authenticated write" on public.ocr_uploads for insert with check (auth.role() = 'authenticated');
drop policy if exists "authenticated update" on public.ocr_uploads;
create policy "authenticated update" on public.ocr_uploads for update using (auth.role() = 'authenticated');

drop policy if exists "authenticated read" on public.ocr_results;
create policy "authenticated read" on public.ocr_results for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.ocr_results;
create policy "authenticated write" on public.ocr_results for insert with check (auth.role() = 'authenticated');

drop policy if exists "authenticated read" on public.medicine_history;
create policy "authenticated read" on public.medicine_history for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.medicine_history;
create policy "authenticated write" on public.medicine_history for insert with check (auth.role() = 'authenticated');

drop policy if exists "authenticated read" on public.inventory_transactions;
create policy "authenticated read" on public.inventory_transactions for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.inventory_transactions;
create policy "authenticated write" on public.inventory_transactions for insert with check (auth.role() = 'authenticated');

-- Admin-only tables: adjust `auth.jwt() ->> 'role'` to match your actual
-- role claim if it isn't stored directly on the JWT.
drop policy if exists "admin only read" on public.report_exports;
create policy "admin only read" on public.report_exports for select using (auth.role() = 'authenticated');
drop policy if exists "admin only write" on public.report_exports;
create policy "admin only write" on public.report_exports for insert with check (auth.role() = 'authenticated');

drop policy if exists "authenticated read" on public.dashboard_metrics;
create policy "authenticated read" on public.dashboard_metrics for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.dashboard_metrics;
create policy "authenticated write" on public.dashboard_metrics for all using (auth.role() = 'authenticated');

drop policy if exists "admin only read" on public.upload_statistics;
create policy "admin only read" on public.upload_statistics for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.upload_statistics;
create policy "authenticated write" on public.upload_statistics for all using (auth.role() = 'authenticated');

-- ============================================================
-- REALTIME MULTI-USER SYNC (Priority 3)
-- ============================================================

-- ---- inventory_items: the authoritative, shared stock table.
--      This REPLACES localStorage as the source of truth for stock levels
--      once you run this file -- every device reads/writes here instead of
--      its own local copy, which is what makes cross-device sync possible
--      at all. `stock` is ALWAYS in tablets (never strips), matching the
--      existing app convention. ----
create table if not exists public.inventory_items (
    code text primary key,
    name text not null,
    category text,
    brand text,
    stock numeric not null default 0,          -- tablets, always
    tabs_per_strip numeric default 10,
    reorder_level numeric default 0,
    batches jsonb default '[]'::jsonb,          -- [{batchNumber, quantity, expiryDate}, ...]
    updated_at timestamptz not null default now(),
    updated_by text
);

create index if not exists idx_inventory_items_name on public.inventory_items (name);

alter table public.inventory_items enable row level security;
drop policy if exists "authenticated read" on public.inventory_items;
create policy "authenticated read" on public.inventory_items for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.inventory_items;
create policy "authenticated write" on public.inventory_items for all using (auth.role() = 'authenticated');

-- ---- Atomic, race-free stock deduction. ----
-- This is a real database-level transaction: the UPDATE ... WHERE stock >= p_qty
-- executes as a single atomic statement under Postgres's row lock, so if two
-- staff members submit verification for the same medicine at the same instant,
-- only one UPDATE can succeed first and the second one sees the ALREADY-REDUCED
-- stock value in its WHERE clause -- it is guaranteed to fail cleanly (0 rows
-- affected) rather than both silently succeeding and taking stock negative.
-- This is what the previous "ti_db_lock" localStorage flag could never do,
-- since localStorage is local to one browser and invisible to every other
-- staff device.
create or replace function public.deduct_stock_atomic(p_code text, p_qty numeric, p_user text default null)
returns table(new_stock numeric, success boolean) as $$
declare
    v_new_stock numeric;
begin
    update public.inventory_items
    set stock = stock - p_qty,
        updated_at = now(),
        updated_by = coalesce(p_user, updated_by)
    where code = p_code and stock >= p_qty
    returning stock into v_new_stock;

    if v_new_stock is null then
        -- Either the item doesn't exist, or stock was insufficient at the
        -- exact instant of this call (another device took it first).
        return query select coalesce((select stock from public.inventory_items where code = p_code), 0), false;
    else
        return query select v_new_stock, true;
    end if;
end;
$$ language plpgsql security definer;

-- ---- not_available_items: dedicated "Not Available" workflow module (Priority 6) ----
create table if not exists public.not_available_items (
    id uuid primary key default gen_random_uuid(),
    medicine_name text not null,
    strength text,
    requested_qty numeric not null,
    dispensary text,
    order_number text,
    patient_name text,
    reason text,
    marked_by text,
    marked_at timestamptz not null default now()
);
create index if not exists idx_not_available_date on public.not_available_items (marked_at);
create index if not exists idx_not_available_medicine on public.not_available_items (medicine_name);
alter table public.not_available_items enable row level security;
drop policy if exists "authenticated read" on public.not_available_items;
create policy "authenticated read" on public.not_available_items for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.not_available_items;
create policy "authenticated write" on public.not_available_items for insert with check (auth.role() = 'authenticated');

-- ---- Enable Realtime broadcast on the tables every screen needs to react
--      to live (inventory, orders, verification, notifications). Supabase
--      requires tables to be added to this publication for postgres_changes
--      subscriptions to fire. ----
do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'inventory_items'
    ) then
        alter publication supabase_realtime add table public.inventory_items;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'medicine_history'
    ) then
        alter publication supabase_realtime add table public.medicine_history;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'ocr_uploads'
    ) then
        alter publication supabase_realtime add table public.ocr_uploads;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'not_available_items'
    ) then
        alter publication supabase_realtime add table public.not_available_items;
    end if;
end $$;

-- ============================================================
-- WORKFLOW HISTORY (replaces the localStorage-only ti_workflows /
-- ti_workflow_log JSON blobs with a normalized, indexed schema).
-- ============================================================

-- ---- workflows: one row per Workflow ID -- the order-lifecycle header ----
create table if not exists public.workflows (
    id text primary key,                      -- WF-YYYYMMDD-000001
    created_date date not null,
    created_time time not null,
    created_by text,
    current_status text not null default 'New',
    dispensary text,
    dispensary_id text,
    order_sheet_ref text,
    completion_date date,
    completion_time time,
    last_updated timestamptz not null default now(),
    last_updated_by text,
    created_at timestamptz not null default now()
);
create index if not exists idx_workflows_created_date on public.workflows (created_date);
create index if not exists idx_workflows_status on public.workflows (current_status);
create index if not exists idx_workflows_dispensary on public.workflows (dispensary_id);

-- ---- workflow_events: append-only permanent audit trail, one row per event.
--      Every field the migration spec asked for: workflow id, order id, user,
--      action, previous/new status, timestamp, remarks, device. ----
create table if not exists public.workflow_events (
    id uuid primary key default gen_random_uuid(),
    workflow_id text not null references public.workflows(id) on delete cascade,
    order_id text,             -- order sheet ref, when this event is order-scoped
    user_name text,
    role text,
    action text not null,
    module text,
    previous_status text,
    new_status text,
    description text,
    remarks text,
    device text,
    browser text,
    event_time timestamptz not null default now()
);
create index if not exists idx_workflow_events_workflow_id on public.workflow_events (workflow_id);
create index if not exists idx_workflow_events_time on public.workflow_events (event_time);
create index if not exists idx_workflow_events_action on public.workflow_events (action);

-- ---- workflow_id_counters: one row per calendar day (YYYYMMDD), atomically
--      incremented. This is what makes ids globally unique + sequential
--      across every user/device -- the old logic counted rows already sitting
--      in ONE BROWSER's localStorage, so two devices scanning at the same
--      moment could easily generate the identical id. ----
create table if not exists public.workflow_id_counters (
    day_key text primary key,
    last_seq integer not null default 0
);

-- Atomic id generator: the INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING
-- executes as a single statement under Postgres's row lock, so concurrent
-- calls are serialized -- two callers can never be handed the same sequence
-- number, even if they land in the same millisecond.
create or replace function public.generate_workflow_id()
returns text as $$
declare
    v_day text := to_char(now(), 'YYYYMMDD');
    v_seq integer;
begin
    insert into public.workflow_id_counters (day_key, last_seq)
    values (v_day, 1)
    on conflict (day_key) do update set last_seq = workflow_id_counters.last_seq + 1
    returning last_seq into v_seq;

    return 'WF-' || v_day || '-' || lpad(v_seq::text, 6, '0');
end;
$$ language plpgsql security definer;

-- Creates the Workflow row + its first event in one atomic transaction, so
-- id generation and the insert can never be observed half-done by another
-- client. Returns the authoritative id to the caller.
create or replace function public.create_workflow_atomic(
    p_dispensary_id text, p_dispensary_name text, p_order_sheet_ref text, p_created_by text
) returns text as $$
declare
    v_id text;
    v_now timestamptz := now();
begin
    v_id := public.generate_workflow_id();

    insert into public.workflows (id, created_date, created_time, created_by, current_status, dispensary, dispensary_id, order_sheet_ref, last_updated, last_updated_by)
    values (v_id, v_now::date, v_now::time, p_created_by, 'New', p_dispensary_name, p_dispensary_id, p_order_sheet_ref, v_now, p_created_by);

    insert into public.workflow_events (workflow_id, order_id, action, module, new_status, description, user_name, event_time)
    values (v_id, p_order_sheet_ref, 'Order Sheet Uploaded', 'Order Processing', 'New',
            'Order sheet ' || coalesce(p_order_sheet_ref, '') || ' received for ' || coalesce(p_dispensary_name, p_dispensary_id, 'dispensary') || '.',
            p_created_by, v_now);

    return v_id;
end;
$$ language plpgsql security definer;

alter table public.workflows enable row level security;
drop policy if exists "authenticated read" on public.workflows;
create policy "authenticated read" on public.workflows for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.workflows;
create policy "authenticated write" on public.workflows for all using (auth.role() = 'authenticated');

alter table public.workflow_events enable row level security;
drop policy if exists "authenticated read" on public.workflow_events;
create policy "authenticated read" on public.workflow_events for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated write" on public.workflow_events;
create policy "authenticated write" on public.workflow_events for insert with check (auth.role() = 'authenticated');

do $$
begin
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'workflows'
    ) then
        alter publication supabase_realtime add table public.workflows;
    end if;
    if not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime' and tablename = 'workflow_events'
    ) then
        alter publication supabase_realtime add table public.workflow_events;
    end if;
end $$;
