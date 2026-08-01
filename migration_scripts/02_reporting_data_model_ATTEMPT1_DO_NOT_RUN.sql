-- ============================================================
-- Kastoori Medicals — Phase 1: Enterprise Reporting Data Model
-- Incremental migration. Safe to run on the existing project:
--   * every CREATE TABLE uses IF NOT EXISTS
--   * every ALTER TABLE uses ADD COLUMN IF NOT EXISTS
--   * no DROP, no data rewrite, no destructive statements
--   * existing tables (workflows, workflow_events, reorders,
--     inventory_items, not_available_items, purchase_images,
--     supplier_bills, ocr_uploads, ocr_results, medicine_history,
--     inventory_transactions) are extended, never replaced.
-- Run in Supabase SQL Editor. Review each section before running
-- if you want to apply them separately.
-- ============================================================


-- ============================================================
-- SECTION A — Master data (dimension tables)
-- ============================================================

-- ---- categories ----
create table if not exists public.categories (
    id text primary key,               -- e.g. 'CAT-TABLET', slug-style, matches your text-id convention
    name text not null unique,
    created_at timestamptz not null default now()
);

-- ---- brands ----
create table if not exists public.brands (
    id text primary key,
    name text not null unique,
    created_at timestamptz not null default now()
);

-- ---- generics ----
create table if not exists public.generics (
    id text primary key,
    name text not null unique,
    created_at timestamptz not null default now()
);

