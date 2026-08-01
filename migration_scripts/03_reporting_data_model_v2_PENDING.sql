-- ============================================================
-- Kastoori Medicals — Phase 1 v2: Enterprise Reporting Data Model
-- Builds on the EXISTING uuid-based schema (dispensaries, inventory,
-- inventory_movements already live but previously unwired), rather
-- than the text-id convention used by app.js's legacy tables.
--
-- CONFIRMED via code inspection (app.js contains zero .from() calls
-- to medicines/dispensaries/inventory/inventory_movements) that these
-- tables were unused scaffolding — safe to build on / recreate.
--
-- All statements are IF NOT EXISTS / additive. No drops of tables
-- that contain data (workflows, inventory_items, reorders,
-- not_available_items, supplier_bills, ocr_uploads, ocr_results,
-- medicine_history, inventory_transactions, purchase_images,
-- profiles, activity_logs are all left untouched, only extended).
-- ============================================================


-- ============================================================
-- SECTION A — medicines (recreated with uuid PK, Schema B style)
-- Faithful to original columns, plus a `code` linking column so
-- legacy text-based tables (inventory_items, reorders, etc.) can
-- still join to it without forcing a rewrite of app.js.
-- ============================================================

create table if not exists public.categories (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists public.brands (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists public.generics (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    created_at timestamptz not null default now()
);

create table if not exists public.medicines (
    id uuid primary key default gen_random_uuid(),
    code text unique,                  -- links to inventory_items.code / reorders.tablet_code
    brand_name text,
    generic_name text,
    strength text,
    dosage_form text,
    pack_size integer,
    manufacturer text,
    category text,                     -- kept for backward compatibility with original scaffold
    gst_percent numeric,
    hsn_code text,
    mrp numeric,
    status text default 'Active',
    -- new nullable normalized FKs, additive on top of the free-text columns above
    category_id uuid references public.categories(id) on delete set null,
    brand_id uuid references public.brands(id) on delete set null,
    generic_id uuid references public.generics(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);


-- ============================================================
-- SECTION B — Wire up the existing (previously unwired) tables
-- ============================================================

-- inventory.medicine_id and inventory_movements.medicine_id already
-- exist as plain uuid columns with no FK constraint. Add the FK now
-- that medicines exists. Using NOT VALID first is safest: it adds
-- the constraint without scanning/locking on existing (empty) data,
-- then VALIDATE confirms it. Since these tables have no confirmed
-- rows yet, this is low-risk, but written defensively regardless.

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'inventory_medicine_id_fkey'
    ) then
        alter table public.inventory
            add constraint inventory_medicine_id_fkey
            foreign key (medicine_id) references public.medicines(id) on delete set null
            not valid;
        alter table public.inventory validate constraint inventory_medicine_id_fkey;
    end if;
end $$;

do $$
begin
    if not exists (
        select 1 from pg_constraint where conname = 'inventory_movements_medicine_id_fkey'
    ) then
        alter table public.inventory_movements
            add constraint inventory_movements_medicine_id_fkey
            foreign key (medicine_id) references public.medicines(id) on delete set null
            not valid;
        alter table public.inventory_movements validate constraint inventory_movements_medicine_id_fkey;
    end if;
end $$;


-- ============================================================
-- SECTION C — pensioners (patient master; net new)
-- ============================================================

create table if not exists public.pensioners (
    id uuid primary key default gen_random_uuid(),
    pensioner_number text unique,
    full_name text not null,
    dispensary_id uuid references public.dispensaries(id) on delete set null,
    phone text,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION D — suppliers (net new, uuid style to match Schema B)
-- ============================================================

create table if not exists public.suppliers (
    id uuid primary key default gen_random_uuid(),
    name text not null unique,
    contact_person text,
    phone text,
    email text,
    gst_number text,
    address text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);


-- ============================================================
-- SECTION E — Orders & order line items
-- (extends workflows, which remains text-keyed — this is the one
-- deliberate bridge point between the legacy text-id world and
-- the new uuid-id world)
-- ============================================================

create table if not exists public.orders (
    workflow_id text primary key references public.workflows(id) on delete cascade,
    order_number text,
    pensioner_id uuid references public.pensioners(id) on delete set null,
    pensioner_name text,               -- raw OCR fallback before a pensioner match is made
    pensioner_number text,
    dispensary_id uuid references public.dispensaries(id) on delete set null,
    verification_status text check (verification_status in ('pending', 'verified', 'rejected')),
    ocr_confidence numeric,
    created_at timestamptz not null default now()
);

create table if not exists public.order_items (
    id uuid primary key default gen_random_uuid(),
    workflow_id text not null references public.orders(workflow_id) on delete cascade,
    medicine_id uuid references public.medicines(id) on delete set null,
    medicine_code_raw text,             -- raw OCR text / legacy code, kept even if match fails
    strength_label text,
    pack_size text,
    quantity_strips numeric,
    quantity_tablets numeric,
    status text check (status in ('pending', 'processing', 'completed', 'not_available', 'rejected')),
    completed_at timestamptz,
    created_at timestamptz not null default now()
);


-- ============================================================
-- SECTION F — Supplier invoice line items
-- ============================================================

alter table public.supplier_bills add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;
alter table public.supplier_bills add column if not exists invoice_time time without time zone;
alter table public.supplier_bills add column if not exists gst_amount numeric default 0;
alter table public.supplier_bills add column if not exists discount_amount numeric default 0;
alter table public.supplier_bills add column if not exists net_amount numeric;
alter table public.supplier_bills add column if not exists verification_status text
    check (verification_status in ('pending', 'verified', 'rejected'));
alter table public.supplier_bills add column if not exists workflow_id text references public.workflows(id) on delete set null;

create table if not exists public.supplier_invoice_items (
    id uuid primary key default gen_random_uuid(),
    supplier_bill_id uuid not null references public.supplier_bills(id) on delete cascade,
    medicine_id uuid references public.medicines(id) on delete set null,
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
-- SECTION G — Link legacy text-keyed tables to the new uuid
-- master data, additively (existing text columns untouched)
-- ============================================================

alter table public.inventory_transactions add column if not exists medicine_id uuid references public.medicines(id) on delete set null;
alter table public.inventory_transactions add column if not exists expiry_date date;
alter table public.inventory_transactions add column if not exists mrp numeric;
alter table public.inventory_transactions add column if not exists purchase_price numeric;
alter table public.inventory_transactions add column if not exists dispensary_id uuid references public.dispensaries(id) on delete set null;
alter table public.inventory_transactions add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;

alter table public.medicine_history add column if not exists medicine_id uuid references public.medicines(id) on delete set null;
alter table public.medicine_history add column if not exists dispensary_id uuid references public.dispensaries(id) on delete set null;
alter table public.medicine_history add column if not exists pensioner_id uuid references public.pensioners(id) on delete set null;

alter table public.reorders add column if not exists medicine_id uuid references public.medicines(id) on delete set null;
alter table public.reorders add column if not exists supplier_id uuid references public.suppliers(id) on delete set null;
alter table public.reorders add column if not exists dispensary_id_uuid uuid references public.dispensaries(id) on delete set null;
-- named dispensary_id_uuid to avoid colliding with the existing `dispensary_id text` column

alter table public.not_available_items add column if not exists medicine_id uuid references public.medicines(id) on delete set null;
alter table public.not_available_items add column if not exists dispensary_id_uuid uuid references public.dispensaries(id) on delete set null;

alter table public.ocr_results add column if not exists medicine_id uuid references public.medicines(id) on delete set null;
alter table public.ocr_results add column if not exists workflow_id text references public.workflows(id) on delete set null;

alter table public.due_orders add column if not exists medicine_id uuid references public.medicines(id) on delete set null;
alter table public.due_orders add column if not exists dispensary_id_uuid uuid references public.dispensaries(id) on delete set null;


-- ============================================================
-- SECTION H — Sales history, verification history, audit logs
-- (net new, uuid-keyed to match Schema B)
-- ============================================================

create table if not exists public.sales_history (
    id uuid primary key default gen_random_uuid(),
    sale_date date not null default current_date,
    medicine_id uuid references public.medicines(id) on delete set null,
    dispensary_id uuid references public.dispensaries(id) on delete set null,
    pensioner_id uuid references public.pensioners(id) on delete set null,
    quantity_tablets numeric not null,
    selling_price numeric,
    cost_price numeric,
    workflow_id text references public.workflows(id) on delete set null,
    created_at timestamptz not null default now()
);

create table if not exists public.verification_history (
    id uuid primary key default gen_random_uuid(),
    entity_type text not null check (entity_type in ('order', 'supplier_invoice', 'ocr_upload')),
    entity_id text not null,
    previous_status text,
    new_status text not null,
    changed_by text,
    remarks text,
    created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
    id uuid primary key default gen_random_uuid(),
    entity_type text not null,
    entity_id text not null,
    action text not null,
    changed_fields jsonb,
    performed_by text,
    performed_at timestamptz not null default now()
);


-- ============================================================
-- SECTION I — Indexes
-- ============================================================

create index if not exists idx_medicines_code on public.medicines (code);
create index if not exists idx_medicines_category_id on public.medicines (category_id);
create index if not exists idx_medicines_brand_id on public.medicines (brand_id);
create index if not exists idx_medicines_generic_id on public.medicines (generic_id);

create index if not exists idx_inventory_medicine on public.inventory (medicine_id);
create index if not exists idx_inventory_movements_medicine on public.inventory_movements (medicine_id);

create index if not exists idx_orders_pensioner on public.orders (pensioner_id);
create index if not exists idx_orders_dispensary on public.orders (dispensary_id);
create index if not exists idx_orders_verification on public.orders (verification_status);

create index if not exists idx_order_items_medicine on public.order_items (medicine_id);
create index if not exists idx_order_items_status on public.order_items (status);

create index if not exists idx_supplier_bills_supplier on public.supplier_bills (supplier_id);
create index if not exists idx_supplier_bills_date on public.supplier_bills (invoice_date);

create index if not exists idx_sii_medicine on public.supplier_invoice_items (medicine_id);
create index if not exists idx_sii_batch on public.supplier_invoice_items (batch_number);
create index if not exists idx_sii_expiry on public.supplier_invoice_items (expiry_date);

create index if not exists idx_inv_tx_medicine on public.inventory_transactions (medicine_id);
create index if not exists idx_inv_tx_dispensary on public.inventory_transactions (dispensary_id);
create index if not exists idx_inv_tx_expiry on public.inventory_transactions (expiry_date);

create index if not exists idx_medicine_history_medicine on public.medicine_history (medicine_id);
create index if not exists idx_medicine_history_dispensary on public.medicine_history (dispensary_id);

create index if not exists idx_reorders_medicine on public.reorders (medicine_id);
create index if not exists idx_reorders_supplier on public.reorders (supplier_id);

create index if not exists idx_sales_date on public.sales_history (sale_date);
create index if not exists idx_sales_medicine on public.sales_history (medicine_id);
create index if not exists idx_sales_dispensary on public.sales_history (dispensary_id);

create index if not exists idx_verification_history_entity on public.verification_history (entity_type, entity_id);
create index if not exists idx_audit_logs_entity on public.audit_logs (entity_type, entity_id);


-- ============================================================
-- SECTION J — RLS on all new/recreated tables
-- ============================================================

alter table public.categories enable row level security;
alter table public.brands enable row level security;
alter table public.generics enable row level security;
alter table public.medicines enable row level security;
alter table public.pensioners enable row level security;
alter table public.suppliers enable row level security;
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
        'categories','brands','generics','medicines','pensioners','suppliers',
        'orders','order_items','supplier_invoice_items','sales_history',
        'verification_history','audit_logs'
    ]
    loop
        execute format('drop policy if exists "authenticated read" on public.%I', t);
        execute format('create policy "authenticated read" on public.%I for select using (auth.role() = ''authenticated'')', t);
        execute format('drop policy if exists "authenticated write" on public.%I', t);
        execute format('create policy "authenticated write" on public.%I for all using (auth.role() = ''authenticated'')', t);
    end loop;
end $$;


-- ============================================================
-- SECTION K — Backfill medicines from inventory_items (additive,
-- on conflict do nothing, safe to run repeatedly)
-- ============================================================

insert into public.medicines (code, brand_name, category, status)
select
    i.code,
    i.brand,
    i.category,
    'Active'
from public.inventory_items i
where i.code is not null
on conflict (code) do nothing;

-- ============================================================
-- NOT YET DONE — flagged rather than guessed:
--
-- 1. dispensary_id_uuid / orders.dispensary_id / inventory.medicine_id
--    etc. are added as NULLABLE columns only. No backfill is attempted
--    here because I don't know the mapping between the legacy text
--    dispensary_id values (in workflows/reorders/due_orders) and
--    dispensaries.dispensary_code. Before backfilling, please run:
--
--    select distinct dispensary_id from public.workflows
--    where dispensary_id is not null limit 20;
--
--    select dispensary_code, dispensary_name from public.dispensaries limit 20;
--
--    and confirm whether these two sets actually correspond, or
--    whether dispensaries needs to be populated first.
--
-- 2. category_id / brand_id / generic_id on medicines are left null.
--    Categories/brands/generics lookup tables are created empty.
--    Once you confirm the canonical list of categories/brands/generics,
--    I'll generate the population + backfill SQL.
-- ============================================================
