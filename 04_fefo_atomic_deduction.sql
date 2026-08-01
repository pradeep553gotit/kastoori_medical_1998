-- ============================================================
-- Priority 1: FEFO-safe atomic deduction (ADDITIVE ONLY)
-- ============================================================
-- Context: deduct_stock_atomic() (supabase-schema.sql) already protects the
-- scalar `stock` column with a real atomic UPDATE ... WHERE stock >= p_qty.
-- Separately, the client (submitVerifiedOrder in app.js) already computes a
-- correct FEFO split of `batches` (earliest expiry first) -- but today it
-- writes that split back with a plain `.upsert()`, which is NOT covered by
-- deduct_stock_atomic's row lock. Two devices verifying orders for the same
-- medicine at the same instant can each compute a valid-looking FEFO split
-- from a stale batches array and race to overwrite each other's write.
-- Net effect: total `stock` stays correct (RPC-protected), but per-batch
-- quantities can be corrupted -- silently wrong expiry-batch bookkeeping.
--
-- Fix: do the FEFO split itself, server-side, inside the same atomic
-- transaction that decrements stock, under `for update` row lock.
--
-- This function is NEW. deduct_stock_atomic() is untouched and still used
-- by any other call site relying on scalar-only deduction.
-- ============================================================

create or replace function public.deduct_stock_fefo_atomic(
    p_code text,
    p_qty numeric,
    p_user text default null
)
returns table(
    success boolean,
    new_stock numeric,
    updated_batches jsonb,
    deducted_breakdown jsonb   -- [{batchNumber, expiryDate, qtyDeducted}, ...] for history/audit logging
) as $$
declare
    v_batches jsonb;
    v_total_available numeric;
    v_remaining numeric;
    v_result_batches jsonb := '[]'::jsonb;
    v_breakdown jsonb := '[]'::jsonb;
    v_batch record;
    v_deduct numeric;
    v_new_qty numeric;
begin
    -- Row lock: no other transaction can read/write this row's stock or
    -- batches until this transaction commits or rolls back.
    select batches into v_batches
    from public.inventory_items
    where code = p_code
    for update;

    if v_batches is null then
        return query select false, coalesce((select stock from public.inventory_items where code = p_code), 0), null::jsonb, null::jsonb;
        return;
    end if;

    -- Sanity check: sum of batch quantities must cover the request. Mirrors
    -- the existing client-side check (dbMatch.stock < qtyToDeduct) but now
    -- evaluated against the just-locked, definitely-current row.
    select coalesce(sum((b->>'quantity')::numeric), 0) into v_total_available
    from jsonb_array_elements(v_batches) b;

    if v_total_available < p_qty then
        return query select false, v_total_available, v_batches, null::jsonb;
        return;
    end if;

    v_remaining := p_qty;

    -- Sort batches earliest-expiry-first. Expiry format is "MM/YY" (matches
    -- app.js parseExpiryDate exactly): unparseable/missing expiry sorts LAST
    -- (treated as 2099-12-31), never blocking a real dated batch.
    for v_batch in
        select
            b.ord as orig_index,
            b.val as batch_json,
            coalesce(
                case
                    when (b.val->>'expiryDate') ~ '^\s*\d{1,2}\s*[\/\-\.]\s*\d{2,4}\s*$'
                    then make_date(
                        case when split_part(regexp_replace(b.val->>'expiryDate', '[\-\.\s]', '/', 'g'), '/', 2)::int < 100
                             then 2000 + split_part(regexp_replace(b.val->>'expiryDate', '[\-\.\s]', '/', 'g'), '/', 2)::int
                             else split_part(regexp_replace(b.val->>'expiryDate', '[\-\.\s]', '/', 'g'), '/', 2)::int
                        end,
                        split_part(regexp_replace(b.val->>'expiryDate', '[\-\.\s]', '/', 'g'), '/', 1)::int,
                        1
                    )
                    else date '2099-12-31'
                end,
                date '2099-12-31'
            ) as sort_expiry
        from jsonb_array_elements(v_batches) with ordinality as b(val, ord)
        order by sort_expiry asc, orig_index asc
    loop
        v_new_qty := (v_batch.batch_json->>'quantity')::numeric;

        if v_remaining > 0 and v_new_qty > 0 then
            v_deduct := least(v_new_qty, v_remaining);
            v_new_qty := v_new_qty - v_deduct;
            v_remaining := v_remaining - v_deduct;

            v_breakdown := v_breakdown || jsonb_build_object(
                'batchNumber', v_batch.batch_json->>'batchNumber',
                'expiryDate', v_batch.batch_json->>'expiryDate',
                'qtyDeducted', v_deduct
            );
        end if;

        v_result_batches := v_result_batches || jsonb_set(v_batch.batch_json, '{quantity}', to_jsonb(v_new_qty));
    end loop;

    if v_remaining > 0 then
        -- Shouldn't happen given the v_total_available check above, but
        -- never silently short-ship -- abort instead of partial-deducting.
        return query select false, v_total_available, v_batches, null::jsonb;
        return;
    end if;

    update public.inventory_items
    set batches = v_result_batches,
        stock = v_total_available - p_qty,
        updated_at = now(),
        updated_by = coalesce(p_user, updated_by)
    where code = p_code
    returning stock into v_total_available;

    return query select true, v_total_available, v_result_batches, v_breakdown;
end;
$$ language plpgsql security definer;

-- Grant execute to the same roles the existing atomic function relies on
-- (RLS on inventory_items already restricts table access; this function
-- runs as security definer like deduct_stock_atomic).