-- ---- medicines: master record, keyed by the code already used
--      throughout the app (inventory_items.code, reorders.tablet_code) ----
create table if not exists public.medicines (
    code text primary key,             -- same value as inventory_items.code
    name text not null,
    category_id text references public.categories(id) on delete set null,
    brand_id text references public.brands(id) on delete set null,
    generic_id text references public.generics(id) on delete set null,
    dosage_form text,                  -- tablet, capsule, syrup, injection, etc.
    tabs_per_strip numeric,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- ---- medicine_strengths: one medicine can have multiple strength SKUs
--      (e.g. Roseday 5mg, Roseday 10mg) ----
create table if not exists public.medicine_strengths (
    id text primary key,               -- e.g. medicine_code || '-' || strength_mg
    medicine_code text not null references public.medicines(code) on delete cascade,
    strength_mg numeric,
    strength_label text,               -- free-text fallback, e.g. "10mg" or "5ml"
    created_at timestamptz not null default now(),
    unique (medicine_code, strength_label)
);

-- ---- suppliers ----
create table if not exists public.suppliers (
    id text primary key,               -- e.g. 'SUP-0001', sequential via suppliers_id_counter below
    name text not null unique,
    contact_person text,
    phone text,
    email text,
    gst_number text,
    address text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.suppliers_id_counter (
    day_key text primary key,          -- mirrors workflow_id_counters pattern
    last_seq integer not null default 0
);

-- ---- dispensaries: keyed to match the dispensary_id text values
--      already used in workflows.dispensary_id / reorders.dispensary_id ----
create table if not exists public.dispensaries (
    id text primary key,               -- same value as existing dispensary_id text fields
    name text not null,
    location text,
    created_at timestamptz not null default now()
);

-- ---- pensioners (patient master) ----
create table if not exists public.pensioners (
    id text primary key,               -- e.g. pensioner_number if that's unique, else generated
    pensioner_number text unique,
    full_name text not null,
    dispensary_id text references public.dispensaries(id) on delete set null,
    phone text,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION B — Orders & order line items
-- (extends workflows rather than duplicating it — workflows
--  already holds order_sheet_ref / dispensary / status / dates)
-- ============================================================

-- ---- orders: 1:1 extension of workflows for order-sheet-specific
--      fields that don't belong in the generic workflow table ----
create table if not exists public.orders (
    workflow_id text primary key references public.workflows(id) on delete cascade,
    order_number text,
    pensioner_id text references public.pensioners(id) on delete set null,
    pensioner_name text,               -- denormalized fallback for OCR-extracted data
                                        -- before a pensioner master record is matched
    pensioner_number text,
    verification_status text check (verification_status in ('pending', 'verified', 'rejected')),
    ocr_confidence numeric,
    created_at timestamptz not null default now()
);

-- ---- order_items: one row per medicine line on an order sheet ----
create table if not exists public.order_items (
    id uuid primary key default gen_random_uuid(),
    workflow_id text not null references public.orders(workflow_id) on delete cascade,
    medicine_code text references public.medicines(code) on delete set null,
    medicine_name_raw text,            -- raw OCR text, kept even if medicine_code match fails
    strength_label text,
    pack_size text,
    quantity_strips numeric,
    quantity_tablets numeric,          -- always tablets, matching your existing convention
    status text check (status in ('pending', 'processing', 'completed', 'not_available', 'rejected')),
    completed_at timestamptz,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION C — Supplier invoices & line items
-- ============================================================

-- supplier_bills already exists (header). Add missing financial columns.
alter table public.supplier_bills add column if not exists supplier_id text references public.suppliers(id) on delete set null;
alter table public.supplier_bills add column if not exists invoice_time time without time zone;
alter table public.supplier_bills add column if not exists gst_amount numeric default 0;
alter table public.supplier_bills add column if not exists discount_amount numeric default 0;
alter table public.supplier_bills add column if not exists net_amount numeric;
alter table public.supplier_bills add column if not exists verification_status text
    check (verification_status in ('pending', 'verified', 'rejected'));
alter table public.supplier_bills add column if not exists workflow_id text references public.workflows(id) on delete set null;

-- ---- supplier_invoice_items: line-level detail (batch/expiry/MRP/pricing) ----
create table if not exists public.supplier_invoice_items (
    id uuid primary key default gen_random_uuid(),
    supplier_bill_id uuid not null references public.supplier_bills(id) on delete cascade,
    medicine_code text references public.medicines(code) on delete set null,
    medicine_name_raw text,
    batch_number text,
    expiry_date date,
    mrp numeric,
    purchase_price numeric,
    quantity numeric,
    line_total numeric,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION D — Inventory transactions: add batch/expiry/pricing
-- (columns your app currently only tracks in-memory / in JSONB
--  on inventory_items.batches, never queryable per-transaction)
-- ============================================================

alter table public.inventory_transactions add column if not exists expiry_date date;
alter table public.inventory_transactions add column if not exists mrp numeric;
alter table public.inventory_transactions add column if not exists purchase_price numeric;
alter table public.inventory_transactions add column if not exists dispensary_id text references public.dispensaries(id) on delete set null;
alter table public.inventory_transactions add column if not exists supplier_id text references public.suppliers(id) on delete set null;


-- ============================================================
-- SECTION E — medicine_history: add dispensary/pensioner linkage
-- (currently has no dispensary or pensioner columns at all,
--  which blocks the dispensary-wise / pensioner filters required)
-- ============================================================

alter table public.medicine_history add column if not exists dispensary_id text references public.dispensaries(id) on delete set null;
alter table public.medicine_history add column if not exists pensioner_id text references public.pensioners(id) on delete set null;
alter table public.medicine_history add column if not exists medicine_code text references public.medicines(code) on delete set null;


-- ============================================================
-- SECTION F — reorders: add FK columns alongside existing text
-- fields (fully backward compatible — nothing removed)
-- ============================================================

alter table public.reorders add column if not exists medicine_code text references public.medicines(code) on delete set null;
alter table public.reorders add column if not exists supplier_id text references public.suppliers(id) on delete set null;
alter table public.reorders add column if not exists dispensary_id_fk text references public.dispensaries(id) on delete set null;
-- named dispensary_id_fk to avoid colliding with the existing `dispensary_id text` column,
-- which you may still be populating from app code with values that aren't yet in `dispensaries`


-- ============================================================
-- SECTION G — not_available_items: add medicine FK
-- ============================================================

alter table public.not_available_items add column if not exists medicine_code text references public.medicines(code) on delete set null;
alter table public.not_available_items add column if not exists dispensary_id_fk text references public.dispensaries(id) on delete set null;


-- ============================================================
-- SECTION H — ocr_results: link OCR line items to real medicine records
-- ============================================================

alter table public.ocr_results add column if not exists medicine_code text references public.medicines(code) on delete set null;
alter table public.ocr_results add column if not exists workflow_id text references public.workflows(id) on delete set null;


-- ============================================================
-- SECTION I — Sales history (net-new; nothing captures a "sale"
-- as distinct from an order today)
-- ============================================================

create table if not exists public.sales_history (
    id uuid primary key default gen_random_uuid(),
    sale_date date not null default current_date,
    medicine_code text references public.medicines(code) on delete set null,
    dispensary_id text references public.dispensaries(id) on delete set null,
    pensioner_id text references public.pensioners(id) on delete set null,
    quantity_tablets numeric not null,
    selling_price numeric,
    cost_price numeric,
    workflow_id text references public.workflows(id) on delete set null,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION J — Verification history (append-only log; current
-- schema only stores current-state flags, not the history of
-- state changes required by "pending/completed verification
-- history" reports)
-- ============================================================

create table if not exists public.verification_history (
    id uuid primary key default gen_random_uuid(),
    entity_type text not null check (entity_type in ('order', 'supplier_invoice', 'ocr_upload')),
    entity_id text not null,           -- workflow_id, supplier_bill_id::text, or ocr_upload_id::text
    previous_status text,
    new_status text not null,
    changed_by text,
    remarks text,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION K — Audit log (generic, polymorphic; distinct from
-- activity_logs which is login/session-focused per DEPLOYMENT.md)
-- ============================================================

create table if not exists public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    entity_type text not null,         -- 'order', 'supplier_bill', 'inventory_item', 'reorder', etc.
    entity_id text not null,
    action text not null,              -- 'create', 'update', 'delete', 'approve', 'reject'
    changed_fields jsonb,               -- { "field": {"old": ..., "new": ...}, ... }
    performed_by text,
    performed_at timestamptz not null default now()
);


-- ============================================================
-- SECTION L — Indexes for the required search dimensions
-- (date, time, user, medicine, strength, generic, brand,
--  supplier, dispensary, pensioner, order#, invoice#, batch,
--  expiry, workflow status, verification status)
-- ============================================================

create index if not exists idx_medicines_category on public.medicines (category_id);
create index if not exists idx_medicines_brand on public.medicines (brand_id);
create index if not exists idx_medicines_generic on public.medicines (generic_id);

create index if not exists idx_orders_pensioner on public.orders (pensioner_id);
create index if not exists idx_orders_verification on public.orders (verification_status);

create index if not exists idx_order_items_medicine on public.order_items (medicine_code);
create index if not exists idx_order_items_status on public.order_items (status);
create index if not exists idx_order_items_workflow on public.order_items (workflow_id);

create index if not exists idx_supplier_bills_supplier on public.supplier_bills (supplier_id);
create index if not exists idx_supplier_bills_date on public.supplier_bills (invoice_date);
create index if not exists idx_supplier_bills_verification on public.supplier_bills (verification_status);

create index if not exists idx_sii_medicine on public.supplier_invoice_items (medicine_code);
create index if not exists idx_sii_batch on public.supplier_invoice_items (batch_number);
create index if not exists idx_sii_expiry on public.supplier_invoice_items (expiry_date);

create index if not exists idx_inv_tx_dispensary on public.inventory_transactions (dispensary_id);
create index if not exists idx_inv_tx_supplier on public.inventory_transactions (supplier_id);
create index if not exists idx_inv_tx_expiry on public.inventory_transactions (expiry_date);

create index if not exists idx_medicine_history_dispensary on public.medicine_history (dispensary_id);
create index if not exists idx_medicine_history_pensioner on public.medicine_history (pensioner_id);
create index if not exists idx_medicine_history_medicine_code on public.medicine_history (medicine_code);

create index if not exists idx_reorders_medicine on public.reorders (medicine_code);
create index if not exists idx_reorders_supplier_fk on public.reorders (supplier_id);
create index if not exists idx_reorders_status on public.reorders (status);

create index if not exists idx_sales_date on public.sales_history (sale_date);
create index if not exists idx_sales_medicine on public.sales_history (medicine_code);
create index if not exists idx_sales_dispensary on public.sales_history (dispensary_id);

create index if not exists idx_verification_history_entity on public.verification_history (entity_type, entity_id);
create index if not exists idx_audit_logs_entity on public.audit_logs (entity_type, entity_id);
create index if not exists idx_audit_logs_performed_at on public.audit_logs (performed_at);


-- ============================================================
-- SECTION M — Row Level Security on all new tables
-- (mirrors the authenticated-role pattern in supabase-schema.sql;
--  adjust if you introduce role-based claims later)
-- ============================================================

alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.generics enable row level security;
alter table public.medicines enable row level security;
alter table public.medicine_strengths enable row level security;
alter table public.suppliers enable row level security;
alter table public.dispensaries enable row level security;
alter table public.pensioners enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.supplier_invoice_items enable row level security;
alter table public.sales_history enable row level security;
alter table public.verification_history enable row level security;
alter table public.audit_logs enable row level security;

do $$
declare
    t text;
begin
    foreach t in array array[
        'categories','brands','generics','medicines','medicine_strengths',
        'suppliers','dispensaries','pensioners','orders','order_items',
        'supplier_invoice_items','sales_history','verification_history','audit_logs'
    ]
    loop
        execute format('drop policy if exists "authenticated read" on public.%I', t);
        execute format('create policy "authenticated read" on public.%I for select using (auth.role() = ''authenticated'')', t);
        execute format('drop policy if exists "authenticated write" on public.%I', t);
        execute format('create policy "authenticated write" on public.%I for all using (auth.role() = ''authenticated'')', t);
    end loop;
end $$;


-- ============================================================
-- SECTION N — Backfill medicines master from inventory_items
-- (additive only — INSERT ... ON CONFLICT DO NOTHING, never
--  overwrites, safe to run repeatedly)
-- ============================================================

insert into public.medicines (code, name, category_id, brand_id, tabs_per_strip)
select
    i.code,
    i.name,
    null,   -- category_id left null; categories master is empty until you populate it
    null,   -- brand_id left null; brands master is empty until you populate it
    i.tabs_per_strip
from public.inventory_items i
where i.code is not null
on conflict (code) do nothing;

-- Note: category_id / brand_id are left null in the backfill because
-- inventory_items.category and inventory_items.brand are free text,
-- and mapping them to categories.id / brands.id requires you to decide
-- the canonical slug for each (e.g. "Tablet" -> 'CAT-TABLET'). I can
-- generate that mapping SQL once you confirm the category/brand list —
-- flagging this rather than guessing at slugs.
