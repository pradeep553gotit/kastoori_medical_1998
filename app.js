// --- Tablet Inventory Management System JS Logic ---

(function() {
    // ============================================================
    // SUPABASE CLOUD CONFIG
    // Fill these in from your Supabase project: Settings -> API
    // ============================================================
    const SUPABASE_URL = "https://ahqgdwnnntdtlluwlhzt.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFocWdkd25ubnRkdGxsdXdsaHp0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNDYzMzcsImV4cCI6MjA5ODcyMjMzN30.EeMBYj2pxab65cXovQwp9irfHm4Uvfwwmi8zABdqZ2Y";

    let supabaseClient = null;
    try {
        if (window.supabase && SUPABASE_URL.startsWith("http")) {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        }
    } catch (e) {
        console.error("Supabase client init failed:", e);
    }

    // The single set of localStorage keys we mirror to the cloud "app_data" table.
    const CLOUD_SYNCED_KEYS = [
        "ti_tablets", "ti_scanned_orders", "ti_notifications", "ti_developer_logs",
        "ti_reorders", "ti_history", "ti_bills", "ti_due_orders", "ti_medicine_requests",
        "ti_audit_log"
    ];

    // Keys that failed to push to the cloud are queued here (persisted) and
    // retried automatically, so a transient network failure never silently
    // "loses" a save the way fire-and-forget-with-no-retry used to.
    const PENDING_SYNC_KEY = "ti_pending_sync";
    function getPendingSyncKeys() {
        try { return JSON.parse(localStorage.getItem(PENDING_SYNC_KEY) || "[]"); } catch (e) { return []; }
    }
    function setPendingSyncKeys(keys) {
        try { localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(keys)); } catch (e) { /* ignore */ }
    }
    function markKeyPending(key) {
        const keys = getPendingSyncKeys();
        if (!keys.includes(key)) {
            keys.push(key);
            setPendingSyncKeys(keys);
        }
    }
    function clearKeyPending(key) {
        const keys = getPendingSyncKeys().filter(k => k !== key);
        setPendingSyncKeys(keys);
    }

    // Push a single key's value up to Supabase. Awaited by callers that need
    // confirmation (e.g. Save buttons); on failure the key is queued for
    // automatic retry and the caller is told sync did not complete.
    async function pushKeyToCloud(key, rawValue) {
        if (!CLOUD_SYNCED_KEYS.includes(key)) return { ok: true, skipped: true };
        if (!supabaseClient) { markKeyPending(key); return { ok: false, reason: "Supabase not configured" }; }
        // Mark pending BEFORE the request starts (not just on failure). This closes
        // a race where a realtime update for an older value could arrive and
        // overwrite localStorage while this exact push is still in flight -- the
        // realtime handler and hydrateFromCloud() both skip any key currently
        // marked pending, so this client's own in-progress write is protected
        // until it resolves either way.
        markKeyPending(key);
        try {
            const { error } = await supabaseClient
                .from("app_data")
                .upsert({ key: key, value: JSON.parse(rawValue), updated_at: new Date().toISOString() }, { onConflict: "key" });
            if (error) throw error;
            clearKeyPending(key);
            return { ok: true };
        } catch (err) {
            console.error("Cloud sync failed for key", key, err);
            markKeyPending(key);
            if (window.app && typeof window.app.triggerNotification === "function") {
                window.app.triggerNotification(
                    "Inventory", "Cloud synchronization failure",
                    `🔴 Cloud Sync Failure\nStore: ${key}\nError: ${err.message || "Unknown error"}\nThis change is saved locally but has NOT been pushed to the cloud yet. It will retry automatically and will not be visible on other devices until sync succeeds.`,
                    "Critical", { errorDetails: err.message, stackTrace: err.stack }
                );
            }
            return { ok: false, reason: err.message || "Unknown error" };
        }
    }

    // Retries every locally-queued key that previously failed to sync.
    // Called on an interval and whenever the user manually refreshes.
    let _flushInFlight = false;
    async function flushPendingSync() {
        if (_flushInFlight) return;
        const keys = getPendingSyncKeys();
        if (keys.length === 0 || !supabaseClient) return;
        _flushInFlight = true;
        try {
            for (const key of keys) {
                const raw = localStorage.getItem(key);
                if (raw === null) { clearKeyPending(key); continue; }
                await pushKeyToCloud(key, raw);
            }
        } finally {
            _flushInFlight = false;
        }
    }
    setInterval(flushPendingSync, 20000);
    // Immediate retry the moment the browser regains connectivity, rather
    // than waiting for the next poll tick.
    window.addEventListener("online", () => { flushPendingSync(); });


    // Pull every synced key down from Supabase into localStorage. Called once after login,
    // before the app instantiates, so the whole app boots up already reading fresh cloud data.
    async function hydrateFromCloud() {
        if (!supabaseClient) return { ok: false, reason: "Supabase not configured" };
        try {
            const { data, error } = await supabaseClient.from("app_data").select("key, value");
            if (error) throw error;
            const pending = getPendingSyncKeys();
            (data || []).forEach(row => {
                // Never overwrite a key that still has an un-synced local
                // change queued -- that would silently discard the user's
                // edit. It will overwrite once flushPendingSync() succeeds.
                if (CLOUD_SYNCED_KEYS.includes(row.key) && !pending.includes(row.key)) {
                    localStorage.setItem(row.key, JSON.stringify(row.value));
                }
            });
            return { ok: true };
        } catch (err) {
            console.error("Cloud hydrate failed:", err);
            return { ok: false, reason: err.message || "Unknown error" };
        }
    }

    // ------------------------------------------------------------
    // Row-level dual-write helper (Phase 2.1 prerequisite).
    // Reorders / Due Orders / Medicine History are still kept as
    // localStorage arrays + the app_data blob sync above (so nothing
    // about existing behavior/offline-first UX changes), but we ALSO
    // best-effort upsert each row into its own normalized Supabase
    // table by stable id, so Dispensary Analytics can query them with
    // real SQL filters instead of parsing the whole blob client-side.
    // Fire-and-forget: never blocks the caller, never throws. Failures
    // are logged but not queued for retry here -- the next successful
    // setReorders()/setDueOrders()/logHistory() call re-upserts the
    // full current row anyway, which is a workable retry in practice
    // since these rows get touched again on every subsequent update.
    // ------------------------------------------------------------
    function syncRowToTable(tableName, row) {
        if (!supabaseClient || !row) return;
        supabaseClient.from(tableName).upsert(row, { onConflict: "id" })
            .then(({ error }) => {
                if (error) console.error(`Row sync to ${tableName} failed:`, error.message);
            })
            .catch(err => console.error(`Row sync to ${tableName} failed:`, err));
    }

    function syncReorderRow(r) {
        if (!r || !r.id) return;
        syncRowToTable("reorders", {
            id: r.id,
            workflow_id: r.workflowId || null,
            dispensary_id: r.dispensaryId || null,
            dispensary_name: r.dispensaryName || null,
            order_id: r.orderId || null,
            order_date: r.date || null,
            tablet_name: r.tabletName || null,
            tablet_code: r.tabletCode || null,
            generic_name: r.genericName || null,
            strength: r.strength || null,
            category: r.category || null,
            req_qty: r.reqQty ?? null,
            avail_qty: r.availQty ?? null,
            to_order_qty: r.toOrderQty ?? null,
            priority: r.priority || null,
            status: r.status || null,
            is_new_medicine: !!r.isNewMedicine,
            supplier: r.supplier || null,
            notes: r.notes || null,
            raw: r,
            last_updated: r.lastUpdated || new Date().toISOString()
        });
    }

    function syncDueOrderRow(d) {
        if (!d || !d.id) return;
        syncRowToTable("due_orders", {
            id: d.id,
            workflow_id: d.workflowId || null,
            dispensary_id: d.dispensaryId || null,
            dispensary_name: d.dispensaryName || null,
            order_id: d.orderId || null,
            tablet_name: d.tabletName || null,
            tablet_code: d.tabletCode || null,
            req_qty: d.reqQty ?? null,
            allocated_qty: d.allocatedQty ?? null,
            due_qty: d.dueQty ?? null,
            status: d.status || null,
            due_date: d.dueDate || null,
            notes: d.notes || null,
            raw: d,
            last_updated: d.lastUpdated || new Date().toISOString()
        });
    }

    function syncHistoryRow(entry) {
        if (!supabaseClient || !entry) return;
        supabaseClient.from("medicine_history").insert({
            medicine_code: entry.tabletCode || null,
            medicine_name: entry.tabletName || null,
            event_type: entry.type || null,
            batch_number: entry.batch || null,
            quantity: entry.qty ?? null,
            details: entry.details || null,
            performed_by: entry.performedBy || null,
            workflow_id: entry.workflowId || null
        }).then(({ error }) => {
            if (error) console.error("History sync failed:", error.message);
        }).catch(err => console.error("History sync failed:", err));
    }

    // Priority 2: append-only audit row for a strip-cut decision (either the
    // staff's explicit choice, or an automatic always_cut/never_cut outcome).
    // Same fire-and-forget shape as syncHistoryRow/syncAuditRow -- never
    // blocks or throws into the caller if Supabase/the migration isn't
    // available yet, so dispensing still works locally either way.
    function syncStripCutDecision(entry) {
        if (!supabaseClient || !entry) return;
        supabaseClient.from("strip_cut_decisions").insert({
            medicine_code: entry.medicineCode || null,
            medicine_name: entry.medicineName || null,
            batch_number: entry.batchNumber || null,
            order_ref: entry.orderRefId || null,
            workflow_id: entry.workflowId || null,
            requested_tablets: entry.qtyRequested ?? null,
            dispensed_tablets: entry.qtyDispensed ?? 0,
            deferred_tablets: entry.qtyDeferred ?? 0,
            tabs_per_strip: entry.tabsPerStrip ?? null,
            policy_at_decision: entry.policy || null,
            decision: entry.decision || null,
            decided_by: entry.decidedBy || null
        }).then(({ error }) => {
            if (error) console.warn("Strip-cut decision audit sync skipped (run migration_scripts/05_strip_cut_policy.sql):", error.message);
        }).catch(err => console.warn("Strip-cut decision audit sync failed:", err));
    }

    function syncInventoryTransactionRow(entry) {
        if (!supabaseClient || !entry) return;
        const typeMap = {
            "STOCK OUT": "stock_out",
            "Inventory Updated": "adjustment",
            "Due Order Completed": "stock_out"
        };
        supabaseClient.from("inventory_transactions").upsert({
            transaction_ref: entry.id,
            workflow_id: entry.workflowId || null,
            order_id: entry.orderId || null,
            medicine_code: entry.tabletCode || "UNKNOWN",   // NOT NULL column on the existing table
            medicine_name: entry.tabletName || null,
            medicine_id: entry.medicineId || null,
            strength_mg: entry.strength || null,
            manufacturer: entry.manufacturer || null,
            company: entry.company || null,
            batch_number: entry.batch || null,
            expiry_date: entry.expiryDate || null,
            purchase_price: entry.purchasePrice ?? null,
            mrp: entry.mrp ?? null,
            quantity_tablets: entry.qty ?? 0,
            previous_stock: entry.previousStock ?? null,
            new_stock: entry.newStock ?? null,
            transaction_type: entry.type || "adjustment",
            dispensary: entry.dispensaryName || entry.dispensaryId || null,
            supplier: entry.supplierName || null,
            reason: entry.reason || entry.details || null,
            verification_status: entry.verificationStatus || null,
            performed_by: entry.performedBy || null,
            performed_by_role: entry.performedByRole || null,
            audit_timestamp: new Date().toISOString()
        }, { onConflict: "transaction_ref" }).then(({ error }) => {
            if (error) console.error("inventory_transactions sync failed (run migration 06):", error.message);
        }).catch(err => console.error("inventory_transactions sync failed:", err));
    }

    function syncScannedOrderRow(o) {
        if (!o || !o.id) return;
        syncRowToTable("scanned_orders", {
            id: o.id,
            ref_id: o.refId || null,
            workflow_id: o.workflowId || null,
            dispensary_id: o.dispensaryId || null,
            dispensary_name: o.dispensaryName || null,
            order_date: o.date || null,
            status: o.status || null,
            medicines: o.medicines || [],
            last_updated: new Date().toISOString()
        });
    }

    function syncAuditRow(entry) {
        if (!entry || !entry.id) return;
        syncRowToTable("audit_logs", {
            id: entry.id,
            performed_by: entry.user || null,
            role: entry.role || null,
            module: entry.module || null,
            action: entry.action || null,
            record_label: entry.record || null,
            old_value: entry.oldValue ?? null,
            new_value: entry.newValue ?? null,
            workflow_id: entry.workflowId || null,
            log_date: entry.date || null,
            log_time: entry.time || null
        });
    }

    // Called once per finalized supplier bill import (not per keystroke).
    // Upserts on the (invoice_number, supplier_name, invoice_date,
    // medicine_code, batch_number) constraint from migration 06, so
    // re-processing the same invoice updates the same rows instead of
    // inserting duplicates -- see that migration's notes for the one
    // gap this doesn't cover (rows with a null medicine_code or batch).
    function syncInvoiceItemsRows(items, meta) {
        if (!supabaseClient || !items || !items.length) return;
        const rows = items.map(it => ({
            invoice_number: meta.invoiceNo || null,
            supplier_name: it.supplier_name || meta.supplier || null,
            invoice_date: it.bill_date || meta.date || null,
            medicine_name: it.name || null,
            medicine_code: it.code || null,
            brand_name: it.brand_name || null,
            generic_name: it.drug_name || null,
            batch_number: it.batch || null,
            expiry_date: it.exp || null,
            pack_size: it.pack || null,
            quantity: it.qty ?? null,
            quantity_unit: it.qty_unit || null,
            free_quantity: it.free_qty ?? null,
            free_unit: it.free_unit || null,
            mrp: it.mrp ?? null,
            purchase_price: it.cost ?? null,
            gst_percent: it.gst || null,
            discount_percent: it.discount_percent || null,
            confidence_score: it.confidence_score ?? null,
            workflow_id: meta.workflowId || null
        }));
        supabaseClient.from("supplier_invoice_items")
            .upsert(rows, { onConflict: "invoice_number,supplier_name,invoice_date,medicine_code,batch_number" })
            .then(({ error }) => { if (error) console.warn("supplier_invoice_items upsert skipped (run migration 06):", error.message); })
            .catch(err => console.warn("supplier_invoice_items upsert skipped:", err));
    }

    // Pulls the normalized Workflow History tables (workflows + workflow_events)
    // down into the same ti_workflows / ti_workflow_log localStorage shape the
    // rest of the app already reads synchronously. This is a read-through
    // cache, not the source of truth -- the source of truth is now the
    // `workflows` / `workflow_events` Supabase tables. Called once at boot
    // (alongside hydrateFromCloud) and on manual refresh.
    async function hydrateWorkflowsFromCloud() {
        if (!supabaseClient) return { ok: false, reason: "Supabase not configured" };
        try {
            const { data: wfRows, error: wfErr } = await supabaseClient
                .from("workflows").select("*").order("created_at", { ascending: true });
            if (wfErr) throw wfErr;
            const workflows = (wfRows || []).map(r => ({
                id: r.id, createdDate: r.created_date, createdTime: r.created_time, createdBy: r.created_by,
                currentStatus: r.current_status, dispensary: r.dispensary, dispensaryId: r.dispensary_id,
                orderSheetRef: r.order_sheet_ref, completionDate: r.completion_date, completionTime: r.completion_time,
                lastUpdated: r.last_updated, lastUpdatedBy: r.last_updated_by
            }));
            localStorage.setItem("ti_workflows", JSON.stringify(workflows));

            const { data: evRows, error: evErr } = await supabaseClient
                .from("workflow_events").select("*").order("event_time", { ascending: true });
            if (evErr) throw evErr;
            const log = (evRows || []).map(r => ({
                workflowId: r.workflow_id, action: r.action, user: r.user_name, role: r.role, module: r.module,
                description: r.description, previousStatus: r.previous_status, newStatus: r.new_status,
                remarks: r.remarks,
                date: r.event_time ? r.event_time.split("T")[0] : null,
                time: r.event_time ? r.event_time.split("T")[1].substring(0, 8) : null
            }));
            localStorage.setItem("ti_workflow_log", JSON.stringify(log));
            return { ok: true };
        } catch (err) {
            console.error("Workflow hydrate failed (keeping existing local cache):", err);
            return { ok: false, reason: err.message || "Unknown error" };
        }
    }

    // Realtime: subscribe to app_data changes so other connected clients see
    // edits (medicine add/edit, bill import, order verification, etc.)
    // without needing to manually refresh or log back in.
    let _realtimeChannel = null;
    function initRealtimeSync() {
        if (!supabaseClient || _realtimeChannel) return;
        try {
            _realtimeChannel = supabaseClient
                .channel("app_data_changes")
                .on("postgres_changes", { event: "*", schema: "public", table: "app_data" }, (payload) => {
                    const row = payload.new || payload.old;
                    if (!row || !CLOUD_SYNCED_KEYS.includes(row.key)) return;
                    // Don't clobber a local change still waiting to sync.
                    if (getPendingSyncKeys().includes(row.key)) return;
                    if (payload.new && payload.new.value !== undefined) {
                        localStorage.setItem(row.key, JSON.stringify(payload.new.value));
                        if (window.app && typeof window.app.onCloudDataChanged === "function") {
                            window.app.onCloudDataChanged(row.key);
                        }
                    }
                })
                .subscribe();
        } catch (e) {
            console.error("Realtime sync init failed:", e);
        }
    }

    // Call a Supabase Edge Function (create-user / delete-user / reset-password),
    // authenticated as the currently signed-in user (must be an Administrator —
    // the function itself re-checks this server-side, this is not the security boundary).
    async function callEdgeFunction(fnName, body) {
        if (!supabaseClient) throw new Error("Supabase is not configured.");
        const { data: sessionData } = await supabaseClient.auth.getSession();
        const token = sessionData && sessionData.session ? sessionData.session.access_token : null;
        if (!token) throw new Error("Not signed in.");
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
                // REQUIRED: Supabase's API gateway (Kong) rejects any /functions/v1/*
                // request with 401 Unauthorized unless an "apikey" header is present,
                // even when a valid user Authorization Bearer token is also sent.
                // supabase-js's functions.invoke() adds this automatically; a raw
                // fetch() call (as used here) must add it manually.
                "apikey": SUPABASE_ANON_KEY,
            },
            body: JSON.stringify(body || {}),
        });
        const json = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(json.error || `Request to ${fnName} failed.`);
        return json;
    }

    // Very lightweight browser/device sniff — good enough for an audit trail,
    // not meant to be a precise device-fingerprinting library.
    function getBrowserAndDevice() {
        const ua = navigator.userAgent || "";
        let browser = "Unknown Browser";
        if (ua.includes("Edg/")) browser = "Edge";
        else if (ua.includes("Chrome/") && !ua.includes("OPR/")) browser = "Chrome";
        else if (ua.includes("Firefox/")) browser = "Firefox";
        else if (ua.includes("Safari/") && !ua.includes("Chrome/")) browser = "Safari";
        else if (ua.includes("OPR/")) browser = "Opera";

        let device = "Desktop";
        if (/iPad/.test(ua)) device = "iPad";
        else if (/iPhone/.test(ua)) device = "iPhone";
        else if (/Android/.test(ua)) device = /Mobile/.test(ua) ? "Android Phone" : "Android Tablet";

        return { browser, device };
    }

    // Logs a "Failed Login" event BEFORE a session exists (narrow anon RLS policy allows only this).
    async function logFailedLoginGlobal(identifier) {
        if (!supabaseClient) return;
        try {
            const { browser, device } = getBrowserAndDevice();
            await supabaseClient.from("activity_logs").insert({
                employee_id: identifier || "unknown",
                full_name: null,
                role: null,
                event_type: "Failed Login",
                details: { identifier },
                browser, device,
            });
        } catch (err) {
            console.error("Failed to log failed-login event:", err);
        }
    }

    window.showForgotPasswordView = function() {
        document.getElementById("login-form-view").style.display = "none";
        document.getElementById("forgot-password-view").style.display = "flex";
    };
    window.showLoginFormView = function() {
        document.getElementById("forgot-password-view").style.display = "none";
        document.getElementById("login-form-view").style.display = "flex";
    };

    window.__selectedLoginRole = null;
    const ROLE_DISPLAY_LABELS = { "Staff": "Staff", "Senior Officer": "Senior Staff", "Administrator": "Administrator" };

    window.selectLoginRole = function(role) {
        window.__selectedLoginRole = role;
        document.querySelectorAll(".km-role-card").forEach(card => {
            card.classList.toggle("km-role-selected", card.getAttribute("data-role") === role);
        });
        const continueBtn = document.getElementById("km-role-continue-btn");
        if (continueBtn) {
            continueBtn.style.opacity = "1";
            continueBtn.style.pointerEvents = "auto";
        }
    };

    window.proceedToLoginStep = function() {
        if (!window.__selectedLoginRole) return;
        const step1 = document.getElementById("km-step1-wrap");
        const step2 = document.getElementById("km-step2");
        const pill = document.getElementById("km-selected-role-pill");
        if (pill) pill.textContent = `Signing in as: ${ROLE_DISPLAY_LABELS[window.__selectedLoginRole] || window.__selectedLoginRole}`;

        if (step1) { step1.style.opacity = "0"; setTimeout(() => { step1.style.display = "none"; }, 280); }
        if (step2) {
            step2.classList.remove("km-step-disabled");
            step2.style.display = "block";
            requestAnimationFrame(() => { step2.style.opacity = "1"; });
        }
        ["login-error", "km-access-denied-box", "km-login-success-box"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = "none";
        });
        setTimeout(() => { const f = document.getElementById("login-email"); if (f) f.focus(); }, 300);
    };

    window.backToRoleStep = function() {
        const step1 = document.getElementById("km-step1-wrap");
        const step2 = document.getElementById("km-step2");
        if (step2) { step2.style.opacity = "0"; setTimeout(() => { step2.style.display = "none"; }, 280); }
        if (step1) { step1.style.display = "block"; requestAnimationFrame(() => { step1.style.opacity = "1"; }); }
    };

    window.toggleLoginPasswordVisibility = function() {
        const input = document.getElementById("login-password");
        const icon = document.getElementById("km-eye-icon");
        if (!input) return;
        if (input.type === "password") {
            input.type = "text";
            icon.innerHTML = '<path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>';
        } else {
            input.type = "password";
            icon.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>';
        }
    };

    // Populates a background scene container with drifting particles, light beams,
    // a DNA helix, an ECG line, and floating medical icons. Called once per scene.
    window.initKmBackgroundScene = function(containerId) {
        const el = document.getElementById(containerId);
        if (!el || el.dataset.kmInitialized) return;
        el.dataset.kmInitialized = "1";

        // Particles
        for (let i = 0; i < 22; i++) {
            const p = document.createElement("div");
            p.className = "km-particle";
            const size = 3 + Math.random() * 5;
            p.style.width = size + "px";
            p.style.height = size + "px";
            p.style.left = Math.random() * 100 + "%";
            p.style.top = 60 + Math.random() * 40 + "%";
            p.style.animationDuration = (8 + Math.random() * 10) + "s";
            p.style.animationDelay = (Math.random() * 8) + "s";
            el.appendChild(p);
        }

        // Light beams
        for (let i = 0; i < 3; i++) {
            const b = document.createElement("div");
            b.className = "km-light-beam";
            b.style.left = (15 + i * 30) + "%";
            b.style.animationDelay = (i * 1.4) + "s";
            el.appendChild(b);
        }

        // DNA helix
        const dna = document.createElement("div");
        dna.className = "km-dna";
        dna.style.left = "8%";
        dna.style.top = "8%";
        for (let i = 0; i < 14; i++) {
            const rung = document.createElement("div");
            rung.className = "rung";
            rung.style.top = (i * 22) + "px";
            rung.style.animationDelay = (i * -0.35) + "s";
            rung.innerHTML = '<div class="rung-bar"></div>';
            dna.appendChild(rung);
        }
        el.appendChild(dna);

        // ECG heartbeat line (near the bottom)
        const ecgWrap = document.createElement("div");
        ecgWrap.className = "km-ecg-wrap";
        ecgWrap.style.bottom = "6%";
        ecgWrap.innerHTML = `
            <svg class="km-ecg-svg" viewBox="0 0 600 60" preserveAspectRatio="none">
                <path d="M0,30 L60,30 L75,10 L90,50 L105,30 L160,30 L175,15 L190,45 L205,30 L300,30 L315,10 L330,50 L345,30 L400,30 L415,15 L430,45 L445,30 L600,30
                         L660,30 L675,10 L690,50 L705,30 L760,30 L775,15 L790,45 L805,30 L900,30 L915,10 L930,50 L945,30 L1000,30 L1015,15 L1030,45 L1045,30 L1200,30"
                    fill="none" stroke="#4facfe" stroke-width="1.5"/>
            </svg>`;
        el.appendChild(ecgWrap);

        // Floating medical icons (capsule, tablet, cross, molecule)
        const icons = [
            '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#4facfe" stroke-width="1.6"><rect x="2" y="9" width="20" height="6" rx="3" transform="rotate(-30 12 12)"></rect><line x1="12" y1="6.5" x2="12" y2="17.5" transform="rotate(-30 12 12)"></line></svg>',
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00f2fe" stroke-width="1.6"><circle cx="12" cy="12" r="9"></circle><line x1="7" y1="12" x2="17" y2="12"></line></svg>',
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7b6ffb" stroke-width="1.8"><line x1="12" y1="4" x2="12" y2="20"></line><line x1="4" y1="12" x2="20" y2="12"></line></svg>',
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4facfe" stroke-width="1.6"><circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="6" r="2.5"></circle><circle cx="12" cy="18" r="2.5"></circle><line x1="6" y1="6" x2="12" y2="18"></line><line x1="18" y1="6" x2="12" y2="18"></line><line x1="6" y1="6" x2="18" y2="6"></line></svg>',
        ];
        const positions = [
            { top: "12%", left: "78%" }, { top: "68%", left: "88%" },
            { top: "80%", left: "12%" }, { top: "35%", left: "4%" },
            { top: "20%", left: "45%" }, { top: "55%", left: "60%" },
        ];
        positions.forEach((pos, i) => {
            const wrap = document.createElement("div");
            wrap.className = "km-float-icon";
            wrap.style.top = pos.top;
            wrap.style.left = pos.left;
            wrap.style.setProperty("--km-rot", (Math.random() * 30 - 15) + "deg");
            wrap.style.animationDuration = (5 + Math.random() * 4) + "s";
            wrap.style.animationDelay = (Math.random() * 3) + "s";
            wrap.innerHTML = icons[i % icons.length];
            el.appendChild(wrap);
        });
    };

    window.handleForgotPasswordSubmit = async function() {
        const empId = document.getElementById("forgot-employee-id").value.trim();
        const email = document.getElementById("forgot-email").value.trim();
        const statusEl = document.getElementById("forgot-status");
        const btn = document.getElementById("forgot-submit-btn");
        statusEl.classList.remove("hidden");

        if (!empId || !email) {
            statusEl.style.color = "#ff6b6b";
            statusEl.style.background = "rgba(255,107,107,0.1)";
            statusEl.textContent = "Please enter both your Employee ID and registered email.";
            return;
        }
        if (!supabaseClient) {
            statusEl.style.color = "#ff6b6b";
            statusEl.style.background = "rgba(255,107,107,0.1)";
            statusEl.textContent = "Cloud login is not configured yet.";
            return;
        }

        btn.disabled = true;
        btn.textContent = "Checking...";
        try {
            const { data: registeredEmail, error } = await supabaseClient.rpc("get_email_for_employee_id", { emp_id: empId });
            if (error) throw error;
            if (!registeredEmail || registeredEmail.toLowerCase() !== email.toLowerCase()) {
                throw new Error("Employee ID and email do not match our records.");
            }
            const { error: resetErr } = await supabaseClient.auth.resetPasswordForEmail(email);
            if (resetErr) throw resetErr;

            statusEl.style.color = "#4ade80";
            statusEl.style.background = "rgba(74,222,128,0.1)";
            statusEl.textContent = "If the details matched, a reset link has been sent to your email.";
        } catch (err) {
            // Deliberately vague to avoid confirming/denying which employee IDs exist
            statusEl.style.color = "#ff6b6b";
            statusEl.style.background = "rgba(255,107,107,0.1)";
            statusEl.textContent = "We couldn't verify those details. Please contact your Administrator.";
        } finally {
            btn.disabled = false;
            btn.textContent = "Send Reset Link";
        }
    };


    const PRELOADED_TABLETS = [
        { code: "ROS-20", name: "USV L. ROSEDAY 20MG", brand: "USV", drugName: "Rosuvastatin", pack: "15's", stock: 150, reorder: 50, cost: 280.00, mrp: 416.44 },
        { code: "GLY-250", name: "USV L. GLYCOMET 250MG", brand: "USV", drugName: "Metformin", pack: "10's", stock: 120, reorder: 40, cost: 10.00, mrp: 14.90 },
        { code: "SUP-XT", name: "PHAR SUPRACAL XT", brand: "PHAR", drugName: "Calcium + Vitamin D3", pack: "15's", stock: 80, reorder: 30, cost: 150.00, mrp: 220.31 },
        { code: "GLY-GP-0.5", name: "USV L. GLYCOMET GP 0.5", brand: "USV", drugName: "Glimepiride + Metformin", pack: "15's", stock: 140, reorder: 40, cost: 65.00, mrp: 94.90 },
        { code: "LUP-MEG", name: "USV L. LUPIMEG TAB", brand: "USV", drugName: "Lupimeg", pack: "15's", stock: 95, reorder: 30, cost: 150.00, mrp: 220.31 },
        { code: "REN-PLS", name: "GRAN RENERVE PLUS", brand: "GRAN", drugName: "Methylcobalamin", pack: "15's", stock: 65, reorder: 25, cost: 215.00, mrp: 329.62 },
        { code: "LUP-MED", name: "LUPIN LUPIMED 2.5MG", brand: "LUPIN", drugName: "Lupimed", pack: "10's", stock: 180, reorder: 50, cost: 210.00, mrp: 302.97 },
        { code: "TAZ-40", name: "USV L. TAZLOC 40MG", brand: "USV", drugName: "Telmisartan", pack: "15's", stock: 200, reorder: 60, cost: 70.00, mrp: 103.06 },
        { code: "STA-2.5", name: "REDD STAMLO 2.5MG", brand: "REDD", drugName: "Amlodipine", pack: "20's", stock: 100, reorder: 30, cost: 40.00, mrp: 61.14 },
        { code: "UNJ-FRT", name: "UNJOINT FORTE", brand: "UNJOINT", drugName: "Glucosamine", pack: "10's", stock: 110, reorder: 35, cost: 130.00, mrp: 185.97 },
        { code: "TAZ-40-30", name: "USV L. TAZLOC 40MG (30s)", brand: "USV", drugName: "Telmisartan", pack: "30's", stock: 120, reorder: 40, cost: 300.00, mrp: 439.45 },
        { code: "AMA-1", name: "AVEN AMARYL M 1MG", brand: "AVEN", drugName: "Amaryl", pack: "15's", stock: 90, reorder: 25, cost: 55.00, mrp: 79.63 },
        { code: "AZT-10", name: "SUN P AZTOR 10MG", brand: "SUN P", drugName: "Atorvastatin", pack: "10's", stock: 150, reorder: 45, cost: 130.00, mrp: 189.00 },
        { code: "PPG-0.3", name: "PRINC PPG 0.3MG", brand: "PRINC", drugName: "Voglibose", pack: "15's", stock: 70, reorder: 20, cost: 150.00, mrp: 216.66 },
        { code: "PEN-CM", name: "PENIS PENICIL.CM TAB", brand: "PENIS", drugName: "Penicillin", pack: "15's", stock: 60, reorder: 20, cost: 165.00, mrp: 238.90 },
        { code: "NUR-LC", name: "MANK NUROKIND LC", brand: "MANK", drugName: "Nurokind", pack: "10's", stock: 85, reorder: 25, cost: 70.00, mrp: 100.70 },
        { code: "FOL-TAB", name: "APEX FOLINZ TABS", brand: "APEX", drugName: "Folic Acid", pack: "10's", stock: 50, reorder: 15, cost: 35.00, mrp: 54.28 },
        { code: "FOL-5", name: "IPCAL FOLITRAX 5MG", brand: "IPCAL", drugName: "Methotrexate", pack: "10's", stock: 110, reorder: 30, cost: 110.00, mrp: 155.02 },
        { code: "SYS-EYE", name: "ALCO SYSTANE ULTRA EYE DROP", brand: "ALCO", drugName: "Polyethylene Glycol", pack: "1's", stock: 15, reorder: 5, cost: 400.00, mrp: 562.00 },
        { code: "HYD-AM", name: "REDD HYDROHEAL AM 15GM", brand: "REDD", drugName: "Hydroheal", pack: "1's", stock: 20, reorder: 5, cost: 130.00, mrp: 186.63 }
    ];

    const PRELOADED_HISTORY = [
        { datetime: "2026-06-19 14:30:22", type: "STOCK IN", tabletName: "USV L. ROSEDAY 20MG", batch: "INI-901", qty: 150, details: "Initial shop inventory load" },
        { datetime: "2026-06-19 14:31:05", type: "STOCK IN", tabletName: "USV L. GLYCOMET 250MG", batch: "INI-902", qty: 120, details: "Initial shop inventory load" },
        { datetime: "2026-06-19 14:32:15", type: "STOCK IN", tabletName: "USV L. TAZLOC 40MG", batch: "INI-908", qty: 200, details: "Initial shop inventory load" }
    ];

    const KASTOORI_INVOICE_ITEMS = [
        { name: "USV L. ROSEDAY 20MG", batch: "5012", exp: "02/28", pack: "15's", qty: 90, cost: 280.00, mrp: 416.44 },
        { name: "USV L. GLYCOMET 250MG", batch: "2232", exp: "07/28", pack: "10's", qty: 90, cost: 10.00, mrp: 14.90 },
        { name: "PHAR SUPRACAL XT", batch: "5009", exp: "04/27", pack: "15's", qty: 90, cost: 150.00, mrp: 220.31 },
        { name: "USV L. GLYCOMET GP 0.5", batch: "578B", exp: "09/27", pack: "15's", qty: 90, cost: 65.00, mrp: 94.90 },
        { name: "USV L. LUPIMEG TAB", batch: "5143", exp: "06/27", pack: "15's", qty: 90, cost: 150.00, mrp: 220.31 },
        { name: "GRAN RENERVE PLUS", batch: "1747", exp: "10/27", pack: "15's", qty: 90, cost: 215.00, mrp: 329.62 },
        { name: "LUPIN LUPIMED 2.5MG", batch: "0395", exp: "06/28", pack: "10's", qty: 90, cost: 210.00, mrp: 302.97 },
        { name: "USV L. TAZLOC 40MG", batch: "9035", exp: "05/27", pack: "15's", qty: 90, cost: 70.00, mrp: 103.06 },
        { name: "REDD STAMLO 2.5MG", batch: "0094", exp: "04/27", pack: "20's", qty: 90, cost: 40.00, mrp: 61.14 },
        { name: "UNJOINT FORTE", batch: "F423", exp: "08/27", pack: "10's", qty: 180, cost: 130.00, mrp: 185.97 },
        { name: "USV L. TAZLOC 40MG", batch: "0395", exp: "04/27", pack: "30's", qty: 90, cost: 300.00, mrp: 439.45 },
        { name: "AVEN AMARYL M 1MG", batch: "696A", exp: "05/28", pack: "15's", qty: 90, cost: 55.00, mrp: 79.63 },
        { name: "SUN P AZTOR 10MG", batch: "0052", exp: "09/29", pack: "10's", qty: 180, cost: 130.00, mrp: 189.00 },
        { name: "PRINC PPG 0.3MG", batch: "5645", exp: "09/27", pack: "15's", qty: 90, cost: 150.00, mrp: 216.66 },
        { name: "PENIS PENICIL.CM TAB", batch: "0012", exp: "08/27", pack: "15's", qty: 90, cost: 165.00, mrp: 238.90 },
        { name: "MANK NUROKIND LC", batch: "AT060425", exp: "03/28", pack: "10's", qty: 20, cost: 70.00, mrp: 100.70 },
        { name: "APEX FOLINZ TABS", batch: "5002", exp: "09/26", pack: "10's", qty: 20, cost: 35.00, mrp: 54.28 },
        { name: "IPCAL FOLITRAX 5MG", batch: "GOU0125010", exp: "09/26", pack: "10's", qty: 30, cost: 110.00, mrp: 155.02 },
        { name: "ALCO SYSTANE ULTRA EYE DROP", batch: "K7R7", exp: "06/27", pack: "1's", qty: 2, cost: 400.00, mrp: 562.00 },
        { name: "REDD HYDROHEAL AM 15GM", batch: "2520", exp: "06/27", pack: "1's", qty: 1, cost: 130.00, mrp: 186.63 }
    ];

    const KASTOORI_INVOICE_ITEMS_405 = [
        { name: "INTAS CLAVIX 75MG", batch: "2944", exp: "08/27", pack: "15's", qty: 180, cost: 76.27, mrp: 106.78 },
        { name: "AVEN AMARYL M 1MG", batch: "F423", exp: "08/27", pack: "15's", qty: 180, cost: 76.27, mrp: 106.78 },
        { name: "GLEN TELMA 20MG", batch: "0809", exp: "10/27", pack: "30's", qty: 180, cost: 216.40, mrp: 302.97 },
        { name: "MICR ARBITEL 40MG", batch: "0190", exp: "11/27", pack: "20's", qty: 180, cost: 86.78, mrp: 121.50 },
        { name: "ALLE REFRESH LIQUIGEL", batch: "GT00348A", exp: "12/26", pack: "15's", qty: 90, cost: 77.35, mrp: 108.30 },
        { name: "SUN P LATOCOM EYE DROPS", batch: "1786", exp: "10/27", pack: "1's", qty: 4, cost: 467.85, mrp: 655.00 },
        { name: "NOVA AZOPT EYE DROPS", batch: "VLE95A", exp: "09/26", pack: "1's", qty: 5, cost: 467.85, mrp: 655.00 },
        { name: "ANGL ALPHAGAN Z DROPS", batch: "121541", exp: "01/27", pack: "1's", qty: 6, cost: 126.50, mrp: 177.11 },
        { name: "GERM COMPLAMINA RETARD", batch: "0528", exp: "09/29", pack: "10's", qty: 30, cost: 391.89, mrp: 548.65 },
        { name: "SUNW EYEVITAL LX", batch: "0125", exp: "09/29", pack: "10's", qty: 30, cost: 130.00, mrp: 182.00 },
        { name: "SUN P SIZOPIN 50MG", batch: "0525", exp: "09/29", pack: "10's", qty: 60, cost: 36.10, mrp: 50.54 },
        { name: "LINK REXITTE PLUS", batch: "5015", exp: "05/27", pack: "15's", qty: 90, cost: 233.93, mrp: 327.51 }
    ];

    const KASTOORI_INVOICE_ITEMS_398 = [
        { name: "USV L. ECOSPRIN GOLD 10MG", batch: "5021", exp: "11/26", pack: "15's", qty: 60, cost: 92.27, mrp: 129.19 },
        { name: "GLEN TELMA BETA 25MG", batch: "4013", exp: "09/26", pack: "10's", qty: 90, cost: 162.05, mrp: 226.88 },
        { name: "CIPLA DYTOR 5MG", batch: "1398", exp: "04/27", pack: "15's", qty: 90, cost: 58.10, mrp: 81.35 },
        { name: "MSD JANUMET 50/500MG 15'S", batch: "5074", exp: "08/27", pack: "15's", qty: 180, cost: 276.07, mrp: 386.50 },
        { name: "RANB ROSUVAS 5MG", batch: "293A", exp: "04/28", pack: "15's", qty: 90, cost: 196.93, mrp: 275.71 },
        { name: "REDD OMEZ 20MG", batch: "0157", exp: "06/28", pack: "20's", qty: 90, cost: 43.73, mrp: 61.23 }
    ];

    const KASTOORI_INVOICE_ITEMS_401 = [
        { name: "MANO MUCUSNIL D SYP", batch: "0052", exp: "09/29", pack: "1's", qty: 1, cost: 146.42, mrp: 205.00 }
    ];


    class TabletInventoryApp {
        constructor() {
            this.initStore();
            this.activeView = "dashboard-view";
            this.charts = {};
            this.currentExtractedBill = null;
            this.currentVerifiedOrder = null;
            this.scanAnimationId = null;
            const savedRole = localStorage.getItem("ti_user_role") || "Administrator";
            this.currentUser = { name: "Staff Admin", role: savedRole };

            this.bindEvents();
            this.renderAll();
            this.initPWA();
            this.checkSystemAlerts();
            setInterval(() => this.checkSystemAlerts(), 30 * 60 * 1000);
        }

        // Map of view id -> its render function, reused by both the sidebar
        // navigation switch and the manual Refresh buttons / realtime sync.
        renderViewById(targetViewId) {
            if (targetViewId === "dashboard-view") this.renderDashboard();
            else if (targetViewId === "master-view") this.renderTabletList();
            else if (targetViewId === "inventory-view") this.renderInventoryAdjustPage();
            else if (targetViewId === "due-view") this.renderDueOrdersPage();
            else if (targetViewId === "supplier-due-view") this.renderSupplierDuePage();
            else if (targetViewId === "expiry-view") this.renderExpiryPage();
            else if (targetViewId === "not-available-view") this.renderNotAvailablePage();
            else if (targetViewId === "reports-view") this.renderReports();
            else if (targetViewId === "reorder-view") this.renderReorderPage();
            else if (targetViewId === "order-view") { if (this.verificationRawItems) this.renderVerificationReport(); }
            else if (targetViewId === "bill-view") this.renderProcessedBillsTable();
            else if (targetViewId === "user-mgmt-view") this.renderUserManagementTable();
            else if (targetViewId === "activity-log-view") this.renderActivityLogPage();
            this.renderDashboard();
            this.updateDueBadges();
            this.updateReorderBadge();
            this.updateSupplierDueBadge();
        }

        // Manual "Refresh" button handler used across every module. Pulls the
        // latest committed data from the cloud (Supabase), retries any
        // changes still waiting to sync, and re-renders the current view.
        async refreshCurrentModule(viewId) {
            const target = viewId || this.activeView;
            this.showToast("Refreshing from cloud...", "info");
            await flushPendingSync();
            const result = await hydrateFromCloud();
            await hydrateWorkflowsFromCloud();
            this.renderViewById(target);
            if (result.ok) {
                this.showToast("Data refreshed from the cloud.", "success");
            } else if (result.reason === "Supabase not configured") {
                this.showToast("Refreshed local data (cloud sync not configured).", "info");
            } else {
                this.showToast(`Refresh failed: ${result.reason}`, "error");
            }
        }

        // Called by the realtime subscription when another connected user's
        // change lands in the cloud, so this session's data + UI stay live
        // without requiring a manual refresh.
        onCloudDataChanged(key) {
            this.renderViewById(this.activeView);
            this.showToast("Data updated by another user.", "info");
        }

        // Used for high-stakes saves (Add/Edit Medicine) where we want to
        // tell the user explicitly whether the change reached the cloud
        // database yet, rather than assuming success the instant it's
        // written to localStorage.
        async saveWithCloudConfirmation(key, data, moduleLabel, friendlyLabel) {
            const raw = JSON.stringify(data);
            // skipCloudPush=true: this function pushes and awaits the cloud write
            // itself two lines below, so _safeSetItem must not ALSO fire its own
            // (previously redundant, doubled every write to Supabase).
            const localOk = this._safeSetItem(key, raw, moduleLabel, friendlyLabel, true);
            if (!localOk) return { ok: false, cloudOk: false };
            if (!supabaseClient) return { ok: true, cloudOk: false, reason: "not_configured" };
            const result = await pushKeyToCloud(key, raw);
            return { ok: true, cloudOk: result.ok, reason: result.reason };
        }

        // Disables a button (and shows "Saving...") for the duration of an
        // async action, so double-clicks can't fire the same save/import/
        // verify/approve/delete action twice. Restores the original label
        // and re-enables the button when done, even if the action throws.
        async withButtonLoading(button, savingLabel, actionFn) {
            if (!button) return await actionFn();
            if (button.disabled) return; // already in flight — ignore the click
            const originalHTML = button.innerHTML;
            const originalDisabled = button.disabled;
            button.disabled = true;
            button.innerHTML = savingLabel || "Saving...";
            try {
                return await actionFn();
            } finally {
                button.disabled = originalDisabled;
                button.innerHTML = originalHTML;
            }
        }

        // Commits changes to several stores as one logical unit: writes all
        // of them to localStorage (so the user's work is never lost even if
        // the network is down), then pushes every key to Supabase. If every
        // push succeeds, the batch is fully cloud-committed. If any push
        // fails, those specific key(s) are already in the automatic retry
        // queue (see pushKeyToCloud/flushPendingSync) and will sync as soon
        // as connectivity allows — nothing is silently lost, but note this
        // is "eventually consistent across keys", not a true multi-table
        // SQL transaction (the underlying store is one JSON blob per key).
        async commitBatch(entries, moduleLabel) {
            const results = [];
            for (const e of entries) {
                const r = await this.saveWithCloudConfirmation(e.key, e.data, moduleLabel, e.label);
                results.push({ key: e.key, ...r });
            }
            const allCloudOk = results.every(r => r.cloudOk || r.reason === "not_configured");
            const allLocalOk = results.every(r => r.ok);
            return { allLocalOk, allCloudOk, results };
        }

        // Minimal audit trail (User / Module / Action / Old Value / New
        // Value / Date / Time) as required for pharmaceutical inventory
        // tracking. Stored as its own cloud-synced key so it survives
        // refresh/logout and is visible to every connected user.
        getAuditLog() { return JSON.parse(localStorage.getItem("ti_audit_log") || "[]"); }
        logAudit(module, action, oldValue, newValue, recordLabel, workflowId = null) {
            const log = this.getAuditLog();
            const nowStr = new Date().toISOString().replace("T", " ").substring(0, 19);
            const entry = {
                id: `aud-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                user: this.currentUser ? this.currentUser.name : "Unknown",
                role: this.currentUser ? this.currentUser.role : "Unknown",
                module,
                action,
                record: recordLabel || "",
                oldValue: oldValue === undefined ? null : oldValue,
                newValue: newValue === undefined ? null : newValue,
                workflowId: workflowId || null,
                date: nowStr.split(" ")[0],
                time: nowStr.split(" ")[1]
            };
            log.push(entry);
            // Cap growth — audit log is a running history, not unbounded.
            if (log.length > 5000) log.splice(0, log.length - 5000);
            this._safeSetItem("ti_audit_log", JSON.stringify(log), module, "Audit Log");
            syncAuditRow(entry);
        }

        checkSystemAlerts() {
            const tablets = this.getTablets();
            const notifications = this.getNotifications();
            const today = new Date();
            const EXPIRY_WARNING_DAYS = 90;

            const hasOpenAlert = (errorType, medicineName) => notifications.some(n =>
                n.status === "Active" && n.errorType === errorType && n.medicineName === medicineName
            );

            tablets.forEach(t => {
                const stock = t.stock || 0;
                const reorderLevel = t.reorder || 0;
                if (reorderLevel > 0 && stock <= reorderLevel && !hasOpenAlert("Critical low stock", t.name)) {
                    this.triggerNotification(
                        "Inventory", "Critical low stock",
                        `Critical Low Stock - Medicine: "${t.name}". Available: ${stock} tablets (Reorder Level: ${reorderLevel}). Please raise a purchase order soon.`,
                        "Warning", { medicineName: t.name }
                    );
                }

                (t.batches || []).forEach(b => {
                    if (!b.expiryDate) return;
                    const expDate = this.parseExpiryDate(b.expiryDate);
                    if (!expDate || isNaN(expDate.getTime())) return;
                    const diffDays = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
                    if (diffDays <= EXPIRY_WARNING_DAYS && !hasOpenAlert("Expiring medicine", t.name)) {
                        const label = diffDays < 0 ? `expired ${Math.abs(diffDays)} day(s) ago` : `expires in ${diffDays} day(s)`;
                        this.triggerNotification(
                            "Inventory", "Expiring medicine",
                            `Expiring Medicine - "${t.name}", Batch: ${b.batchNumber || "N/A"} (Exp: ${b.expiryDate}), ${label}.`,
                            diffDays < 0 ? "Critical" : "Warning", { medicineName: t.name }
                        );
                    }
                });
            });
        }

        initPWA() {
            // Register Service Worker
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                    navigator.serviceWorker.register('./sw.js')
                        .then(reg => {
                            console.log('Service Worker registered successfully:', reg.scope);
                            
                            reg.onupdatefound = () => {
                                const newWorker = reg.installing;
                                if (newWorker) {
                                    newWorker.onstatechange = () => {
                                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                            console.log('New content is available; please refresh.');
                                        }
                                    };
                                }
                            };
                        })
                        .catch(err => console.error('Service Worker registration failed:', err));
                });
            }

            // Version check to invalidate caches on version bump
            try {
                const versionEl = document.getElementById("app-cache-version");
                const currentVersion = versionEl ? versionEl.textContent.replace("App Cache Version:", "").trim() : "V64";
                const savedVersion = localStorage.getItem("ti_app_version");

                if (savedVersion && savedVersion !== currentVersion) {
                    localStorage.setItem("ti_app_version", currentVersion);
                    if ('serviceWorker' in navigator) {
                        navigator.serviceWorker.getRegistrations().then(registrations => {
                            Promise.all(registrations.map(r => r.unregister())).then(() => {
                                if ('caches' in window) {
                                    caches.keys().then(names => {
                                        Promise.all(names.map(name => caches.delete(name))).then(() => {
                                            console.log('Cleared all caches and service workers. Reloading...');
                                            window.location.reload(true);
                                        });
                                    });
                                } else {
                                    window.location.reload(true);
                                }
                            });
                        });
                    } else {
                        window.location.reload(true);
                    }
                } else if (!savedVersion) {
                    localStorage.setItem("ti_app_version", currentVersion);
                }
            } catch (e) {
                console.warn("PWA version check error:", e);
            }

            // Install Prompt Interceptor
            let deferredPrompt;
            const pwaContainer = document.getElementById("pwa-install-container");
            const pwaBtn = document.getElementById("pwa-install-btn");

            window.addEventListener('beforeinstallprompt', (e) => {
                // Prevent the mini-infobar from appearing on mobile
                e.preventDefault();
                // Stash the event so it can be triggered later.
                deferredPrompt = e;
                // Update UI notify the user they can install the PWA
                if (pwaContainer) {
                    pwaContainer.classList.remove("hidden");
                }
            });

            if (pwaBtn) {
                pwaBtn.addEventListener('click', async () => {
                    if (!deferredPrompt) return;
                    // Show the install prompt
                    deferredPrompt.prompt();
                    // Wait for the user to respond to the prompt
                    const { outcome } = await deferredPrompt.userChoice;
                    console.log(`User response to the install prompt: ${outcome}`);
                    // We've used the prompt, and can't use it again
                    deferredPrompt = null;
                    // Hide the install button
                    if (pwaContainer) {
                        pwaContainer.classList.add("hidden");
                    }
                });
            }

            window.addEventListener('appinstalled', (event) => {
                console.log('App was installed.');
                // Hide the install button
                if (pwaContainer) {
                    pwaContainer.classList.add("hidden");
                }
            });
        }

        // Initialize state inside localStorage
        initStore() {
            const currentTablets = JSON.parse(localStorage.getItem("ti_tablets") || "[]");
            if (currentTablets.length < 15) {
                localStorage.setItem("ti_tablets", JSON.stringify(PRELOADED_TABLETS));
            }
            this.migrateTabletsSchema();
            if (!localStorage.getItem("ti_history")) {
                localStorage.setItem("ti_history", JSON.stringify(PRELOADED_HISTORY));
            }
            if (!localStorage.getItem("ti_bills")) {
                localStorage.setItem("ti_bills", JSON.stringify([]));
            }
            if (!localStorage.getItem("ti_due_orders")) {
                localStorage.setItem("ti_due_orders", JSON.stringify([]));
            }
            // Force pre-populate the provided active key to replace any invalid or missing keys
            const currentKey = localStorage.getItem("ti_ai_key");
            if (!currentKey || !currentKey.startsWith("AIza") || currentKey.includes("FakeKey") || currentKey === "AQ.Ab8RN6JEbqSKrM4Lya5ZR7JCstJXT9jjTQStF8wArkPwk8iyQ") {
                localStorage.setItem("ti_ai_key", "AIzaSyA9Pvr6UmnNJRxfXu6BiTzmVqJuKb6VeAM");
            }
        }

        migrateTabletsSchema() {
            let tablets = JSON.parse(localStorage.getItem("ti_tablets") || "[]");
            let migrated = false;
            tablets = tablets.map(t => {
                t.gst = t.gst || "5%";
                if (!t.batches || t.batches.length === 0) {
                    t.batches = [{
                        batchNumber: "INI-BATCH",
                        expiryDate: "12/28",
                        quantity: t.stock,
                        mrp: t.mrp,
                        cost: t.cost
                    }];
                    migrated = true;
                }
                
                // Backfill category ONLY for legacy records that don't have one
                // yet. This must NEVER overwrite an existing category -- doing
                // so on every app boot (this function runs from the
                // constructor on every single load) was silently reverting any
                // manually-edited/custom category (e.g. "Injection" ->
                // "Prescription Injection") back to the auto-detected guess
                // moments after the user saved it. Auto-detection is only a
                // best-effort default for brand-new records; once a category
                // is set, it's a deliberate, permanent value.
                if (!t.category) {
                    t.category = this.detectCategoryFromName(t.name, t.pack);
                    migrated = true;
                }

                // Add pack dimensions if missing
                const packSize = this.parsePackSize(t.pack, t.name);
                if (!t.tabsPerStrip || !t.stripsPerBox || !t.totalTablets) {
                    t.tabsPerStrip = packSize.tabsPerStrip;
                    t.stripsPerBox = packSize.stripsPerBox;
                    t.totalTablets = packSize.totalTablets;
                    migrated = true;
                }

                t.stock = t.batches.reduce((sum, b) => sum + b.quantity, 0);
                return t;
            });
            if (migrated) {
                localStorage.setItem("ti_tablets", JSON.stringify(tablets));
            }
        }

        async initGeminiConnection() {
            let key = localStorage.getItem("ti_ai_key");
            const needsDefault = !key || !key.startsWith("AIza") || key.includes("FakeKey") || key === "AQ.Ab8RN6JEbqSKrM4Lya5ZR7JCstJXT9jjTQStF8wArkPwk8iyQ";
            if (needsDefault) {
                key = "AIzaSyA9Pvr6UmnNJRxfXu6BiTzmVqJuKb6VeAM";
                localStorage.setItem("ti_ai_key", key);
            }

            const overlay = document.getElementById("gemini-setup-overlay");
            const mainContent = document.getElementById("uploader-main-content");
            const keyInput = document.getElementById("gemini-setup-key-input");

            // Ensure uploader is always visible and overlay is always hidden
            if (overlay) overlay.classList.add("hidden");
            if (mainContent) mainContent.classList.remove("hidden");

            if (keyInput) {
                keyInput.value = key;
            }

            this.updateGeminiStatusUI(true);

            // Asynchronously verify key and fall back to default if it fails
            if (!needsDefault && key !== "AIzaSyA9Pvr6UmnNJRxfXu6BiTzmVqJuKb6VeAM") {
                const res = await this.testGeminiConnection(key);
                if (!res.success) {
                    console.warn("Stored API Key failed verification. Falling back to default working API key.");
                    localStorage.setItem("ti_ai_key", "AIzaSyA9Pvr6UmnNJRxfXu6BiTzmVqJuKb6VeAM");
                    if (keyInput) {
                        keyInput.value = "AIzaSyA9Pvr6UmnNJRxfXu6BiTzmVqJuKb6VeAM";
                    }
                }
            }
        }

        updateGeminiStatusUI(isConnected, customText = null) {
            const statusBadgeSetup = document.getElementById("gemini-setup-status-badge");
            const statusBadgeActive = document.getElementById("gemini-active-status-badge");

            if (isConnected) {
                if (statusBadgeSetup) {
                    statusBadgeSetup.className = "status-badge badge-success";
                    statusBadgeSetup.textContent = customText || "Gemini Connected";
                }
                if (statusBadgeActive) {
                    statusBadgeActive.className = "status-badge badge-success";
                    statusBadgeActive.textContent = customText || "Gemini Connected";
                }
            } else {
                if (statusBadgeSetup) {
                    statusBadgeSetup.className = "status-badge badge-error";
                    statusBadgeSetup.textContent = customText || "Gemini Not Connected";
                }
                if (statusBadgeActive) {
                    statusBadgeActive.className = "status-badge badge-error";
                    statusBadgeActive.textContent = customText || "Gemini Not Connected";
                }
            }
        }

        async testGeminiConnection(key) {
            if (!key) {
                return { success: false, error: "API Key is missing." };
            }
            if (!key.startsWith("AIza")) {
                return { success: false, error: "Invalid Gemini API Key format (must start with AIza)." };
            }

            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key}`;
                const response = await this.fetchWithTimeout(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    { text: "Ping" }
                                ]
                            }
                        ]
                    })
                });

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    const errMsg = errData.error?.message || `HTTP ${response.status}`;
                    return { success: false, error: errMsg };
                }

                const data = await response.json();
                if (data.candidates && data.candidates.length > 0) {
                    return { success: true };
                } else {
                    return { success: false, error: "Empty or unrecognized response structure from Gemini API." };
                }
            } catch (err) {
                console.error("Gemini API connection test failed:", err);
                return { success: false, error: err.message || "Network error. Please check your internet connection." };
            }
        }

        preprocessInvoiceImage(canvas) {
            const ctx = canvas.getContext("2d");
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imgData.data;

            // 1. Boost Contrast & Normalize Brightness
            let min = 255;
            let max = 0;
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i];
                const g = data[i+1];
                const b = data[i+2];
                const v = 0.2126 * r + 0.7152 * g + 0.0722 * b; // grayscale luminance
                if (v < min) min = v;
                if (v > max) max = v;
            }

            // Stretch histogram & enhance contrast
            const range = max - min || 1;
            for (let i = 0; i < data.length; i += 4) {
                for (let c = 0; c < 3; c++) {
                    let v = data[i + c];
                    v = ((v - min) / range) * 255; // stretch
                    v = (v - 128) * 1.4 + 128; // contrast boost
                    data[i + c] = Math.min(255, Math.max(0, v));
                }
            }
            ctx.putImageData(imgData, 0, 0);

            // 2. Convolution Sharpen Filter
            const weights = [
                 0, -1,  0,
                -1,  5, -1,
                 0, -1,  0
            ];
            const side = Math.round(Math.sqrt(weights.length));
            const halfSide = Math.floor(side / 2);
            const sw = canvas.width;
            const sh = canvas.height;
            const src = new Uint8ClampedArray(data); // clone src data
            const output = ctx.createImageData(sw, sh);
            const dst = output.data;

            for (let y = 0; y < sh; y++) {
                for (let x = 0; x < sw; x++) {
                    const sy = y;
                    const sx = x;
                    const dstOff = (y * sw + x) * 4;
                    
                    let r = 0, g = 0, b = 0;
                    for (let cy = 0; cy < side; cy++) {
                        for (let cx = 0; cx < side; cx++) {
                            const scy = Math.min(sh - 1, Math.max(0, sy + cy - halfSide));
                            const scx = Math.min(sw - 1, Math.max(0, sx + cx - halfSide));
                            const srcOff = (scy * sw + scx) * 4;
                            const wt = weights[cy * side + cx];
                            r += src[srcOff] * wt;
                            g += src[srcOff + 1] * wt;
                            b += src[srcOff + 2] * wt;
                        }
                    }
                    dst[dstOff] = Math.min(255, Math.max(0, r));
                    dst[dstOff + 1] = Math.min(255, Math.max(0, g));
                    dst[dstOff + 2] = Math.min(255, Math.max(0, b));
                    dst[dstOff + 3] = src[dstOff + 3]; // alpha channel
                }
            }
            ctx.putImageData(output, 0, 0);
        }

        // Getters for localStorage state

        // Centralized safe write: wraps localStorage.setItem so a quota-exceeded
        // or corrupted-storage error is never silently swallowed. Returns true/false.
        _safeSetItem(key, value, moduleLabel, friendlyLabel, skipCloudPush = false) {
            try {
                localStorage.setItem(key, value);
                // Fire-and-forget push to Supabase cloud database (does not block the UI).
                // Skipped when the caller (e.g. saveWithCloudConfirmation) already
                // pushes and awaits the result itself -- otherwise every save was
                // silently firing TWO concurrent upserts of the same value, doubling
                // real cloud traffic for every write in the app (worse under load
                // with many concurrent users, per Bug #9).
                if (!skipCloudPush) {
                    pushKeyToCloud(key, value);
                }
                return true;
            } catch (err) {
                console.error(`Database update failure while writing "${key}":`, err);
                // Avoid infinite recursion: the notifications/dev-log stores themselves
                // are written via this same helper, so if THEY fail, don't try to
                // triggerNotification() again (that would re-enter this function).
                if (key === "ti_notifications" || key === "ti_developer_logs") {
                    if (typeof this.showToast === "function") {
                        this.showToast(`Critical: failed to save ${friendlyLabel || "data"} (storage error).`, "error");
                    }
                    return false;
                }
                this.triggerNotification(
                    moduleLabel || "Inventory",
                    "Database update failure",
                    `🔴 Database Update Failure\nStore: ${friendlyLabel || key}\nError: ${err.message}\nYour last change may not have been saved. Please retry or free up storage space.`,
                    "Critical",
                    { errorDetails: err.message, stackTrace: err.stack }
                );
                return false;
            }
        }

        getTablets() { return JSON.parse(localStorage.getItem("ti_tablets") || "[]"); }
        setTablets(data) {
            this._indexCache = null; // invalidate in-memory indexes (see getIndexes())
            const result = this._safeSetItem("ti_tablets", JSON.stringify(data), "Inventory", "Master Data / Tablets");
            this._pushInventoryToCloud(data);
            return result;
        }

        // ---- Not Available Products module (Priority 6 reporting) ----
        renderNotAvailablePage() {
            const tbody = document.getElementById("na-results-table-body");
            if (!tbody) return;

            const period = (document.getElementById("na-filter-period") || {}).value || "all";
            const medFilter = ((document.getElementById("na-search-medicine") || {}).value || "").trim().toLowerCase();
            const dispFilter = ((document.getElementById("na-search-dispensary") || {}).value || "").trim().toLowerCase();

            const now = new Date();
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

            let items = this.getNotAvailableItems();

            items = items.filter(it => {
                const d = new Date(it.markedAt);
                if (period === "today" && d < startOfToday) return false;
                if (period === "week" && d < startOfWeek) return false;
                if (period === "month" && d < startOfMonth) return false;
                if (period === "last-month" && (d < startOfLastMonth || d > endOfLastMonth)) return false;
                if (medFilter && !it.medicineName.toLowerCase().includes(medFilter)) return false;
                if (dispFilter && !(it.dispensary || "").toLowerCase().includes(dispFilter)) return false;
                return true;
            });

            items.sort((a, b) => new Date(b.markedAt) - new Date(a.markedAt));

            tbody.innerHTML = items.length === 0
                ? `<tr><td colspan="8" class="text-center text-muted" style="padding:15px;">No Not Available records for this filter.</td></tr>`
                : items.map(it => `
                    <tr>
                        <td>${new Date(it.markedAt).toLocaleString()}</td>
                        <td><strong>${it.medicineName}</strong></td>
                        <td>${it.strength || "-"}</td>
                        <td>${it.requestedQty}</td>
                        <td>${it.dispensary || "-"}</td>
                        <td>${it.orderNumber || "-"}</td>
                        <td>${it.reason || "-"}</td>
                        <td>${it.markedBy}</td>
                    </tr>
                `).join("");

            // ---- KPI summary ----
            const allItems = this.getNotAvailableItems();
            const todayCount = allItems.filter(it => new Date(it.markedAt) >= startOfToday).length;
            const monthCount = allItems.filter(it => new Date(it.markedAt) >= startOfMonth).length;

            const medicineCounts = {};
            const dispensaryCounts = {};
            allItems.forEach(it => {
                medicineCounts[it.medicineName] = (medicineCounts[it.medicineName] || 0) + 1;
                if (it.dispensary) dispensaryCounts[it.dispensary] = (dispensaryCounts[it.dispensary] || 0) + 1;
            });
            const topMedicine = Object.entries(medicineCounts).sort((a, b) => b[1] - a[1])[0];
            const topDispensary = Object.entries(dispensaryCounts).sort((a, b) => b[1] - a[1])[0];

            const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            setText("na-kpi-today", todayCount);
            setText("na-kpi-month", monthCount);
            setText("na-kpi-top-medicine", topMedicine ? `${topMedicine[0]} (${topMedicine[1]})` : "--");
            setText("na-kpi-top-dispensary", topDispensary ? `${topDispensary[0]} (${topDispensary[1]})` : "--");
        }

        exportNotAvailableReport() {
            const items = this.getNotAvailableItems();
            const header = ["Date", "Medicine", "Strength", "Requested Qty", "Dispensary", "Order #", "Patient", "Reason", "Marked By"];
            const rows = items.map(it => [
                new Date(it.markedAt).toLocaleString(), it.medicineName, it.strength || "", it.requestedQty,
                it.dispensary || "", it.orderNumber || "", it.patientName || "", it.reason || "", it.markedBy
            ]);
            const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
            const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `not-available-products-${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        // A dedicated path for medicines staff genuinely cannot supply --
        // deliberately separate from the Due Orders flow: it must NEVER
        // create a Due entry and must NEVER touch inventory/stock, only
        // record the request for reporting.
        getNotAvailableItems() { return JSON.parse(localStorage.getItem("ti_not_available") || "[]"); }
        setNotAvailableItems(data) {
            const result = this._safeSetItem("ti_not_available", JSON.stringify(data), "Not Available", "Not Available Products");
            this._pushNotAvailableToCloud(data);
            return result;
        }
        _pushNotAvailableToCloud(items) {
            if (!supabaseClient) return;
            // Only push rows that don't have a cloudSynced flag yet, so we
            // don't re-insert the same record on every local save.
            const unsynced = items.filter(it => !it._cloudSynced);
            if (unsynced.length === 0) return;
            (async () => {
                for (const it of unsynced) {
                    try {
                        const { error } = await supabaseClient.from("not_available_items").insert({
                            medicine_name: it.medicineName,
                            strength: it.strength || null,
                            requested_qty: it.requestedQty,
                            dispensary: it.dispensary || null,
                            order_number: it.orderNumber || null,
                            patient_name: it.patientName || null,
                            reason: it.reason || null,
                            marked_by: it.markedBy
                        });
                        if (error) { console.warn("not_available_items insert skipped (run supabase-schema.sql):", error.message); return; }
                        it._cloudSynced = true;
                    } catch (e) {
                        console.warn("Cloud Not-Available sync unavailable:", e.message);
                        return;
                    }
                }
                localStorage.setItem("ti_not_available", JSON.stringify(items));
            })();
        }

        // Marks a Partial/No-Stock verification row as Not Available instead
        // of creating a Due entry. Skips inventory deduction entirely for
        // this item and records everything needed for the Not Available
        // reports (medicine, strength, qty, dispensary, order#, patient,
        // date, user, optional reason).
        markItemNotAvailable(idx) {
            const raw = this.verificationRawItems && this.verificationRawItems[idx];
            if (!raw) return;
            const reason = window.prompt(`Mark "${raw.name}" as Not Available.\nOptional reason (e.g. "Out of stock at supplier"):`, "") || "";
            const ctx = this.currentVerifiedOrder || {};
            const items = this.getNotAvailableItems();
            items.push({
                medicineName: raw.name,
                strength: raw.strength || "",
                requestedQty: raw.qty || 0,
                dispensary: ctx.dispensaryName || "",
                orderNumber: ctx.refId || "",
                patientName: raw.patientName || "",
                reason: reason,
                markedBy: this.currentUser ? this.currentUser.name : "Unknown",
                markedAt: new Date().toISOString()
            });
            this.setNotAvailableItems(items);
            raw.notAvailable = true; // excludes it from Due creation for this row
            this.showToast(`"${raw.name}" marked Not Available — no Due entry created, no stock deducted.`, "info");
            this.renderVerificationReport();
        }
        // Best-effort, fire-and-forget upsert of every tablet's stock/batches
        // into the shared `inventory_items` table. This is what makes the
        // change visible to every OTHER staff device -- their Realtime
        // subscription (see initRealtimeSync below) receives this write and
        // updates their local view without a manual refresh. Never blocks or
        // throws into the caller: if Supabase isn't configured yet or the
        // schema hasn't been applied, this silently no-ops so the app keeps
        // working exactly as it did before (localStorage-only).
        _pushInventoryToCloud(tablets) {
            if (!supabaseClient || this._suppressCloudPush) return;
            const rows = tablets.map(t => ({
                code: t.code,
                name: t.name,
                category: t.category,
                brand: t.brand || null,
                stock: t.stock || 0,
                tabs_per_strip: t.tabsPerStrip || 10,
                reorder_level: t.reorder || 0,
                batches: t.batches || [],
                strip_policy: t.stripPolicy || "always_cut",
                updated_by: this.currentUser ? this.currentUser.name : "System"
            }));
            if (rows.length === 0) return;
            // Chunk to stay well under request size limits on large catalogs.
            const chunkSize = 200;
            (async () => {
                for (let i = 0; i < rows.length; i += chunkSize) {
                    const chunk = rows.slice(i, i + chunkSize);
                    try {
                        const { error } = await supabaseClient.from("inventory_items").upsert(chunk, { onConflict: "code" });
                        if (error) {
                            console.warn("Cloud inventory sync skipped (run supabase-schema.sql to create inventory_items):", error.message);
                            return;
                        }
                    } catch (e) {
                        console.warn("Cloud inventory sync unavailable:", e.message);
                        return;
                    }
                }
            })();
        }

        // Atomic, race-free stock deduction via the deduct_stock_atomic()
        // Postgres function (see supabase-schema.sql). Unlike a plain
        // read-modify-write, this is guaranteed safe even if two staff
        // members submit verification for the same medicine at the exact
        // same instant on two different devices -- the database itself
        // rejects the second deduction if stock is already insufficient,
        // rather than both silently succeeding and taking stock negative.
        // Returns { success, newStock } -- success:false means another
        // device already took the stock; the caller must abort and ask the
        // user to re-verify (matches the existing ConcurrencyConflict flow).
        async deductStockAtomic(code, qty) {
            if (!supabaseClient) return { success: null, newStock: null }; // cloud not configured -- caller falls back to local-only check
            try {
                const { data, error } = await supabaseClient.rpc("deduct_stock_atomic", {
                    p_code: code,
                    p_qty: qty,
                    p_user: this.currentUser ? this.currentUser.name : null
                });
                if (error) {
                    console.warn("Atomic stock deduction unavailable (run supabase-schema.sql):", error.message);
                    return { success: null, newStock: null };
                }
                const row = Array.isArray(data) ? data[0] : data;
                return { success: !!(row && row.success), newStock: row ? row.new_stock : null };
            } catch (e) {
                console.warn("Atomic stock deduction failed:", e.message);
                return { success: null, newStock: null };
            }
        }

        // FEFO-safe atomic deduction (Priority 1 / migration_scripts/04_fefo_atomic_deduction.sql).
        // Unlike deductStockAtomic() (which only protects the scalar `stock`
        // column), this also performs the earliest-expiry-first batch split
        // INSIDE the same atomic transaction, under a row lock -- so the
        // batch quantities themselves are race-free across devices, not just
        // the total. Returns the server's authoritative post-deduction
        // batches array; the caller should adopt it as-is rather than
        // re-deriving/upserting its own local split.
        // deductStockAtomic() itself is untouched and still used elsewhere.
        async deductStockFEFOAtomic(code, qty) {
            if (!supabaseClient) return { success: null, newStock: null, updatedBatches: null, breakdown: null }; // cloud not configured -- caller falls back to local-only FEFO split
            try {
                const { data, error } = await supabaseClient.rpc("deduct_stock_fefo_atomic", {
                    p_code: code,
                    p_qty: qty,
                    p_user: this.currentUser ? this.currentUser.name : null
                });
                if (error) {
                    console.warn("Atomic FEFO deduction unavailable (run migration_scripts/04_fefo_atomic_deduction.sql):", error.message);
                    return { success: null, newStock: null, updatedBatches: null, breakdown: null };
                }
                const row = Array.isArray(data) ? data[0] : data;
                return {
                    success: row ? row.success : null,
                    newStock: row ? row.new_stock : null,
                    updatedBatches: row ? row.updated_batches : null,
                    breakdown: row ? row.deducted_breakdown : null
                };
            } catch (e) {
                console.warn("Atomic FEFO deduction failed:", e.message);
                return { success: null, newStock: null, updatedBatches: null, breakdown: null };
            }
        }

        // Subscribes to live inventory_items changes so every connected
        // device reflects stock updates from every OTHER device immediately,
        // without a manual page refresh -- the core Priority 3 requirement.
        // Call once after login. Also refreshes dashboard KPIs / active view
        // whenever a remote change lands.
        initInventoryRealtimeSync() {
            if (!supabaseClient || this._inventoryRealtimeChannel) return;
            try {
                this._inventoryRealtimeChannel = supabaseClient
                    .channel("inventory-sync")
                    .on("postgres_changes", { event: "*", schema: "public", table: "inventory_items" }, (payload) => {
                        this._applyRemoteInventoryChange(payload);
                    })
                    .on("postgres_changes", { event: "INSERT", schema: "public", table: "not_available_items" }, () => {
                        if (document.getElementById("not-available-view")) this.renderNotAvailablePage();
                    })
                    .subscribe();
            } catch (e) {
                console.warn("Realtime sync unavailable:", e.message);
            }
        }

        // Subscribes to live workflows / workflow_events changes so Workflow
        // History (status, timeline, analytics) reflects every OTHER device's
        // actions immediately -- the same guarantee initInventoryRealtimeSync
        // gives stock levels. Call once after login.
        initWorkflowRealtimeSync() {
            if (!supabaseClient || this._workflowRealtimeChannel) return;
            try {
                this._workflowRealtimeChannel = supabaseClient
                    .channel("workflow-sync")
                    .on("postgres_changes", { event: "*", schema: "public", table: "workflows" }, (payload) => {
                        this._applyRemoteWorkflowChange(payload);
                    })
                    .on("postgres_changes", { event: "INSERT", schema: "public", table: "workflow_events" }, (payload) => {
                        this._applyRemoteWorkflowEvent(payload);
                    })
                    .subscribe();
            } catch (e) {
                console.warn("Workflow realtime sync unavailable:", e.message);
            }
        }

        // Merges a remote `workflows` row into the local ti_workflows cache
        // (insert or update) and refreshes the currently visible view if it
        // shows Workflow History/analytics, so status changes made on another
        // device appear instantly here too.
        _applyRemoteWorkflowChange(payload) {
            const row = payload.new;
            if (!row || !row.id) return;
            const workflows = this.getWorkflows();
            const idx = workflows.findIndex(w => w.id === row.id);
            const merged = {
                id: row.id, createdDate: row.created_date, createdTime: row.created_time, createdBy: row.created_by,
                currentStatus: row.current_status, dispensary: row.dispensary, dispensaryId: row.dispensary_id,
                orderSheetRef: row.order_sheet_ref, completionDate: row.completion_date, completionTime: row.completion_time,
                lastUpdated: row.last_updated, lastUpdatedBy: row.last_updated_by
            };
            if (idx >= 0) workflows[idx] = { ...workflows[idx], ...merged };
            else workflows.push(merged);
            localStorage.setItem("ti_workflows", JSON.stringify(workflows));

            if (document.getElementById("workflow-tracker-view") || document.getElementById("dashboard-view")) {
                if (typeof this.renderWorkflowTrackerPage === "function") this.renderWorkflowTrackerPage();
                this.renderDashboard();
            }
        }

        // Appends a remote `workflow_events` insert into the local
        // ti_workflow_log cache so timelines built from getUnifiedTimeline /
        // getWorkflowTimeline stay complete without a manual refresh.
        _applyRemoteWorkflowEvent(payload) {
            const row = payload.new;
            if (!row || !row.workflow_id) return;
            const log = this.getWorkflowLog();
            const already = log.some(l => l.workflowId === row.workflow_id && l.action === row.action && l.date === (row.event_time || "").split("T")[0] && l.time === (row.event_time || "").split("T")[1]?.substring(0, 8));
            if (already) return; // this device's own event, already appended by logWorkflowEvent()
            log.push({
                workflowId: row.workflow_id, action: row.action, user: row.user_name, role: row.role, module: row.module,
                description: row.description, previousStatus: row.previous_status, newStatus: row.new_status, remarks: row.remarks,
                date: row.event_time ? row.event_time.split("T")[0] : null,
                time: row.event_time ? row.event_time.split("T")[1].substring(0, 8) : null
            });
            localStorage.setItem("ti_workflow_log", JSON.stringify(log));
        }

        // Merges a remote inventory_items row into the local tablets cache
        // (without re-triggering another cloud push -- see _suppressCloudPush)
        // and refreshes whatever the user is currently looking at, so stock
        // changes made on another device appear instantly here too.
        _applyRemoteInventoryChange(payload) {
            const row = payload.new;
            if (!row || !row.code) return;
            const tablets = this.getTablets();
            const idx = tablets.findIndex(t => t.code === row.code);
            const merged = {
                code: row.code, name: row.name, category: row.category, brand: row.brand,
                stock: row.stock, tabsPerStrip: row.tabs_per_strip, reorder: row.reorder_level,
                batches: row.batches || [],
                stripPolicy: row.strip_policy || "always_cut"
            };
            if (idx >= 0) {
                tablets[idx] = { ...tablets[idx], ...merged };
            } else {
                tablets.push(merged);
            }
            this._suppressCloudPush = true; // this write came FROM the cloud -- don't echo it back
            this.setTablets(tablets);
            this._suppressCloudPush = false;

            // Refresh whatever's currently visible so nobody sees stale stock.
            const activeView = document.querySelector(".view-panel.active");
            const activeId = activeView ? activeView.id : null;
            if (activeId === "dashboard-view") this.renderDashboard();
            else if (activeId === "master-view") this.renderTabletList();
            else if (activeId === "inventory-view") this.renderInventoryAdjustPage();
            else if (activeId === "due-view") this.renderDueOrdersPage();
            else if (activeId === "reorder-view" && typeof this.renderReorderPage === "function") this.renderReorderPage();
            // Dashboard low-stock/KPI numbers are cheap to refresh regardless
            // of which view is open, so the badge counts never go stale.
            if (typeof this.updateSidebarBadges === "function") this.updateSidebarBadges();
        }

        // --- IN-MEMORY INDEXES (built once, reused until Master Data changes) ---
        // Rebuilding a Map over 30,000 records is still fast, but we avoid
        // doing it on every single lookup during a batch of hundreds of OCR
        // items by caching the indexes and only rebuilding when setTablets()
        // has actually changed the underlying data since the last build.
        getIndexes() {
            if (this._indexCache) return this._indexCache;

            const tablets = this.getTablets();
            const byCode = new Map();              // Product Code -> record
            const byBrand = new Map();             // Brand word -> [records]
            const byBrandStrength = new Map();     // "BRAND|STRENGTH" -> [records]
            const byDrugName = new Map();          // Generic/drug name -> [records]
            const byDrugNameStrength = new Map();  // "DRUGNAME|STRENGTH" -> [records]

            tablets.forEach(t => {
                byCode.set(t.code, t);

                const brand = this.extractProductBrandWord(t.name);
                const strength = this.normalizeStrengthToken(t.name);
                if (brand) {
                    if (!byBrand.has(brand)) byBrand.set(brand, []);
                    byBrand.get(brand).push(t);

                    const bsKey = `${brand}|${strength}`;
                    if (!byBrandStrength.has(bsKey)) byBrandStrength.set(bsKey, []);
                    byBrandStrength.get(bsKey).push(t);
                }

                // Generic/drug name index -- same normalization used for the
                // self-learning correction key (plain uppercase+trim), so a
                // scanned "ATORVASTATIN" reliably hits a Master Data record
                // whose drugName is "Atorvastatin", regardless of which
                // brand that record is filed under.
                const drugNameKey = (t.drugName || "").toUpperCase().trim();
                if (drugNameKey) {
                    if (!byDrugName.has(drugNameKey)) byDrugName.set(drugNameKey, []);
                    byDrugName.get(drugNameKey).push(t);

                    const dsKey = `${drugNameKey}|${strength}`;
                    if (!byDrugNameStrength.has(dsKey)) byDrugNameStrength.set(dsKey, []);
                    byDrugNameStrength.get(dsKey).push(t);
                }
            });

            this._indexCache = { byCode, byBrand, byBrandStrength, byDrugName, byDrugNameStrength, builtFrom: tablets.length };
            return this._indexCache;
        }

        // Workflow / Reorder lookups (rebuilt on demand -- these tables are
        // touched far less often per-session than Master Data, so a simple
        // Map built from the current array is cheap and always fresh).
        getWorkflowIndex() {
            return new Map(this.getWorkflows().map(w => [w.id, w]));
        }
        getReorderIndex() {
            const index = new Map();
            this.getReorders().forEach(r => {
                if (!index.has(r.workflowId)) index.set(r.workflowId, []);
                index.get(r.workflowId).push(r);
            });
            return index;
        }

        getScannedOrders() {
            return JSON.parse(localStorage.getItem("ti_scanned_orders") || "[]");
        }
        setScannedOrders(data) {
            const result = this._safeSetItem("ti_scanned_orders", JSON.stringify(data), "Order Processing", "Scanned Orders");
            (data || []).forEach(o => syncScannedOrderRow(o));
            return result;
        }

        getNotifications() {
            return JSON.parse(localStorage.getItem("ti_notifications") || "[]");
        }
        setNotifications(data) {
            return this._safeSetItem("ti_notifications", JSON.stringify(data), "Inventory", "Notifications");
        }

        getDevLogs() {
            return JSON.parse(localStorage.getItem("ti_developer_logs") || "[]");
        }
        setDevLogs(data) {
            return this._safeSetItem("ti_developer_logs", JSON.stringify(data), "Inventory", "Developer Logs");
        }

        getReorders() {
            return JSON.parse(localStorage.getItem("ti_reorders") || "[]");
        }
        setReorders(data) {
            const result = this._safeSetItem("ti_reorders", JSON.stringify(data), "Reorder", "Reorder List");
            (data || []).forEach(r => syncReorderRow(r));
            return result;
        }

        getHistory() { return JSON.parse(localStorage.getItem("ti_history") || "[]"); }
        setHistory(data) { return this._safeSetItem("ti_history", JSON.stringify(data), "Inventory", "Movement History"); }
        
        getBills() { return JSON.parse(localStorage.getItem("ti_bills") || "[]"); }
        setBills(data) { return this._safeSetItem("ti_bills", JSON.stringify(data), "Bill Processing", "Bills"); }

        // ---- OCR / Upload statistics (Admin & Senior Staff dashboard KPIs) ----
        // Lightweight running counters, independent of the full bills/history
        // records, so the dashboard cards render instantly without re-scanning
        // every bill/order on every render.
        getOcrStats() {
            return Object.assign({
                orderPagesUploaded: 0,
                supplierBillsUploaded: 0,
                medicinesExtracted: 0,
                ocrSuccess: 0,
                ocrFailed: 0,
                pendingFiles: 0,
                ocrTimeSamplesMs: []
            }, JSON.parse(localStorage.getItem("ti_ocr_stats") || "{}"));
        }
        setOcrStats(stats) {
            localStorage.setItem("ti_ocr_stats", JSON.stringify(stats));
        }
        bumpOcrStat(key, by = 1) {
            const stats = this.getOcrStats();
            stats[key] = (stats[key] || 0) + by;
            if (stats.pendingFiles < 0) stats.pendingFiles = 0;
            this.setOcrStats(stats);
        }
        recordOcrTiming(ms) {
            const stats = this.getOcrStats();
            stats.ocrTimeSamplesMs = stats.ocrTimeSamplesMs || [];
            stats.ocrTimeSamplesMs.push(ms);
            if (stats.ocrTimeSamplesMs.length > 200) stats.ocrTimeSamplesMs = stats.ocrTimeSamplesMs.slice(-200);
            this.setOcrStats(stats);
        }

        // ---- Cloud image storage (Supabase Storage + purchase_images table) ----
        // Uploads the raw bill/order-sheet image to the 'bill-images' bucket and
        // records its metadata (filename, upload date, uploaded by, type,
        // OCR status) in the purchase_images table -- see supabase-schema.sql.
        // Deliberately fire-and-forget / best-effort: if Supabase isn't
        // configured, or the schema hasn't been applied yet, this silently
        // no-ops (console.warn only) rather than blocking the OCR workflow,
        // which must keep working exactly as before regardless of cloud state.
        async _uploadBillImageToCloud(base64Data, mimeType, fileName, imageType, extra = {}) {
            if (!supabaseClient || !base64Data) return null;
            try {
                const safeName = (fileName || "upload").replace(/[^a-zA-Z0-9.\-_]/g, "_");
                const path = `${imageType}/${Date.now()}_${safeName}`;
                const byteChars = atob(base64Data);
                const byteNumbers = new Array(byteChars.length);
                for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
                const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType || "image/jpeg" });

                const { error: uploadErr } = await supabaseClient.storage
                    .from("bill-images")
                    .upload(path, blob, { contentType: mimeType || "image/jpeg", upsert: false });
                if (uploadErr) {
                    console.warn("Cloud image upload skipped (bucket/policy not set up yet — see supabase-schema.sql):", uploadErr.message);
                    return null;
                }

                const { data: inserted, error: insertErr } = await supabaseClient
                    .from("purchase_images")
                    .insert({
                        filename: fileName || "upload",
                        storage_path: path,
                        uploaded_by: this.currentUser ? this.currentUser.name : "System",
                        image_type: imageType,
                        supplier: extra.supplier || null,
                        ocr_status: "pending"
                    })
                    .select()
                    .single();
                if (insertErr) {
                    console.warn("purchase_images insert skipped (run supabase-schema.sql to create the table):", insertErr.message);
                    return null;
                }
                return inserted ? inserted.id : null;
            } catch (e) {
                console.warn("Cloud image storage unavailable:", e.message);
                return null;
            }
        }

        // Updates the OCR outcome (success/failed) on a previously-uploaded
        // purchase_images row, keeping cloud metadata in sync with the local
        // OCR stat counters. Also best-effort / non-blocking.
        async _markCloudImageOcrStatus(imageId, status) {
            if (!supabaseClient || !imageId) return;
            try {
                await supabaseClient.from("purchase_images").update({ ocr_status: status }).eq("id", imageId);
            } catch (e) {
                console.warn("Cloud OCR status update skipped:", e.message);
            }
        }
        
        getDueOrders() { return JSON.parse(localStorage.getItem("ti_due_orders") || "[]"); }
        setDueOrders(data) {
            const result = this._safeSetItem("ti_due_orders", JSON.stringify(data), "Due Orders", "Due Orders");
            (data || []).forEach(d => syncDueOrderRow(d));
            return result;
        }

        // --- WORKFLOW ID SYSTEM ---
        // A Workflow ID is a transaction identifier (NOT a medicine code).
        // One is created the moment an Order Sheet is scanned/imported, and
        // the SAME id is carried through Verification, Reorder, Supplier
        // Bill matching, Inventory Movements, and Due Orders. It is never
        // regenerated, edited, or reused once assigned.
        // ti_workflows / ti_workflow_log are now a READ-THROUGH CACHE, not the
        // source of truth. The source of truth is the normalized `workflows` /
        // `workflow_events` tables in Supabase (see supabase-schema.sql). The
        // cache exists so every synchronous call site elsewhere in this file
        // (getWorkflowTimeline, getUnifiedTimeline, getWorkflowAnalytics, etc.)
        // keeps working completely unchanged -- it's kept fresh by
        // hydrateWorkflowsFromCloud() at boot/refresh and by the realtime
        // subscription in initWorkflowRealtimeSync().
        getWorkflows() { return JSON.parse(localStorage.getItem("ti_workflows") || "[]"); }
        setWorkflows(data) { return this._safeSetItem("ti_workflows", JSON.stringify(data), "Workflow", "Workflow Tracking"); }

        getWorkflowLog() { return JSON.parse(localStorage.getItem("ti_workflow_log") || "[]"); }
        setWorkflowLog(data) { return this._safeSetItem("ti_workflow_log", JSON.stringify(data), "Workflow", "Workflow Log"); }

        // Creates the Workflow record. PRODUCTION DESIGN: the database is the
        // single source of truth for the id. This call awaits
        // create_workflow_atomic() -- the id it returns is the only id that
        // is ever written anywhere, local cache included. There is no local
        // id generation and nothing to reconcile: a workflow simply does not
        // exist until the database has issued it.
        //
        // Callers (verifyStockItems) are async and await this.
        async createWorkflow(dispensaryId, dispensaryName, orderSheetRef) {
            if (!supabaseClient) {
                throw new Error("Cannot create a workflow: cloud database is unavailable. Workflow IDs are issued by the database and cannot be generated offline.");
            }
            const createdBy = (this.currentUser && this.currentUser.name) || (this.currentUser && this.currentUser.email) || "System";

            const { data: id, error } = await supabaseClient.rpc("create_workflow_atomic", {
                p_dispensary_id: dispensaryId || null,
                p_dispensary_name: dispensaryName || null,
                p_order_sheet_ref: orderSheetRef || null,
                p_created_by: createdBy || null
            });
            if (error || !id) {
                throw new Error(`Workflow creation failed: ${(error && error.message) || "no id returned"}`);
            }

            const now = new Date();
            const dateStr = now.toISOString().split("T")[0];
            const timeStr = now.toTimeString().split(" ")[0];
            const workflow = {
                id,
                createdDate: dateStr,
                createdTime: timeStr,
                createdBy,
                currentStatus: "New",
                dispensary: dispensaryName || dispensaryId || "",
                dispensaryId: dispensaryId || "",
                orderSheetRef: orderSheetRef || "",
                completionDate: null,
                completionTime: null,
                lastUpdated: `${dateStr} ${timeStr}`,
                lastUpdatedBy: createdBy
            };

            // Local cache write AFTER the database confirms the id -- this is
            // purely a read-through cache for the synchronous getters used
            // elsewhere in this file (getWorkflowTimeline, getUnifiedTimeline,
            // getWorkflowAnalytics), never the source of truth.
            const workflows = this.getWorkflows();
            workflows.push(workflow);
            this.setWorkflows(workflows);

            // The first workflow_events row was already inserted server-side
            // by create_workflow_atomic() in the same transaction as the
            // workflow row, so mirror it into the local log cache without a
            // second insert.
            const log = this.getWorkflowLog();
            log.push({
                workflowId: id, action: "Order Sheet Uploaded", user: createdBy,
                role: (this.currentUser && this.currentUser.role) || "N/A",
                module: "Order Processing",
                description: `Order sheet ${orderSheetRef || ""} received for ${dispensaryName || dispensaryId || "dispensary"}.`,
                previousStatus: null, newStatus: "New", remarks: null,
                date: dateStr, time: timeStr
            });
            this.setWorkflowLog(log);

            return id;
        }

        // Updates a Workflow's status (auto-progression) and stamps who/when.
        updateWorkflowStatus(workflowId, newStatus) {
            if (!workflowId) return;
            const workflows = this.getWorkflows();
            const wf = workflows.find(w => w.id === workflowId);
            if (!wf) return;

            wf.currentStatus = newStatus;
            const now = new Date();
            wf.lastUpdated = now.toISOString().replace('T', ' ').substring(0, 19);
            wf.lastUpdatedBy = (this.currentUser && this.currentUser.name) || (this.currentUser && this.currentUser.email) || "System";

            if (newStatus === "Completed" || newStatus === "Cancelled") {
                wf.completionDate = now.toISOString().split("T")[0];
                wf.completionTime = now.toTimeString().split(" ")[0];
            }

            this.setWorkflows(workflows);
            this.pushWorkflowStatusToCloud(workflowId, wf);
        }

        async pushWorkflowStatusToCloud(workflowId, wf) {
            if (!supabaseClient) return;
            try {
                const patch = {
                    current_status: wf.currentStatus,
                    last_updated: new Date().toISOString(),
                    last_updated_by: wf.lastUpdatedBy
                };
                if (wf.completionDate) { patch.completion_date = wf.completionDate; patch.completion_time = wf.completionTime; }
                const { error } = await supabaseClient.from("workflows").update(patch).eq("id", workflowId);
                if (error) throw error;
            } catch (err) {
                console.error("Cloud workflow status update failed for", workflowId, err);
            }
        }

        // Appends one entry to the permanent Workflow Log (audit trail).
        // `extra` optionally carries previousStatus/newStatus/remarks for the
        // normalized workflow_events row -- omitted at existing call sites,
        // so this stays fully backward compatible.
        logWorkflowEvent(workflowId, action, module, description, extra = {}) {
            if (!workflowId) return;
            const log = this.getWorkflowLog();
            const now = new Date();
            const entry = {
                workflowId,
                action,
                user: (this.currentUser && this.currentUser.name) || (this.currentUser && this.currentUser.email) || "System",
                role: (this.currentUser && this.currentUser.role) || "N/A",
                module,
                description,
                previousStatus: extra.previousStatus || null,
                newStatus: extra.newStatus || null,
                remarks: extra.remarks || null,
                date: now.toISOString().split("T")[0],
                time: now.toTimeString().split(" ")[0]
            };
            log.push(entry);
            this.setWorkflowLog(log);
            this.pushWorkflowEventToCloud(entry);
        }

        async pushWorkflowEventToCloud(entry) {
            if (!supabaseClient) return;
            try {
                const { browser, device } = (typeof getBrowserAndDevice === "function") ? getBrowserAndDevice() : {};
                const { error } = await supabaseClient.from("workflow_events").insert({
                    workflow_id: entry.workflowId,
                    user_name: entry.user,
                    role: entry.role,
                    action: entry.action,
                    module: entry.module,
                    previous_status: entry.previousStatus,
                    new_status: entry.newStatus,
                    description: entry.description,
                    remarks: entry.remarks,
                    device, browser,
                    event_time: new Date().toISOString()
                });
                if (error) throw error;
            } catch (err) {
                console.error("Cloud workflow event push failed:", err);
            }
        }

        // Returns the full, one-screen timeline for a given Workflow ID:
        // the workflow record itself plus every related record across every
        // module, so an administrator can trace an order end-to-end.
        getWorkflowTimeline(workflowId) {
            const workflow = this.getWorkflows().find(w => w.id === workflowId) || null;
            return {
                workflow,
                log: this.getWorkflowLog().filter(l => l.workflowId === workflowId),
                scannedOrders: this.getScannedOrders().filter(o => o.workflowId === workflowId),
                reorders: this.getReorders().filter(r => r.workflowId === workflowId),
                dueOrders: this.getDueOrders().filter(d => d.workflowId === workflowId),
                history: this.getHistory().filter(h => h.workflowId === workflowId),
                bills: this.getBills().filter(b => (b.workflowId === workflowId) || (Array.isArray(b.matchedWorkflowIds) && b.matchedWorkflowIds.includes(workflowId)))
            };
        }

        // --- UNIFIED TIMELINE (Report View) ---
        // Per your own recommendation: don't merge the three underlying
        // tables (Audit Log / History Log / Workflow Log) into one database
        // -- that's real schema risk this close to a demo. Instead, this is
        // a pure read-only VIEW that merges them in memory, normalizes each
        // into a common shape, and sorts chronologically. Nothing is written
        // back to any of the three source tables.
        //
        // If workflowId is provided, results are filtered to that workflow
        // (History and Workflow Log entries via their workflowId field;
        // Audit entries via workflowId where present -- not every audit
        // entry carries one yet, since not every action maps to a single
        // workflow, e.g. Day End touches many at once).
        getUnifiedTimeline(workflowId = null) {
            const entries = [];

            this.getAuditLog().forEach(a => {
                if (workflowId && a.workflowId !== workflowId) return;
                entries.push({
                    source: "Audit",
                    datetime: `${a.date} ${a.time}`,
                    workflowId: a.workflowId || null,
                    user: a.user,
                    role: a.role,
                    module: a.module,
                    action: a.action,
                    description: a.record ? `${a.action} — ${a.record}` : a.action
                });
            });

            this.getHistory().forEach(h => {
                if (workflowId && h.workflowId !== workflowId) return;
                entries.push({
                    source: "History",
                    datetime: h.datetime,
                    workflowId: h.workflowId || null,
                    user: null,
                    role: null,
                    module: "Inventory Movement",
                    action: h.type,
                    description: h.details || `${h.type} — ${h.tabletName} (${h.qty})`
                });
            });

            this.getWorkflowLog().forEach(w => {
                if (workflowId && w.workflowId !== workflowId) return;
                entries.push({
                    source: "Workflow",
                    datetime: `${w.date} ${w.time}`,
                    workflowId: w.workflowId,
                    user: w.user,
                    role: w.role,
                    module: w.module,
                    action: w.action,
                    description: w.description
                });
            });

            entries.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
            return entries;
        }

        // Global search entry point usable from any module: "search by
        // Workflow ID from any module" — logs the lookup and returns the
        // aggregated timeline described above.
        searchWorkflow(workflowId) {
            const id = (workflowId || "").trim().toUpperCase();
            if (!id) return null;
            return this.getWorkflowTimeline(id);
        }

        // Data layer for a future Administrator Dashboard "Workflow" card.
        // Returns the counts described in the Workflow ID spec; wiring this
        // into dashboard-view HTML is a follow-up UI pass.
        getWorkflowAnalytics() {
            const workflows = this.getWorkflows();
            const todayStr = new Date().toISOString().split("T")[0];
            const totalToday = workflows.filter(w => w.createdDate === todayStr).length;
            const completed = workflows.filter(w => w.currentStatus === "Completed").length;
            const pendingVerification = workflows.filter(w => w.currentStatus === "New" || w.currentStatus === "Scanning" || w.currentStatus === "Verification Pending").length;
            const pendingReorder = workflows.filter(w => w.currentStatus === "Reorder Pending").length;
            const dueOrderCount = workflows.filter(w => w.currentStatus === "Due Order").length;

            const parseTs = (d, t) => d ? new Date(`${d}T${t || "00:00:00"}`).getTime() : null;
            const completedWithTimes = workflows.filter(w => w.currentStatus === "Completed" && w.completionDate);
            const avgProcessingMs = completedWithTimes.length
                ? completedWithTimes.reduce((sum, w) => {
                    const start = parseTs(w.createdDate, w.createdTime);
                    const end = parseTs(w.completionDate, w.completionTime);
                    return sum + (start && end ? (end - start) : 0);
                }, 0) / completedWithTimes.length
                : 0;

            return {
                totalWorkflowsToday: totalToday,
                completedWorkflows: completed,
                pendingVerification,
                pendingReorders: pendingReorder,
                dueOrders: dueOrderCount,
                averageProcessingTimeMs: avgProcessingMs
            };
        }

        // --- TRANSACTION LOCKS & ROLLBACK SIMULATION ---
        beginTransaction() {
            const lock = localStorage.getItem("ti_db_lock");
            if (lock === "true") {
                throw new Error("LockAcquisitionException: Concurrent inventory reservation or adjustment in progress. Please try again.");
            }
            localStorage.setItem("ti_db_lock", "true");
            // Backup database tables for rollback
            this._dbBackup = {
                tablets: localStorage.getItem("ti_tablets") || "[]",
                history: localStorage.getItem("ti_history") || "[]",
                dues: localStorage.getItem("ti_due_orders") || "[]",
                bills: localStorage.getItem("ti_bills") || "[]"
            };
        }

        commitTransaction() {
            localStorage.removeItem("ti_db_lock");
            this._dbBackup = null;
        }

        rollbackTransaction() {
            if (this._dbBackup) {
                localStorage.setItem("ti_tablets", this._dbBackup.tablets);
                localStorage.setItem("ti_history", this._dbBackup.history);
                localStorage.setItem("ti_due_orders", this._dbBackup.dues);
                localStorage.setItem("ti_bills", this._dbBackup.bills);
            }
            localStorage.removeItem("ti_db_lock");
            this._dbBackup = null;
        }

        // --- STOCK DISPLAY HELPER ---
        fmtStock(totalTablets, tabsPerStrip, category) {
            if (category === "Tablets & Capsules" || category === "Rotacaps") {
                const tps = tabsPerStrip || 10;
                const strips = Math.floor(totalTablets / tps);
                const loose  = totalTablets % tps;
                const tabPart = loose > 0 ? ` + ${loose} tab${loose !== 1 ? 's' : ''}` : '';
                return `<span style="font-size:0.95em;">${strips} Strip${strips !== 1 ? 's' : ''}${tabPart}</span>` +
                       `<div style="font-size:0.72em;color:var(--text-muted);margin-top:1px;">${totalTablets} tablets</div>`;
            }
            return `<span style="font-size:0.95em;">${Math.round(totalTablets)} units</span>`;
        }

        fmtQty(packs, tabsPerStrip, tabletName, pack) {
            const tps = tabsPerStrip || 10;
            const totalTablets = packs * tps;
            const loose = totalTablets % tps;
            const tabPart = loose > 0 ? ` + ${loose} tab${loose !== 1 ? 's' : ''}` : '';
            const fmt = this.formatPackConversion(totalTablets, pack, tabletName);
            return `<span>${packs} Strip${packs !== 1 ? 's' : ''}${tabPart}</span>` +
                   `<div style="font-size:0.72em;color:var(--text-muted);margin-top:1px;">${totalTablets} tablets</div>`;
        }

        // --- PACK CONVERSION & SIZE RECOGNITION ---
        parsePackSize(packStr, productName = "") {
            const cleanPack = (packStr || "").trim().toUpperCase();
            const cleanName = (productName || "").trim().toUpperCase();
            
            let tabsPerStrip = 10;
            let stripsPerBox = null; // Do not assume 10 strips per box by default!
            let confident = false; // true only when a real regex match was found below --
                                    // NOT when tabsPerStrip is still sitting at the
                                    // hardcoded 10 fallback. Callers that are about to
                                    // write this value permanently (new Master Data
                                    // records, inventory quantity math with no existing
                                    // Master Data to fall back on) must check this flag
                                    // and route to Manual Review instead of trusting a
                                    // silent guess.
            
            // Regex to match "10's", "15's", "30's", "45's", "50's", "100's" etc.
            const packMatch = (cleanPack + " " + cleanName).match(/\b(10|15|20|30|45|50|100)\s*('?S|TABLETS|TABS|CAPS|CAPSU)\b/);
            if (packMatch) {
                tabsPerStrip = parseInt(packMatch[1]);
                confident = true;
            } else {
                const numMatch = cleanPack.match(/\b(10|15|20|30|45|50|100)\b/);
                if (numMatch) {
                    tabsPerStrip = parseInt(numMatch[1]);
                    confident = true;
                }
            }

            // Strips per box: check multipliers (e.g. 10x10, 10 x 15, 10 strips of 10).
            // The negative lookahead excludes injection/vial dosage notations
            // like "5 x 10 ml" or "2 x 40 mg" -- those describe vial count x
            // volume/strength per vial, NOT strips-per-box x tablets-per-strip,
            // and must never be fed into the tablet strip-multiplication logic.
            const multMatch = cleanPack.match(/\b(\d+)\s*[xX*×]\s*(\d+)\b(?!\s*(ML|MG|MCG|GM|G|L)\b)/);
            if (multMatch) {
                stripsPerBox = parseInt(multMatch[1]);
                tabsPerStrip = parseInt(multMatch[2]);
                confident = true;
            } else if (cleanPack.includes("STRIP")) {
                const stripMatch = cleanPack.match(/\b(\d+)\s*STRIP/);
                if (stripMatch) {
                    stripsPerBox = parseInt(stripMatch[1]);
                }
            }
            
            return {
                tabsPerStrip: tabsPerStrip,
                stripsPerBox: stripsPerBox,
                totalTablets: stripsPerBox ? (tabsPerStrip * stripsPerBox) : tabsPerStrip,
                confident: confident
            };
        }

        convertTabletsToReadablePack(totalQty, packSize) {
            const tabsPerStrip = packSize.tabsPerStrip;
            const stripsPerBox = packSize.stripsPerBox;
            
            let remaining = totalQty;
            let boxes = 0;
            if (stripsPerBox) {
                const totalPerBox = tabsPerStrip * stripsPerBox;
                boxes = Math.floor(remaining / totalPerBox);
                remaining %= totalPerBox;
            }
            
            const strips = Math.floor(remaining / tabsPerStrip);
            remaining %= tabsPerStrip;
            
            const individualTabs = remaining;
            
            return {
                boxes,
                strips,
                tablets: individualTabs
            };
        }

        formatPackConversion(totalQty, packStr, productName = "") {
            const tablets = this.getTablets();
            const match = this.resolveMedicine(productName, null, tablets).tablet;
            const packSize = this.parsePackSize(packStr, productName);
            const tabsPerStrip = match ? (match.tabsPerStrip || packSize.tabsPerStrip) : packSize.tabsPerStrip;
            const stripsPerBox = match ? (match.stripsPerBox || packSize.stripsPerBox) : packSize.stripsPerBox;
            
            const cat = this.detectCategoryFromName(productName, packStr);
            if (cat !== "Tablets & Capsules" && cat !== "Rotacaps") {
                return `${totalQty} pack${totalQty !== 1 ? 's' : ''}`;
            }

            let remaining = totalQty;
            let boxes = 0;
            if (stripsPerBox) {
                const totalPerBox = tabsPerStrip * stripsPerBox;
                boxes = Math.floor(remaining / totalPerBox);
                remaining %= totalPerBox;
            }
            
            const strips = Math.floor(remaining / tabsPerStrip);
            remaining %= tabsPerStrip;
            
            const individualTabs = remaining;

            const parts = [];
            if (boxes > 0) parts.push(`${boxes} Box${boxes !== 1 ? 'es' : ''}`);
            if (strips > 0) parts.push(`${strips} Strip${strips !== 1 ? 's' : ''}`);
            if (individualTabs > 0) parts.push(`${individualTabs} Unit${individualTabs !== 1 ? 's' : ''}`);
            
            if (parts.length === 0) return "0 Units";
            return `${parts.join(", ")}, ${totalQty} Units`;
        }

        calculateTotalUnits(medicineName, qty, packStr, detectedUnit, tabletMaster = null) {
            const cleanPack = (packStr || "").trim().toUpperCase();
            const category = this.detectCategoryFromName(medicineName, packStr);
            
            const packSize = this.parsePackSize(packStr, medicineName);
            const tabsPerStrip = tabletMaster ? (tabletMaster.tabsPerStrip || packSize.tabsPerStrip) : packSize.tabsPerStrip;
            // Master Data (tabletMaster) is authoritative and always wins when
            // present -- this only matters for genuinely NEW/unmatched
            // medicines, where there's no Master Data yet and the pack size
            // came purely from a regex guess against OCR text. In that case,
            // flag it instead of silently trusting a possibly-wrong default
            // (see parsePackSize's `confident` flag).
            const needsPackReview = !tabletMaster && !packSize.confident;
            
            let unit = detectedUnit;
            if (!unit) {
                unit = tabletMaster ? (tabletMaster.purchaseUnit || "Strip") : "Strip";
            }
            
            unit = unit.trim().toLowerCase();
            if (unit.includes("strip")) unit = "strip";
            else if (unit.includes("bottle")) unit = "bottle";
            else if (unit.includes("vial")) unit = "vial";
            else if (unit.includes("ampoule") || unit.includes("amp")) unit = "ampoule";
            else if (unit.includes("tube")) unit = "tube";
            else if (unit.includes("sachet")) unit = "sachet";
            else if (unit.includes("piece") || unit.includes("pc")) unit = "piece";
            else if (unit.includes("respule")) unit = "respule";
            else if (unit.includes("cap")) unit = "cap";
            
            let totalUnits = qty;
            
            if (category === "Tablets & Capsules" || category === "Rotacaps") {
                if (unit === "strip") {
                    totalUnits = qty * tabsPerStrip;
                } else {
                    totalUnits = qty; // Bottle, Tube, Ampoule, Vial, Sachet, Piece
                }
            } else {
                totalUnits = qty;
            }
            
            return {
                purchaseUnit: unit.charAt(0).toUpperCase() + unit.slice(1),
                totalUnits: totalUnits,
                tabsPerStrip: tabsPerStrip,
                needsReview: needsPackReview
            };
        }

        parseQtyAndUnit(qtyValStr, medicineName, tabletMaster = null) {
            const cleanStr = (qtyValStr || "").toString().trim().toUpperCase();
            
            let qty = parseFloat(cleanStr.replace(/[^0-9.]/g, '')) || 0;
            let unit = null;
            
            if (cleanStr.includes("STRIP")) unit = "Strip";
            else if (cleanStr.includes("BOTTLE")) unit = "Bottle";
            else if (cleanStr.includes("VIAL")) unit = "Vial";
            else if (cleanStr.includes("AMPOULE") || cleanStr.includes("AMP")) unit = "Ampoule";
            else if (cleanStr.includes("TUBE")) unit = "Tube";
            else if (cleanStr.includes("SACHET")) unit = "Sachet";
            else if (cleanStr.includes("PIECE") || cleanStr.includes("PC")) unit = "Piece";
            else if (cleanStr.includes("RESPULE")) unit = "Respule";
            
            if (!unit) {
                if (tabletMaster && tabletMaster.purchaseUnit) {
                    unit = tabletMaster.purchaseUnit;
                } else {
                    const cat = this.detectCategoryFromName(medicineName, tabletMaster ? tabletMaster.pack : null);
                    if (cat === "Tablets & Capsules" || cat === "Rotacaps") {
                        unit = "Strip";
                    } else if (cat === "Injections") {
                        unit = "Vial";
                    } else if (cat === "Creams / Gels / Ointments") {
                        unit = "Tube";
                    } else if (cat === "Powders") {
                        unit = "Sachet";
                    } else if (cat === "Respules") {
                        unit = "Respule";
                    } else {
                        unit = "Bottle";
                    }
                }
            }
            
            return { qty, unit };
        }

        // Core Event bindings
        bindEvents() {
            const roleSelect = document.getElementById("user-role-select");
            if (roleSelect) {
                roleSelect.value = this.currentUser.role;
            }

            // Master Data modal: Number of Strips -> Number of Tablets is always
            // derived (Packing Size x Strips), never hardcoded/manually typed.
            // These three inputs all affect that calculation, so any of them
            // changing should refresh the live preview.
            ["tab-category", "tab-pack", "tab-stock"].forEach(id => {
                const el = document.getElementById(id);
                if (el && !el.dataset.stockCalcBound) {
                    el.dataset.stockCalcBound = "1";
                    el.addEventListener("input", () => this.updateStockFieldLabel());
                    el.addEventListener("change", () => this.updateStockFieldLabel());
                }
            });

            // Sidebar tab switches
            document.querySelectorAll(".menu-item").forEach(item => {
                item.addEventListener("click", (e) => {
                    e.preventDefault();
                    const target = item.getAttribute("data-target");
                    if (target) this.switchTab(target);
                });
            });

            // Notification bell click
            const bellEl = document.querySelector(".notification-bell");
            if (bellEl && !bellEl.dataset.bound) {
                bellEl.dataset.bound = "1";
                bellEl.addEventListener("click", () => this.toggleNotificationDrawer());
            }
            this.updateNotificationBellDot();

            // Update header date to current system date dynamically
            const headerDate = document.getElementById("header-date");
            if (headerDate) {
                const now = new Date();
                headerDate.textContent = now.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
                // Update every second so it stays current
                setInterval(() => {
                    const d = new Date();
                    headerDate.textContent = d.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
                }, 60000);
            }

            // Mobile menu toggle
            const menuToggle = document.getElementById("menu-toggle");
            const sidebar = document.querySelector(".sidebar");
            const sidebarBackdrop = document.getElementById("sidebar-drawer-backdrop");
            const bottomNav = document.querySelector(".mobile-bottom-nav");
            const setMobileDrawerOpen = (open) => {
                sidebar.classList.toggle("active", open);
                if (sidebarBackdrop) sidebarBackdrop.classList.toggle("active", open);
                if (bottomNav) bottomNav.classList.toggle("drawer-open", open);
            };
            if (menuToggle && sidebar) {
                menuToggle.addEventListener("click", () => {
                    setMobileDrawerOpen(!sidebar.classList.contains("active"));
                });
            }
            if (sidebarBackdrop) {
                sidebarBackdrop.addEventListener("click", () => setMobileDrawerOpen(false));
            }
            // Close the drawer whenever a menu item is tapped (mobile only)
            document.querySelectorAll(".sidebar .menu-item").forEach((item) => {
                item.addEventListener("click", () => {
                    if (window.innerWidth <= 767) setMobileDrawerOpen(false);
                });
            });

            // Search tablets in master data.
            const tabSearch = document.getElementById("tablet-search");
            // Debounced (220ms, same pattern as debouncedRender() used
            // elsewhere) because renderTabletList() re-scans the full
            // tablet list -- including a Levenshtein fuzzy-match fallback
            // -- and rebuilds the whole table body on every call. Without
            // this, every keystroke did that full pass; on a large
            // wholesale product list that's the "typing feels slow" bug.
            // debouncedRender() itself isn't reused here because it calls
            // the target function with no arguments, and renderTabletList
            // needs the live search text -- so the value is read fresh
            // inside the timeout instead.
            if (tabSearch) {
                let _masterSearchTimer = null;
                tabSearch.addEventListener("input", (e) => {
                    clearTimeout(_masterSearchTimer);
                    const val = e.target.value;
                    _masterSearchTimer = setTimeout(() => {
                        this.renderTabletList(val);
                    }, 220);
                });
            }

            // Category filter click handler
            const categoryFilters = document.getElementById("master-category-filters");
            if (categoryFilters) {
                categoryFilters.addEventListener("click", (e) => {
                    const pill = e.target.closest(".category-pill");
                    if (pill) {
                        categoryFilters.querySelectorAll(".category-pill").forEach(p => p.classList.remove("active"));
                        pill.classList.add("active");
                        this._activeCategoryFilter = pill.getAttribute("data-category");
                        const tabSearch = document.getElementById("tablet-search");
                        this.renderTabletList(tabSearch ? tabSearch.value : "");
                    }
                });
            }

            // Search history logs
            const histSearch = document.getElementById("history-filter-search");
            if (histSearch) {
                histSearch.addEventListener("input", (e) => {
                    this.renderHistoryList(e.target.value);
                });
            }

            // Tablet Add/Edit submit
            const tabletForm = document.getElementById("tablet-form");
            if (tabletForm) {
                tabletForm.addEventListener("submit", (e) => {
                    e.preventDefault();
                    this.saveTabletForm();
                });
            }

            // Bill Uploader File Select
            const billFileInput = document.getElementById("bill-file-input");
            const btnBrowseBills = document.getElementById("btn-browse-bills");
            const billDropzone = document.getElementById("bill-dropzone");

            if (btnBrowseBills && billFileInput) {
                btnBrowseBills.addEventListener("click", () => billFileInput.click());
            }

            if (billFileInput) {
                billFileInput.addEventListener("change", (e) => {
                    if (e.target.files && e.target.files.length > 0) {
                        const files = Array.from(e.target.files);
                        if (files.length === 1) {
                            this.triggerOCRScan(files[0].name, files[0]);
                        } else {
                            this.handleMultiPageBillUpload(files);
                        }
                    }
                });
            }

            if (billDropzone) {
                billDropzone.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    billDropzone.classList.add("dragover");
                });
                billDropzone.addEventListener("dragleave", () => {
                    billDropzone.classList.remove("dragover");
                });
                billDropzone.addEventListener("drop", (e) => {
                    e.preventDefault();
                    billDropzone.classList.remove("dragover");
                    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        const files = Array.from(e.dataTransfer.files);
                        if (files.length === 1) {
                            this.triggerOCRScan(files[0].name, files[0]);
                        } else {
                            this.handleMultiPageBillUpload(files);
                        }
                    }
                });
            }

            // Priority 2 -- Batch OCR queue wiring. Separate file input from
            // bill-file-input above (which merges multi-file selections as
            // PAGES of one bill) -- this one runs each selected file through
            // the existing OCRQueue-backed scanImagesBatch as an INDEPENDENT
            // bill, in parallel, then lets the user step through review/
            // import for each one using the same unmodified UI.
            const billBatchFileInput = document.getElementById("bill-batch-file-input");
            const btnBrowseBatchBills = document.getElementById("btn-browse-batch-bills");
            if (btnBrowseBatchBills && billBatchFileInput) {
                btnBrowseBatchBills.addEventListener("click", () => billBatchFileInput.click());
            }
            if (billBatchFileInput) {
                billBatchFileInput.addEventListener("change", (e) => {
                    if (e.target.files && e.target.files.length > 0) {
                        this.startBatchBillScan(Array.from(e.target.files));
                        billBatchFileInput.value = ""; // allow re-selecting the same files later
                    }
                });
            }
            const btnBatchNext = document.getElementById("btn-batch-next");
            if (btnBatchNext) {
                btnBatchNext.addEventListener("click", () => this.loadNextBatchBillResult());
            }

            // Load Kastoori Medicals sample bill
            const btnLoadKastoori = document.getElementById("btn-load-kastoori");
            if (btnLoadKastoori) {
                btnLoadKastoori.addEventListener("click", () => {
                    this.triggerOCRScan("KastooriMedicals_Invoice_26KK404.jpg");
                });
            }

            // Import Bill & Discard actions
            const btnImportBill = document.getElementById("btn-import-bill");
            const btnDiscardBill = document.getElementById("btn-discard-bill");
            if (btnImportBill) btnImportBill.addEventListener("click", () => this.withButtonLoading(btnImportBill, "Importing...", () => this.importExtractedBill()));
            if (btnDiscardBill) btnDiscardBill.addEventListener("click", () => this.resetBillOCR());

            // Order Manual Item builder
            const btnAddOrderRow = document.getElementById("btn-add-order-item-row");
            if (btnAddOrderRow) {
                btnAddOrderRow.addEventListener("click", () => this.addOrderBuilderRow());
            }

            const orderManualForm = document.getElementById("order-manual-form");
            if (orderManualForm) {
                orderManualForm.addEventListener("submit", (e) => {
                    e.preventDefault();
                    this.runOrderVerificationManual();
                });
            }

            // Load Sample Order list
            const btnLoadSampleOrder = document.getElementById("btn-load-sample-order");
            if (btnLoadSampleOrder) {
                btnLoadSampleOrder.addEventListener("click", () => this.loadSampleOrderPaper());
            }

            // Confirm & Process Order Verification
            const btnSubmitOrder = document.getElementById("btn-submit-order");
            if (btnSubmitOrder) {
                btnSubmitOrder.addEventListener("click", () => this.withButtonLoading(btnSubmitOrder, "Processing...", () => this.submitVerifiedOrder()));
            }

            // CSV Order Uploader
            const orderCsvInput = document.getElementById("order-csv-input");
            const btnBrowseOrderCsv = document.getElementById("btn-browse-order-csv");
            const orderCsvDropzone = document.getElementById("order-csv-dropzone");

            if (btnBrowseOrderCsv && orderCsvInput) {
                btnBrowseOrderCsv.addEventListener("click", () => orderCsvInput.click());
            }
            if (orderCsvInput) {
                orderCsvInput.addEventListener("change", (e) => {
                    if (e.target.files && e.target.files[0]) {
                        this.processOrderCSV(e.target.files[0]);
                    }
                });
            }
            if (orderCsvDropzone) {
                orderCsvDropzone.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    orderCsvDropzone.classList.add("dragover");
                });
                orderCsvDropzone.addEventListener("dragleave", () => {
                    orderCsvDropzone.classList.remove("dragover");
                });
                orderCsvDropzone.addEventListener("drop", (e) => {
                    e.preventDefault();
                    orderCsvDropzone.classList.remove("dragover");
                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        this.processOrderCSV(e.dataTransfer.files[0]);
                    }
                });
            }

            // Order Image Uploader
            const orderImgInput = document.getElementById("order-image-input");
            const btnBrowseOrderImg = document.getElementById("btn-browse-order-image");
            const orderImgDropzone = document.getElementById("order-image-dropzone");

            if (btnBrowseOrderImg && orderImgInput) {
                btnBrowseOrderImg.addEventListener("click", () => orderImgInput.click());
            }
            if (orderImgInput) {
                orderImgInput.addEventListener("change", (e) => {
                    if (e.target.files && e.target.files[0]) {
                        this.triggerOrderOCRScan(e.target.files[0]);
                    }
                });
            }
            if (orderImgDropzone) {
                orderImgDropzone.addEventListener("dragover", (e) => {
                    e.preventDefault();
                    orderImgDropzone.classList.add("dragover");
                });
                orderImgDropzone.addEventListener("dragleave", () => {
                    orderImgDropzone.classList.remove("dragover");
                });
                orderImgDropzone.addEventListener("drop", (e) => {
                    e.preventDefault();
                    orderImgDropzone.classList.remove("dragover");
                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                        this.triggerOrderOCRScan(e.dataTransfer.files[0]);
                    }
                });
            }

            // Load sample order image button
            const btnLoadSampleOrderImg = document.getElementById("btn-load-sample-order-img");
            if (btnLoadSampleOrderImg) {
                btnLoadSampleOrderImg.addEventListener("click", () => {
                    this.triggerOrderOCRScan(null, true);
                });
            }

            // Process pasted order text button
            const btnProcessTextOrder = document.getElementById("btn-process-text-order");
            if (btnProcessTextOrder) {
                btnProcessTextOrder.addEventListener("click", () => {
                    this.processManualTextOrder();
                });
            }

            // Stock adjustment form
            const stockAdjustForm = document.getElementById("stock-adjust-form");
            if (stockAdjustForm) {
                stockAdjustForm.addEventListener("submit", (e) => {
                    e.preventDefault();
                    this.applyStockAdjustment();
                });
            }

            // Export buttons
            const btnExportInv = document.getElementById("btn-export-inventory");
            const btnExportDues = document.getElementById("btn-export-dues");
            if (btnExportInv) btnExportInv.addEventListener("click", () => this.exportInventoryToCSV());
            if (btnExportDues) btnExportDues.addEventListener("click", () => this.exportDueOrdersToCSV());

            // Export Expiries & Expiry filter listeners
            const btnExportExpiries = document.getElementById("btn-export-expiries");
            if (btnExportExpiries) btnExportExpiries.addEventListener("click", () => this.exportExpiriesToCSV());
            
            const expiryFilters = document.querySelectorAll('input[name="expiry-filter"]');
            expiryFilters.forEach(radio => {
                radio.addEventListener("change", () => this.renderExpiryPage());
            });

            // Clipboard Copy binding for Google Lens
            const btnCopyClipboard = document.getElementById("btn-copy-image-clipboard");
            if (btnCopyClipboard) {
                btnCopyClipboard.addEventListener("click", () => this.copyCanvasImageToClipboard());
            }

            // Manual Text Bill process listener
            const btnProcessTextBill = document.getElementById("btn-process-text-bill");
            if (btnProcessTextBill) {
                btnProcessTextBill.addEventListener("click", () => {
                    const textVal = document.getElementById("bill-text-input").value.trim();
                    if (!textVal) {
                        this.showToast("Please paste some invoice text lines.", "error");
                        return;
                    }
                    this.processManualTextBill(textVal);
                });
            }

            // Manual Bill Form bindings
            const btnAddBillManualRow = document.getElementById("btn-add-bill-manual-row");
            if (btnAddBillManualRow) {
                btnAddBillManualRow.addEventListener("click", () => this.addBillManualRow());
            }

            const btnProcessManualFormBill = document.getElementById("btn-process-manual-form-bill");
            if (btnProcessManualFormBill) {
                btnProcessManualFormBill.addEventListener("click", () => this.compileManualBillForm());
            }

            // Gemini API Setup bindings
            const btnGeminiSetupTest = document.getElementById("btn-gemini-setup-test");
            const btnGeminiSetupSave = document.getElementById("btn-gemini-setup-save");
            const btnEditApiConfig = document.getElementById("btn-edit-api-config");
            const geminiSetupKeyInput = document.getElementById("gemini-setup-key-input");
            const geminiSetupErrorBanner = document.getElementById("gemini-setup-error-banner");
            const geminiSetupErrorMsg = document.getElementById("gemini-setup-error-msg");

            if (btnGeminiSetupTest && geminiSetupKeyInput) {
                btnGeminiSetupTest.addEventListener("click", async () => {
                    const keyVal = geminiSetupKeyInput.value.trim();
                    if (geminiSetupErrorBanner) geminiSetupErrorBanner.classList.add("hidden");

                    if (!keyVal) {
                        this.showToast("Please enter an API key to test.", "error");
                        if (geminiSetupErrorBanner && geminiSetupErrorMsg) {
                            geminiSetupErrorMsg.textContent = "API key cannot be empty";
                            geminiSetupErrorBanner.classList.remove("hidden");
                        }
                        this.updateGeminiStatusUI(false);
                        return;
                    }

                    if (!keyVal.startsWith("AIza")) {
                        if (geminiSetupErrorBanner && geminiSetupErrorMsg) {
                            geminiSetupErrorMsg.textContent = "Invalid Gemini API Key format (must start with AIza)";
                            geminiSetupErrorBanner.classList.remove("hidden");
                        }
                        this.updateGeminiStatusUI(false);
                        return;
                    }

                    this.showToast("Testing Gemini connection...", "info");
                    this.updateGeminiStatusUI(false, "Testing...");
                    const res = await this.testGeminiConnection(keyVal);
                    if (res.success) {
                        this.showToast("Gemini connection test successful!", "success");
                        this.updateGeminiStatusUI(true);
                        if (geminiSetupErrorBanner) geminiSetupErrorBanner.classList.add("hidden");
                    } else {
                        this.showToast("Gemini connection test failed.", "error");
                        if (geminiSetupErrorBanner && geminiSetupErrorMsg) {
                            geminiSetupErrorMsg.textContent = res.error;
                            geminiSetupErrorBanner.classList.remove("hidden");
                        }
                        this.updateGeminiStatusUI(false);
                    }
                });
            }

            if (btnGeminiSetupSave && geminiSetupKeyInput) {
                btnGeminiSetupSave.addEventListener("click", async () => {
                    const keyVal = geminiSetupKeyInput.value.trim();
                    if (geminiSetupErrorBanner) geminiSetupErrorBanner.classList.add("hidden");

                    if (!keyVal) {
                        this.showToast("Please enter an API key to save.", "error");
                        if (geminiSetupErrorBanner && geminiSetupErrorMsg) {
                            geminiSetupErrorMsg.textContent = "API key cannot be empty";
                            geminiSetupErrorBanner.classList.remove("hidden");
                        }
                        this.updateGeminiStatusUI(false);
                        return;
                    }

                    // Even if format is invalid or test fails, we store the key in local storage as requested, but keep the overlay active
                    localStorage.setItem("ti_ai_key", keyVal);

                    if (!keyVal.startsWith("AIza")) {
                        if (geminiSetupErrorBanner && geminiSetupErrorMsg) {
                            geminiSetupErrorMsg.textContent = "Invalid Gemini API Key format (must start with AIza)";
                            geminiSetupErrorBanner.classList.remove("hidden");
                        }
                        this.updateGeminiStatusUI(false);
                        this.showToast("API key stored but is invalid. Gemini OCR blocked.", "warning");
                        return;
                    }

                    this.showToast("Verifying and saving API key...", "info");
                    this.updateGeminiStatusUI(false, "Verifying...");
                    const res = await this.testGeminiConnection(keyVal);
                    if (res.success) {
                        this.showToast("API key saved and connected successfully!", "success");
                        this.updateGeminiStatusUI(true);
                        
                        // Transition UI to uploader main content
                        const overlay = document.getElementById("gemini-setup-overlay");
                        const mainContent = document.getElementById("uploader-main-content");
                        if (overlay) overlay.classList.add("hidden");
                        if (mainContent) mainContent.classList.remove("hidden");
                    } else {
                        this.showToast("API key stored but connection test failed.", "error");
                        if (geminiSetupErrorBanner && geminiSetupErrorMsg) {
                            geminiSetupErrorMsg.textContent = res.error;
                            geminiSetupErrorBanner.classList.remove("hidden");
                        }
                        this.updateGeminiStatusUI(false);
                    }
                });
            }

            if (btnEditApiConfig) {
                btnEditApiConfig.addEventListener("click", () => {
                    const overlay = document.getElementById("gemini-setup-overlay");
                    const mainContent = document.getElementById("uploader-main-content");
                    const keyVal = localStorage.getItem("ti_ai_key") || "";

                    if (geminiSetupKeyInput) {
                        geminiSetupKeyInput.value = keyVal;
                    }

                    if (overlay) overlay.classList.remove("hidden");
                    if (mainContent) mainContent.classList.add("hidden");
                    if (geminiSetupErrorBanner) geminiSetupErrorBanner.classList.add("hidden");
                });
            }

            // Due Orders search input
            const dueSearch = document.getElementById("due-orders-search");
            if (dueSearch) {
                dueSearch.addEventListener("input", (e) => {
                    this.renderDueOrdersPage(e.target.value);
                });
            }

            // Due Orders status filter pills
            const dueFilters = document.getElementById("due-status-filters");
            if (dueFilters) {
                dueFilters.addEventListener("click", (e) => {
                    const pill = e.target.closest(".category-pill");
                    if (pill) {
                        dueFilters.querySelectorAll(".category-pill").forEach(p => p.classList.remove("active"));
                        pill.classList.add("active");
                        this._activeDueStatusFilter = pill.getAttribute("data-status");
                        const searchInput = document.getElementById("due-orders-search");
                        this.renderDueOrdersPage(searchInput ? searchInput.value : "");
                    }
                });
            }

            // Due Order Edit form submit
            const dueForm = document.getElementById("due-form");
            if (dueForm) {
                dueForm.addEventListener("submit", (e) => {
                    e.preventDefault();
                    this.saveDueForm();
                });
            }
        }

        // Tab Switching
        // Mobile bottom nav: highlight whichever tab was tapped. Purely
        // cosmetic, no effect on desktop (the bar is CSS-hidden there).
        setMobileNavActive(el) {
            const nav = document.getElementById("mobile-bottom-nav");
            if (!nav) return;
            nav.querySelectorAll("a").forEach(a => a.classList.remove("mobile-nav-active"));
            if (el) el.classList.add("mobile-nav-active");
        }

        switchTab(targetViewId) {
            // Remove active class from all nav items
            document.querySelectorAll(".menu-item").forEach(item => {
                item.classList.remove("active");
                if (item.getAttribute("data-target") === targetViewId) {
                    item.classList.add("active");
                }
            });

            // Toggle view panels
            document.querySelectorAll(".view-panel").forEach(panel => {
                panel.classList.remove("active");
            });
            const targetPanel = document.getElementById(targetViewId);
            if (targetPanel) {
                targetPanel.classList.add("active");
            }

            // Set Header View title
            const titlesMap = {
                "dashboard-view": "Dashboard Overview",
                "master-view": "Tablet Master Database",
                "bill-view": "Invoice Bill OCR Uploader",
                "order-view": "Order Verification & Deficit Tracker",
                "inventory-view": "Stock adjustments & logs",
                "due-view": "Due Orders Deficit Panel",
                "supplier-due-view": "Supplier Due — Reconciliation Panel",
                "expiry-view": "Expiry Management Dashboard",
                "not-available-view": "Not Available Products",
                "ai-reports-view": "AI Reporting Center — Ask a question, get a report",
                "reports-view": "Inventory Reports & Analytics",
                "ai-view": "Pharmacy AI Assistant",
                "reorder-view": "Reorder Management — Purchase Tracker",
                "user-mgmt-view": "User Management",
                "activity-log-view": "Activity Log"
            };
            document.getElementById("view-title").textContent = titlesMap[targetViewId] || "Got It Solutions Provider";

            // Trigger re-renders/initializations
            if (targetViewId === "dashboard-view") {
                this.renderDashboard();
            } else if (targetViewId === "master-view") {
                this.renderTabletList();
            } else if (targetViewId === "inventory-view") {
                this.renderInventoryAdjustPage();
            } else if (targetViewId === "due-view") {
                this.renderDueOrdersPage();
            } else if (targetViewId === "supplier-due-view") {
                this.renderSupplierDuePage();
            } else if (targetViewId === "expiry-view") {
                this.renderExpiryPage();
            } else if (targetViewId === "not-available-view") {
                this.renderNotAvailablePage();
            } else if (targetViewId === "ai-reports-view") {
                this.initAIReportsInterface();
            } else if (targetViewId === "reports-view") {
                this.renderReports();
            } else if (targetViewId === "ai-view") {
                this.initChatInterface();
            } else if (targetViewId === "reorder-view") {
                this.renderReorderPage();
            } else if (targetViewId === "user-mgmt-view") {
                this.renderUserManagementTable();
            } else if (targetViewId === "activity-log-view") {
                this.renderActivityLogPage();
            }

            // Close mobile menu sidebar if open
            document.querySelector(".sidebar").classList.remove("active");
            const _sidebarBackdropEl = document.getElementById("sidebar-drawer-backdrop");
            if (_sidebarBackdropEl) _sidebarBackdropEl.classList.remove("active");
            const _bottomNavEl = document.querySelector(".mobile-bottom-nav");
            if (_bottomNavEl) _bottomNavEl.classList.remove("drawer-open");
            this.activeView = targetViewId;
        }

        // Toast Messages
        // Debounces a render call by function name so rapid typing in search
        // boxes (Order History, Report Center, Reorder Page, Notifications)
        // doesn't trigger a full table re-render on every single keystroke --
        // a direct cause of the reported mobile typing/scroll lag. Waits
        // 220ms after the user stops typing, then renders once.
        _debounceTimers = {};
        debouncedRender(fnName) {
            clearTimeout(this._debounceTimers[fnName]);
            this._debounceTimers[fnName] = setTimeout(() => {
                if (typeof this[fnName] === "function") this[fnName]();
            }, 220);
        }

        showToast(message, type = "success") {
            const container = document.getElementById("toast-container");
            if (!container) return;

            const toast = document.createElement("div");
            toast.className = `toast ${type}`;
            
            let icon = "";
            if (type === "success") icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
            else if (type === "error") icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
            else if (type === "warning") icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
            else icon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;

            toast.innerHTML = `${icon}<span>${message}</span>`;
            container.appendChild(toast);

            // Trigger slide out and destroy
            setTimeout(() => {
                toast.classList.add("fade-out");
                toast.addEventListener("animationend", () => {
                    toast.remove();
                });
            }, 3500);
        }

        // Gemini "temporarily busy" banner (429/503/high-demand/overloaded).
        // This is intentionally separate from showToast: it needs to stay on
        // screen (not auto-dismiss) and carry actionable Retry/Cancel buttons,
        // and it must NEVER be shown alongside a Critical Alert -- a busy
        // model is not an OCR failure.
        showGeminiBusyBanner(anchorEl, onRetry, onCancel) {
            this.hideGeminiBusyBanner();
            if (!anchorEl || !anchorEl.parentNode) return;

            const banner = document.createElement("div");
            banner.id = "gemini-busy-banner";
            banner.style.cssText = "margin-top:12px;padding:14px 16px;border-radius:10px;background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.45);color:#fbbf24;font-size:14px;line-height:1.5;";
            banner.innerHTML = `
                <div style="margin-bottom:10px;">Gemini Vision is temporarily busy.<br>Your image is still loaded.<br>Please Retry in a few moments.</div>
                <div style="display:flex;gap:10px;">
                    <button type="button" class="btn btn-primary" id="gemini-busy-retry-btn">Retry Scan</button>
                    <button type="button" class="btn btn-secondary" id="gemini-busy-cancel-btn">Cancel</button>
                </div>`;
            anchorEl.parentNode.insertBefore(banner, anchorEl.nextSibling);

            banner.querySelector("#gemini-busy-retry-btn").addEventListener("click", () => {
                this.hideGeminiBusyBanner();
                if (typeof onRetry === "function") onRetry();
            });
            banner.querySelector("#gemini-busy-cancel-btn").addEventListener("click", () => {
                this.hideGeminiBusyBanner();
                if (typeof onCancel === "function") onCancel();
            });
        }

        hideGeminiBusyBanner() {
            const existing = document.getElementById("gemini-busy-banner");
            if (existing) existing.remove();
        }

        // Render Everything initial
        renderAll() {
            this.renderDashboard();
            this.updateDueBadges();
            this.updateSupplierDueBadge();
            
            // Set default date in forms
            const dateInput = document.getElementById("order-date-input");
            if (dateInput) {
                dateInput.value = new Date().toISOString().split('T')[0];
            }

            const billDateInput = document.getElementById("bill-manual-date");
            if (billDateInput) {
                billDateInput.value = new Date().toISOString().split('T')[0];
            }
            
            // Populate datalist for manual bills
            this.updateManualBillDatalist();
            this.renderInventoryAdjustPage();
            
            // Setup first Builder Row in order manual
            const builderRows = document.getElementById("builder-items-rows");
            if (builderRows && builderRows.children.length === 0) {
                this.addOrderBuilderRow();
            }

            // Setup first empty row in manual bill form
            const billManualRows = document.getElementById("bill-manual-items-rows");
            if (billManualRows && billManualRows.children.length === 0) {
                this.addBillManualRow();
            }

            // Initialize Gemini connection setup screen if needed
            this.initGeminiConnection();
            
            // Render due orders table initially
            this.renderDueOrdersPage();
        }

        // Update due orders badge indicators
        updateDueBadges() {
            const dues = this.getDueOrders().filter(d => d.status === "Pending" || d.status === "Partially Completed");
            const badgeSidebar = document.getElementById("due-badge-sidebar");
            const kpiDue = document.getElementById("kpi-due-orders");
            
            if (badgeSidebar) {
                badgeSidebar.textContent = dues.length;
                if (dues.length > 0) badgeSidebar.classList.add("active");
                else badgeSidebar.classList.remove("active");
            }
            
            if (kpiDue) {
                kpiDue.textContent = dues.length;
            }
        }

        // --- DASHBOARD PANEL ---
        updateReorderBadge() {
            const reorders = this.getReorders();
            const pending = reorders.filter(r => r.status === "Pending" || r.status === "Partially Ordered").length;
            const badge = document.getElementById("reorder-badge-sidebar");
            if (badge) {
                badge.textContent = pending;
                badge.style.display = pending > 0 ? "inline-flex" : "none";
            }
        }

        // ================================================================
        // SUPPLIER DUE -- reconciliation workflow (Priority 1)
        // Tracks invoice lines short-supplied by a supplier (distinct from
        // Due Orders above, which tracks stock owed TO a dispensary). Data
        // lives entirely in Supabase (supplier_due / supplier_due_items /
        // supplier_due_history via supabase-schema-supplier-due.sql) --
        // there is no localStorage copy, since this table is only ever
        // written server-side via the atomic RPC functions.
        // ================================================================

        // Cheap badge refresh: just a count against the outstanding view.
        // Safe to call even if supplier-due-view has never been opened yet
        // (used from renderAll()/renderViewById() alongside the other
        // sidebar badges).
        async updateSupplierDueBadge() {
            const badge = document.getElementById("supplier-due-badge-sidebar");
            if (!badge) return;
            if (!supabaseClient) { badge.textContent = "0"; badge.classList.remove("active"); return; }
            try {
                const { count, error } = await supabaseClient
                    .from("v_outstanding_supplier_due")
                    .select("due_item_id", { count: "exact", head: true });
                if (error) { console.warn("Supplier Due badge skipped (run supabase-schema-supplier-due.sql):", error.message); return; }
                badge.textContent = count || 0;
                if (count > 0) badge.classList.add("active"); else badge.classList.remove("active");
            } catch (e) {
                console.warn("Supplier Due badge unavailable:", e.message);
            }
        }

        setSupplierDueFilter(el, status) {
            document.querySelectorAll("#sd-status-filters .category-pill").forEach(p => {
                p.classList.remove("active");
                p.style.background = "rgba(255,255,255,0.05)";
            });
            if (el) { el.classList.add("active"); el.style.background = "rgba(255,255,255,0.1)"; }
            this.supplierDueFilterStatus = status;
            this.renderSupplierDuePage();
        }

        async renderSupplierDuePage() {
            const tbody = document.getElementById("sd-table-body");
            if (!tbody) return;
            const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

            if (!supabaseClient) {
                tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding:15px;">Not connected to the cloud database -- Supplier Due requires Supabase (run supabase-schema-supplier-due.sql, then reconnect).</td></tr>`;
                setText("sd-kpi-outstanding", "0"); setText("sd-kpi-total-qty", "0");
                setText("sd-kpi-suppliers", "0"); setText("sd-kpi-overdue", "0");
                return;
            }

            const status = this.supplierDueFilterStatus || "OUTSTANDING";
            const search = ((document.getElementById("sd-search") || {}).value || "").trim().toLowerCase();

            tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding:15px;">Loading...</td></tr>`;

            // KPI cards always reflect the outstanding view, regardless of
            // which status tab is currently selected.
            let outstandingRows = [];
            try {
                const { data, error } = await supabaseClient
                    .from("v_outstanding_supplier_due")
                    .select("*")
                    .order("age_days", { ascending: false });
                if (error) throw error;
                outstandingRows = data || [];
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding:15px;">Could not load Supplier Due data: ${e.message || e}</td></tr>`;
                return;
            }

            const totalQty = outstandingRows.reduce((s, r) => s + (Number(r.due_quantity) || 0), 0);
            const suppliers = new Set(outstandingRows.map(r => r.supplier_name));
            const overdue = outstandingRows.filter(r => (r.age_days || 0) >= 15).length;
            setText("sd-kpi-outstanding", outstandingRows.length);
            setText("sd-kpi-total-qty", totalQty);
            setText("sd-kpi-suppliers", suppliers.size);
            setText("sd-kpi-overdue", overdue);

            let rows = [];
            if (status === "OUTSTANDING") {
                rows = outstandingRows.map(r => ({
                    due_item_id: r.due_item_id, supplier_name: r.supplier_name, invoice_number: r.invoice_number,
                    medicine_name: r.medicine_name, strength: r.strength, product_code: r.product_code,
                    ordered_quantity: null, received_quantity: null, due_quantity: r.due_quantity,
                    unit: r.unit, status: r.status, age_days: r.age_days
                }));
            } else {
                // Not Available / Closed items sit outside the outstanding
                // view (by design -- see supabase-schema-supplier-due.sql),
                // so fetch supplier_due_items directly, then look up their
                // parent supplier_due headers for supplier/invoice display.
                try {
                    const wantStatuses = status === "closed" ? ["supplied"] : ["not_available"];
                    const { data: items, error: itemsErr } = await supabaseClient
                        .from("supplier_due_items")
                        .select("*")
                        .in("status", wantStatuses)
                        .order("updated_at", { ascending: false })
                        .limit(200);
                    if (itemsErr) throw itemsErr;
                    const dueIds = [...new Set((items || []).map(i => i.due_id))];
                    let headersById = {};
                    if (dueIds.length > 0) {
                        const { data: headers, error: hErr } = await supabaseClient
                            .from("supplier_due").select("id, supplier_name, invoice_number").in("id", dueIds);
                        if (hErr) throw hErr;
                        headersById = Object.fromEntries((headers || []).map(h => [h.id, h]));
                    }
                    rows = (items || []).map(i => {
                        const h = headersById[i.due_id] || {};
                        const created = new Date(i.created_at);
                        const ageDays = Math.floor((Date.now() - created.getTime()) / 86400000);
                        return {
                            due_item_id: i.id, supplier_name: h.supplier_name || "—", invoice_number: h.invoice_number,
                            medicine_name: i.medicine_name, strength: i.strength, product_code: i.product_code,
                            ordered_quantity: i.ordered_quantity, received_quantity: i.received_quantity,
                            due_quantity: i.due_quantity, unit: i.unit, status: i.status, age_days: ageDays
                        };
                    });
                } catch (e) {
                    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding:15px;">Could not load records: ${e.message || e}</td></tr>`;
                    return;
                }
            }

            if (search) {
                rows = rows.filter(r =>
                    (r.medicine_name || "").toLowerCase().includes(search) ||
                    (r.supplier_name || "").toLowerCase().includes(search) ||
                    (r.invoice_number || "").toLowerCase().includes(search)
                );
            }

            // Cache for the modal handlers (avoids a second round-trip when
            // Reconcile/Not Available/History is clicked).
            this._sdRowCache = rows;

            if (rows.length === 0) {
                tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding:15px;">No Supplier Due records for this filter.</td></tr>`;
                return;
            }

            const statusLabel = { due: "Due", partially_supplied: "Partially Supplied", supplied: "Supplied", not_available: "Not Available" };
            const statusColor = { due: "#ef4444", partially_supplied: "#f59e0b", supplied: "#22c55e", not_available: "#94a3b8" };

            tbody.innerHTML = rows.map(r => `
                <tr>
                    <td>${r.supplier_name || "—"}</td>
                    <td>${r.invoice_number || "—"}</td>
                    <td><strong>${r.medicine_name}</strong>${r.product_code ? `<div style="font-size:0.7rem;color:var(--text-muted);">${r.product_code}</div>` : ""}</td>
                    <td>${r.strength || "-"}</td>
                    <td>${r.ordered_quantity ?? "-"}</td>
                    <td>${r.received_quantity ?? "-"}</td>
                    <td style="font-weight:700;">${r.due_quantity} ${r.unit || ""}</td>
                    <td>${r.age_days != null ? r.age_days + "d" : "-"}</td>
                    <td><span class="badge" style="background:${statusColor[r.status] || '#64748b'}22;color:${statusColor[r.status] || '#64748b'};border:1px solid ${statusColor[r.status] || '#64748b'}55;">${statusLabel[r.status] || r.status}</span></td>
                    <td style="white-space:nowrap;">
                        ${(r.status === "due" || r.status === "partially_supplied") ? `
                            <button class="btn btn-secondary btn-sm" style="padding:3px 8px;font-size:0.72rem;margin-right:4px;" onclick="window.app.openSupplierDueReconcile('${r.due_item_id}')">Reconcile</button>
                            <button class="btn btn-secondary btn-sm" style="padding:3px 8px;font-size:0.72rem;margin-right:4px;color:#ef4444;" onclick="window.app.openSupplierDueNotAvailable('${r.due_item_id}')">Not Avail.</button>
                        ` : ""}
                        <button class="btn btn-secondary btn-sm" style="padding:3px 8px;font-size:0.72rem;" onclick="window.app.viewSupplierDueHistory('${r.due_item_id}')">History</button>
                    </td>
                </tr>
            `).join("");
        }

        closeSupplierDueModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.remove("active");
        }

        _findSdRow(dueItemId) {
            return (this._sdRowCache || []).find(r => String(r.due_item_id) === String(dueItemId));
        }

        // Opens the "Due Supplied" reconciliation modal.
        //
        // Business rule: Product Code is the permanent identity of the
        // medicine; medicine_name is for display only. If the due item has
        // a Product Code, this always re-fetches the current Master Data
        // record for that code and uses ITS name/strength/pack for display
        // -- so even if the original OCR text was wrong, reconciliation is
        // keyed on the Product Code, not the (possibly wrong) OCR name.
        // Only falls back to the due item's own stored name/strength when
        // no Product Code is on record (fuzzy match shown for information,
        // never auto-applied).
        //
        // Also re-fetches the due item row directly from Supabase (rather
        // than trusting the table-render cache), since the outstanding-view
        // cache doesn't carry ordered_quantity/received_quantity -- this
        // keeps Outstanding Qty / Received So Far accurate at the moment of
        // reconciliation, not just at last page render.
        async openSupplierDueReconcile(dueItemId) {
            const cachedRow = this._findSdRow(dueItemId);
            if (!cachedRow) { this.showToast("Could not find that Due item -- refresh and try again.", "error"); return; }

            let item = cachedRow;
            let supplierName = cachedRow.supplier_name;
            let invoiceNumber = cachedRow.invoice_number;
            try {
                const { data: freshItem, error: itemErr } = await supabaseClient
                    .from("supplier_due_items").select("*").eq("id", dueItemId).single();
                if (!itemErr && freshItem) {
                    item = freshItem;
                    const { data: header, error: hErr } = await supabaseClient
                        .from("supplier_due").select("supplier_name, invoice_number").eq("id", freshItem.due_id).single();
                    if (!hErr && header) { supplierName = header.supplier_name; invoiceNumber = header.invoice_number; }
                }
            } catch (e) {
                // Non-fatal: fall back to the cached row already captured
                // from the table render, just without ordered/received.
                console.warn("Supplier Due: could not refresh item before reconciling, using cached row:", e.message);
            }

            this._sdActiveItem = { ...item, supplier_name: supplierName, invoice_number: invoiceNumber };
            const active = this._sdActiveItem;

            // Product Code is the source of truth: if present, resolve the
            // CURRENT Master Data record for it and display that record's
            // name/strength/pack, not the (possibly OCR-mangled) stored text.
            const tablets = this.getTablets();
            let masterRecord = null;
            if (active.product_code) {
                masterRecord = tablets.find(t => t.code === active.product_code) || null;
            }

            document.getElementById("sd-reconcile-product-code").textContent = active.product_code || "Not Assigned";
            document.getElementById("sd-reconcile-medicine").textContent =
                masterRecord ? masterRecord.name : `${active.medicine_name}${active.strength ? " " + active.strength : ""}`;
            document.getElementById("sd-reconcile-supplier-line").textContent =
                `${supplierName || "—"} · Invoice ${invoiceNumber || "—"}`;
            document.getElementById("sd-reconcile-strength").textContent =
                masterRecord ? (this.normalizeStrengthToken(masterRecord.name) || active.strength || "-") : (active.strength || "-");
            document.getElementById("sd-reconcile-pack").textContent = masterRecord ? (masterRecord.pack || "-") : "-";
            document.getElementById("sd-reconcile-supplier").textContent = supplierName || "—";
            document.getElementById("sd-reconcile-invoice").textContent = invoiceNumber || "—";
            document.getElementById("sd-reconcile-outstanding").textContent = `${active.due_quantity} ${active.unit || ""}`;
            document.getElementById("sd-reconcile-received-so-far").textContent =
                active.received_quantity != null ? `${active.received_quantity} ${active.unit || ""}` : "—";

            // If no Product Code exists on this due record at all, be
            // explicit about it rather than silently showing a fuzzy guess
            // as if it were confirmed -- this is exactly the ambiguity the
            // Product Code system exists to remove.
            if (!active.product_code) {
                const resolved = this.resolveMedicine(active.medicine_name, null, tablets);
                document.getElementById("sd-reconcile-medicine").textContent =
                    resolved.tablet
                        ? `${active.medicine_name} (no Product Code on record — closest Master Data match: ${resolved.tablet.code}, ${resolved.matchScore}%, not applied automatically)`
                        : `${active.medicine_name} (no Product Code on record, no confident Master Data match)`;
            }

            const qtyInput = document.getElementById("sd-reconcile-qty");
            qtyInput.value = "";
            qtyInput.max = active.due_quantity;
            document.getElementById("sd-reconcile-error").style.display = "none";
            this.updateSupplierDueRemainingPreview();
            document.getElementById("sd-reconcile-modal").classList.add("active");
        }

        // Live-updates "Remaining Due After This Entry" as staff type a
        // quantity, purely a display preview -- the actual remaining value
        // is always recomputed server-side by reconcile_due_supplied_atomic.
        updateSupplierDueRemainingPreview() {
            const active = this._sdActiveItem;
            const remainingEl = document.getElementById("sd-reconcile-remaining");
            if (!active || !remainingEl) return;
            const qty = Number((document.getElementById("sd-reconcile-qty") || {}).value) || 0;
            const remaining = Math.max(0, Number(active.due_quantity) - qty);
            remainingEl.textContent = `${remaining} ${active.unit || ""}`;
        }

        async submitSupplierDueReconcile() {
            const row = this._sdActiveItem;
            const errEl = document.getElementById("sd-reconcile-error");
            errEl.style.display = "none";
            if (!row) return;

            const qty = Number(document.getElementById("sd-reconcile-qty").value);
            if (!qty || qty <= 0) {
                errEl.textContent = "Enter a quantity greater than 0.";
                errEl.style.display = "block";
                return;
            }
            if (qty > Number(row.due_quantity)) {
                errEl.textContent = `Cannot exceed the outstanding due quantity (${row.due_quantity} ${row.unit || ""}).`;
                errEl.style.display = "block";
                return;
            }

            const performedBy = (this.currentUser && this.currentUser.name) || "Unknown";
            try {
                const { error } = await supabaseClient.rpc("reconcile_due_supplied_atomic", {
                    p_due_item_id: row.due_item_id || row.id, p_supplied_quantity: qty, p_performed_by: performedBy
                });
                if (error) throw error;
                this.closeSupplierDueModal("sd-reconcile-modal");
                this.showToast(`Recorded ${qty} ${row.unit || ""} received for ${row.medicine_name}${row.product_code ? " (" + row.product_code + ")" : ""}.`, "success");
                this.renderSupplierDuePage();
                this.updateSupplierDueBadge();
            } catch (e) {
                errEl.textContent = e.message || "Failed to save -- please try again.";
                errEl.style.display = "block";
            }
        }

        openSupplierDueNotAvailable(dueItemId) {
            const row = this._findSdRow(dueItemId);
            if (!row) { this.showToast("Could not find that Due item -- refresh and try again.", "error"); return; }
            this._sdActiveItem = row;
            document.getElementById("sd-na-medicine").textContent = `${row.medicine_name}${row.strength ? " " + row.strength : ""} -- ${row.due_quantity} ${row.unit || ""} outstanding from ${row.supplier_name || "—"}`;
            document.getElementById("sd-na-reason").value = "";
            document.getElementById("sd-not-available-modal").classList.add("active");
        }

        async submitSupplierDueNotAvailable() {
            const row = this._sdActiveItem;
            if (!row) return;
            const reason = document.getElementById("sd-na-reason").value.trim();
            const performedBy = (this.currentUser && this.currentUser.name) || "Unknown";
            try {
                const { error } = await supabaseClient.rpc("mark_due_not_available_atomic", {
                    p_due_item_id: row.due_item_id, p_reason: reason || null, p_performed_by: performedBy
                });
                if (error) throw error;
                this.closeSupplierDueModal("sd-not-available-modal");
                this.showToast(`${row.medicine_name} marked Not Available.`, "success");
                this.renderSupplierDuePage();
                this.updateSupplierDueBadge();
            } catch (e) {
                this.showToast(`Failed to mark Not Available: ${e.message || e}`, "error");
            }
        }

        async viewSupplierDueHistory(dueItemId) {
            const row = this._findSdRow(dueItemId);
            const listEl = document.getElementById("sd-history-list");
            listEl.innerHTML = `<p class="text-muted">Loading...</p>`;
            document.getElementById("sd-history-modal").classList.add("active");
            try {
                const { data, error } = await supabaseClient
                    .from("supplier_due_history")
                    .select("*")
                    .eq("due_item_id", dueItemId)
                    .order("created_at", { ascending: false });
                if (error) throw error;
                if (!data || data.length === 0) {
                    listEl.innerHTML = `<p class="text-muted">No history recorded yet.</p>`;
                    return;
                }
                const eventLabel = { created: "Created", partial_supply: "Partial Supply", due_supplied: "Due Supplied", due_closed: "Due Closed", not_available: "Not Available", reopened: "Reopened" };
                listEl.innerHTML = data.map(h => `
                    <div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                        <div style="display:flex;justify-content:space-between;">
                            <strong>${eventLabel[h.event_type] || h.event_type}</strong>
                            <span style="color:var(--text-muted);font-size:0.75rem;">${new Date(h.created_at).toLocaleString()}</span>
                        </div>
                        ${h.quantity != null ? `<div>Qty: ${h.quantity}</div>` : ""}
                        ${h.previous_status || h.new_status ? `<div style="font-size:0.8rem;color:var(--text-muted);">${h.previous_status || "—"} → ${h.new_status || "—"}</div>` : ""}
                        ${h.notes ? `<div style="font-size:0.8rem;">${h.notes}</div>` : ""}
                        ${h.performed_by ? `<div style="font-size:0.75rem;color:var(--text-muted);">by ${h.performed_by}</div>` : ""}
                    </div>
                `).join("");
            } catch (e) {
                listEl.innerHTML = `<p class="text-muted">Could not load history: ${e.message || e}</p>`;
            }
        }

        renderOrderHistoryTable() {
            const tbody = document.getElementById("order-history-table-body");
            if (!tbody) return;

            const orders = this.getScannedOrders();
            const searchQ = (document.getElementById("order-history-search") ? document.getElementById("order-history-search").value : "").toLowerCase().trim();

            const filtered = orders.filter(o => {
                if (!searchQ) return true;
                return (o.refId || "").toLowerCase().includes(searchQ) ||
                       (o.dispensaryName || "").toLowerCase().includes(searchQ) ||
                       (o.customer || "").toLowerCase().includes(searchQ);
            });

            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted" style="padding:20px;">No scanned morning orders found.</td></tr>`;
                return;
            }

            tbody.innerHTML = "";
            [...filtered].reverse().forEach(o => {
                const tr = document.createElement("tr");
                const statusColors = { "Pending": "badge-danger", "Partially Completed": "badge-warning", "Completed": "badge-success" };
                const count = o.medicines.length;

                tr.innerHTML = `
                    <td><strong>${o.refId}</strong></td>
                    <td><strong>${o.dispensaryId}</strong><div style="font-size:0.75rem;color:var(--text-muted)">${o.dispensaryName}</div></td>
                    <td>${o.date}</td>
                    <td>${count} medicine${count !== 1 ? 's' : ''}</td>
                    <td><span class="status-badge ${statusColors[o.status] || 'badge-info'}">${o.status}</span></td>
                    <td>
                        <div style="display:flex;gap:6px;">
                            <button class="btn btn-secondary btn-sm" onclick="window.app.viewScannedOrderDetails('${o.id}')">View</button>
                            <button class="btn btn-outline btn-sm danger" onclick="window.app.deleteScannedOrder('${o.id}')">Delete</button>
                        </div>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        }

        viewScannedOrderDetails(id) {
            const orders = this.getScannedOrders();
            const o = orders.find(ord => ord.id === id);
            if (!o) return;

            document.getElementById("so-detail-dispensary").textContent = `${o.dispensaryName} (${o.dispensaryId})`;
            document.getElementById("so-detail-ref").textContent = o.refId;
            document.getElementById("so-detail-date").textContent = o.date;

            const tbody = document.getElementById("so-detail-items-body");
            if (tbody) {
                tbody.innerHTML = "";
                o.medicines.forEach(med => {
                    const tr = document.createElement("tr");
                    // med.name can be raw OCR text (unmatched "new medicine" items
                    // keep the scanned name verbatim -- see verifyStockItems /
                    // item.isNewMedicine). Escape before innerHTML.
                    tr.innerHTML = `
                        <td><strong>${this.escapeHtml(med.name)}</strong></td>
                        <td>${med.reqQty} packs</td>
                        <td>${med.availQty} packs</td>
                        <td>${med.dueQty} packs</td>
                    `;
                    tbody.appendChild(tr);
                });
            }

            const modal = document.getElementById("scanned-order-detail-modal");
            if (modal) modal.classList.add("active");
        }

        closeScannedOrderDetailModal() {
            const modal = document.getElementById("scanned-order-detail-modal");
            if (modal) modal.classList.remove("active");
        }

        deleteScannedOrder(id) {
            if (!confirm("Are you sure you want to delete this order from history?")) return;
            let orders = this.getScannedOrders();
            orders = orders.filter(o => o.id !== id);
            this.setScannedOrders(orders);
            this.renderOrderHistoryTable();
        }

        updateScannedOrderStatus(orderId, tabletName, dispensaryId, fulfilledQty) {
            const scannedOrders = this.getScannedOrders();
            const order = scannedOrders.find(o => o.refId === orderId && o.dispensaryId === dispensaryId);
            if (order) {
                const med = order.medicines.find(m => m.name.toUpperCase() === tabletName.toUpperCase());
                if (med) {
                    const toMove = Math.min(med.dueQty, fulfilledQty);
                    med.dueQty -= toMove;
                    med.availQty += toMove;
                }
                
                // Re-evaluate overall order status
                const totalDue = order.medicines.reduce((sum, m) => sum + m.dueQty, 0);
                const totalAvail = order.medicines.reduce((sum, m) => sum + m.availQty, 0);
                if (totalDue === 0) {
                    order.status = "Completed";
                } else if (totalAvail > 0) {
                    order.status = "Partially Completed";
                } else {
                    order.status = "Pending";
                }
                this.setScannedOrders(scannedOrders);
            }
        }

        async handleMultiPageBillUpload(files) {
            this.showToast(`Loading and merging ${files.length} pages...`, "info");
            
            try {
                const images = [];
                for (let file of files) {
                    const img = await this._loadImageFile(file);
                    images.push(img);
                }
                
                // Combine them
                const canvas = document.createElement("canvas");
                const ctx = canvas.getContext("2d");
                
                const maxWidth = Math.max(...images.map(img => img.width));
                const totalHeight = images.reduce((sum, img) => sum + img.height, 0);
                
                canvas.width = maxWidth;
                canvas.height = totalHeight;
                
                // Draw background white
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(0, 0, maxWidth, totalHeight);
                
                let currentY = 0;
                for (let img of images) {
                    ctx.drawImage(img, 0, currentY);
                    currentY += img.height;
                }
                
                // Show the combined image on our scanner canvas
                const scannerCanvas = document.getElementById("scanner-canvas");
                if (scannerCanvas) {
                    scannerCanvas.width = maxWidth;
                    scannerCanvas.height = totalHeight;
                    const sCtx = scannerCanvas.getContext("2d");
                    sCtx.drawImage(canvas, 0, 0);
                    scannerCanvas.classList.remove("hidden");
                    const emptyState = document.getElementById("scanner-empty-state");
                    if (emptyState) emptyState.classList.add("hidden");
                }
                
                const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                const base64Data = dataUrl.split(",")[1];
                
                // Now run standard staged OCR on the single combined image
                this.runStagedOCRScan(base64Data, "image/jpeg", "combined_invoice.jpg");
                
            } catch (err) {
                console.error("Error merging pages:", err);
                this.showToast("Failed to merge pages: " + err.message, "error");
            }
        }
        
        _loadImageFile(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = reject;
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        triggerNotification(module, errorType, description, severity, details = {}) {
            const notifications = this.getNotifications();
            const now = new Date();
            const nowStr = now.toISOString().replace('T', ' ').substring(0, 19);
            
            const options = { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
            const formattedDateTime = now.toLocaleDateString('en-GB', options);

            const notiId = `noti-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            
            const newNoti = {
                id: notiId,
                datetime: formattedDateTime,
                rawDate: now.toISOString(),
                module: module,
                medicineName: details.medicineName || "N/A",
                errorType: errorType,
                severity: severity,
                description: description,
                status: "Active",
                invoiceNo: details.invoiceNo || "N/A",
                orderId: details.orderId || "N/A",
                lastUpdated: nowStr
            };
            
            notifications.push(newNoti);
            this.setNotifications(notifications);

            // Generate Developer Log
            const devLogs = this.getDevLogs();
            const stackTrace = details.stackTrace || (new Error().stack);
            
            const devLog = {
                id: `devlog-${Date.now()}`,
                datetime: formattedDateTime,
                rawDate: now.toISOString(),
                user: this.currentUser ? this.currentUser.name : "System",
                module: module,
                errorType: errorType,
                errorDetails: details.errorDetails || description,
                ocrConfidence: details.ocrConfidence || null,
                invoiceNumber: details.invoiceNo || "N/A",
                orderNumber: details.orderId || "N/A",
                stackTrace: stackTrace
            };
            
            devLogs.push(devLog);
            this.setDevLogs(devLogs);

            this.showToast(`🚨 New ${severity} alert in ${module}!`, severity === "Critical" ? "error" : "warning");
            this.updateNotificationBellDot();
            
            const drawer = document.getElementById("notification-drawer");
            if (drawer && drawer.classList.contains("active")) {
                this.renderNotifications();
            }
        }

        updateNotificationBellDot() {
            const notifications = this.getNotifications();
            const activeNotis = notifications.filter(n => n.status === "Active");
            const dot = document.querySelector(".notification-bell .bell-dot");
            if (dot) {
                if (activeNotis.length > 0) {
                    dot.classList.add("active");
                } else {
                    dot.classList.remove("active");
                }
            }
        }

        toggleNotificationDrawer() {
            const drawer = document.getElementById("notification-drawer");
            const backdrop = document.getElementById("drawer-backdrop");
            if (drawer && backdrop) {
                const isActive = drawer.classList.toggle("active");
                backdrop.classList.toggle("active", isActive);
                if (isActive) {
                    this.renderNotifications();
                }
            }
        }

        renderNotifications() {
            const container = document.getElementById("drawer-list-container");
            if (!container) return;

            const notifications = this.getNotifications();
            const searchQ = (document.getElementById("noti-search") ? document.getElementById("noti-search").value : "").toLowerCase().trim();
            const timeFilter = document.getElementById("noti-time-filter") ? document.getElementById("noti-time-filter").value : "ALL";
            const moduleFilter = document.getElementById("noti-module-filter") ? document.getElementById("noti-module-filter").value : "ALL";
            const severityFilter = document.getElementById("noti-severity-filter") ? document.getElementById("noti-severity-filter").value : "ALL";
            const statusFilter = document.getElementById("noti-status-filter") ? document.getElementById("noti-status-filter").value : "ALL";

            const now = new Date();
            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const startOfYesterday = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
            const startOf7DaysAgo = new Date(startOfToday.getTime() - 7 * 24 * 60 * 60 * 1000);

            const filtered = notifications.filter(n => {
                if (statusFilter !== "ALL" && n.status !== statusFilter) return false;
                if (severityFilter !== "ALL" && n.severity !== severityFilter) return false;
                if (moduleFilter !== "ALL" && n.module !== moduleFilter) return false;

                const itemDate = new Date(n.rawDate);
                if (timeFilter === "TODAY" && itemDate < startOfToday) return false;
                if (timeFilter === "YESTERDAY" && (itemDate < startOfYesterday || itemDate >= startOfToday)) return false;
                if (timeFilter === "LAST_7_DAYS" && itemDate < startOf7DaysAgo) return false;

                if (searchQ) {
                    return (n.medicineName || "").toLowerCase().includes(searchQ) ||
                           (n.invoiceNo || "").toLowerCase().includes(searchQ) ||
                           (n.orderId || "").toLowerCase().includes(searchQ) ||
                           (n.description || "").toLowerCase().includes(searchQ) ||
                           (n.errorType || "").toLowerCase().includes(searchQ);
                }

                return true;
            });

            if (filtered.length === 0) {
                container.innerHTML = `<div class="text-center text-muted" style="padding: 20px; font-size: 0.85rem;">No alerts or notifications match filters.</div>`;
                return;
            }

            container.innerHTML = "";
            [...filtered].reverse().forEach(n => {
                const itemDiv = document.createElement("div");
                const severityClass = {
                    "Critical": "critical",
                    "Warning": "warning",
                    "Review Required": "review",
                    "Information": "info"
                }[n.severity] || "info";
                
                const statusClass = n.status === "Resolved" ? "resolved" : "";
                
                itemDiv.className = `noti-item ${severityClass} ${statusClass}`;
                itemDiv.onclick = () => this.openNotificationDetailModal(n.id);

                const severityEmoji = {
                    "Critical": "🔴",
                    "Warning": "🟠",
                    "Review Required": "🟡",
                    "Information": "🟢"
                }[n.severity] || "🟢";

                itemDiv.innerHTML = `
                    <div class="noti-meta">
                        <span>${n.module}</span>
                        <span>${n.datetime}</span>
                    </div>
                    <div class="noti-title">${severityEmoji} ${n.errorType}</div>
                    <div class="noti-desc">${n.description.replace(/\\n/g, '<br>')}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; font-size:0.75rem;">
                        <span class="status-badge" style="background:rgba(255,255,255,0.06); padding:2px 6px;">Status: ${n.status}</span>
                        <span style="color:var(--text-muted); font-size:0.7rem;">Click to act</span>
                    </div>
                `;
                container.appendChild(itemDiv);
            });
        }

        openNotificationDetailModal(id) {
            const notifications = this.getNotifications();
            const n = notifications.find(noti => noti.id === id);
            if (!n) return;

            document.getElementById("noti-detail-title").textContent = n.errorType;
            document.getElementById("noti-detail-datetime").textContent = n.datetime;
            document.getElementById("noti-detail-module").textContent = n.module;
            document.getElementById("noti-detail-severity").textContent = n.severity;
            document.getElementById("noti-detail-status").textContent = n.status;
            document.getElementById("noti-detail-medicine").textContent = n.medicineName || "N/A";
            document.getElementById("noti-detail-desc").innerHTML = n.description.replace(/\\n/g, '<br>');

            const devLogs = this.getDevLogs();
            const devLog = devLogs.find(dl => dl.datetime === n.datetime && dl.errorType === n.errorType);
            const devSection = document.getElementById("noti-detail-dev-section");
            const devLogsPre = document.getElementById("noti-detail-dev-logs");
            
            if (devLog && devSection && devLogsPre) {
                devSection.classList.remove("hidden");
                devLogsPre.textContent = `User: ${devLog.user}\nError details: ${devLog.errorDetails}\nOCR Confidence: ${devLog.ocrConfidence || 'N/A'}\nInvoice #: ${devLog.invoiceNumber}\nOrder #: ${devLog.orderNumber}\nStack Trace:\n${devLog.stackTrace || 'None'}`;
            } else if (devSection) {
                devSection.classList.add("hidden");
            }

            const actionsBar = document.getElementById("noti-detail-actions");
            if (actionsBar) {
                actionsBar.innerHTML = "";
                
                if (n.status === "Active") {
                    actionsBar.innerHTML += `<button type="button" class="btn btn-success" onclick="window.app.resolveNotification('${n.id}')">Mark as Resolved</button>`;
                }
                
                if (n.errorType.toLowerCase().includes("ocr") || n.errorType.toLowerCase().includes("validation")) {
                    actionsBar.innerHTML += `<button type="button" class="btn btn-primary" onclick="window.app.retryNotificationAction('${n.id}')">Retry</button>`;
                }
                
                if (n.medicineName && n.medicineName !== "N/A") {
                    actionsBar.innerHTML += `<button type="button" class="btn btn-secondary" onclick="window.app.editNotificationTarget('${n.id}')">Edit Target</button>`;
                }
                
                if (this.currentUser.role === "Administrator" && n.status === "Active") {
                    actionsBar.innerHTML += `<button type="button" class="btn btn-outline" style="border-color:var(--color-coral); color:var(--color-coral);" onclick="window.app.ignoreNotification('${n.id}')">Ignore</button>`;
                }
                
                actionsBar.innerHTML += `<button type="button" class="btn btn-secondary" onclick="window.app.closeNotificationDetailModal()">Close</button>`;
            }

            const modal = document.getElementById("notification-detail-modal");
            if (modal) modal.classList.add("active");
        }

        closeNotificationDetailModal() {
            const modal = document.getElementById("notification-detail-modal");
            if (modal) modal.classList.remove("active");
        }

        resolveNotification(id) {
            const notifications = this.getNotifications();
            const n = notifications.find(noti => noti.id === id);
            if (n) {
                n.status = "Resolved";
                n.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
                this.setNotifications(notifications);
                this.showToast("Notification marked as Resolved.");
                this.closeNotificationDetailModal();
                this.renderNotifications();
                this.updateNotificationBellDot();
            }
        }

        ignoreNotification(id) {
            const notifications = this.getNotifications();
            const n = notifications.find(noti => noti.id === id);
            if (n) {
                n.status = "Ignored";
                n.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
                this.setNotifications(notifications);
                this.showToast("Notification marked as Ignored.");
                this.closeNotificationDetailModal();
                this.renderNotifications();
                this.updateNotificationBellDot();
            }
        }

        clearAllNotifications() {
            if (!confirm("Clear all notifications permanently?")) return;
            localStorage.setItem("ti_notifications", "[]");
            localStorage.setItem("ti_developer_logs", "[]");
            this.renderNotifications();
            this.updateNotificationBellDot();
            this.showToast("Notifications cleared successfully.");
        }

        retryNotificationAction(id) {
            this.showToast("Retrying action...");
            this.closeNotificationDetailModal();
            setTimeout(() => {
                this.showToast("Retry complete. Check results.", "success");
            }, 1000);
        }

        editNotificationTarget(id) {
            const notifications = this.getNotifications();
            const n = notifications.find(noti => noti.id === id);
            if (!n) return;
            
            this.closeNotificationDetailModal();
            this.toggleNotificationDrawer();
            
            if (n.medicineName && n.medicineName !== "N/A") {
                this.switchTab("master-view");
                const search = document.getElementById("tablet-search");
                if (search) {
                    search.value = n.medicineName;
                    this.renderTabletList();
                }
            } else if (n.module === "Bill Processing") {
                this.switchTab("bill-view");
            }
        }

        openHighValueConfigModal() {
            const highValueList = JSON.parse(localStorage.getItem("ti_high_value_list") || '["HUMAN ALBUMIN", "FENTANYL", "TRAMADOL"]');
            const input = document.getElementById("high-value-list-input");
            if (input) {
                input.value = highValueList.join("\n");
            }
            const modal = document.getElementById("high-value-config-modal");
            if (modal) modal.classList.add("active");
        }

        closeHighValueConfigModal() {
            const modal = document.getElementById("high-value-config-modal");
            if (modal) modal.classList.remove("active");
        }

        saveHighValueConfig() {
            const input = document.getElementById("high-value-list-input");
            if (input) {
                const list = input.value.split("\n")
                    .map(item => item.trim().toUpperCase())
                    .filter(item => item.length > 0);
                localStorage.setItem("ti_high_value_list", JSON.stringify(list));
                this.showToast("High Value Medicine list saved successfully.", "success");
                this.closeHighValueConfigModal();
            }
        }

        checkHighValueMedicineAlert(medicineName, qty, module, refId = "N/A") {
            const highValueList = JSON.parse(localStorage.getItem("ti_high_value_list") || '["HUMAN ALBUMIN", "FENTANYL", "TRAMADOL"]');
            const cleanName = (medicineName || "").trim().toUpperCase();
            const matchedKeyword = highValueList.find(kw => cleanName.includes(kw.trim().toUpperCase()));
            if (matchedKeyword) {
                this.triggerNotification(
                    module,
                    "High Value Medicine Alert",
                    `🔴 High Value Medicine Alert\nMedicine: ${medicineName}\nQuantity: ${qty}\nPlease verify before processing.`,
                    "Critical",
                    {
                        medicineName: medicineName,
                        invoiceNo: module === "Bill Processing" ? refId : "N/A",
                        orderId: module === "Order Processing" ? refId : "N/A"
                    }
                );
            }
        }

        // Strips known manufacturer/distributor prefixes for cleaner table
        // display (e.g. "USV L. ROSEVAST 10MG TABLET" -> "ROSEVAST 10MG
        // TABLET") -- unlike getCleanBrandName() (used elsewhere for
        // brand-only alternative suggestions), this keeps Strength/Form
        // intact since the Reorder table needs the full identity visible.
        // Reuses the same manufacturer prefix list as generateProductCode()
        // so display and Product Code generation never disagree about what
        // counts as a "manufacturer prefix" vs. the brand itself.
        getCleanTabletName(name) {
            if (!name) return "";
            const prefixes = ["USV L.", "USV", "PHAR", "LUPIN", "GRAN", "REDD", "UNJOINT", "AVEN", "SUN P", "SUN", "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", "GLEN", "MICR", "ALLE", "NOVA", "ANGL", "GERM", "SUNW", "LINK", "CIPLA", "MSD", "RANB", "MANO", "CADILA", "ABBOTT", "ALKEM", "TORRENT", "ZYDUS", "SANOFI", "GLAXO", "GSK", "PFIZER", "DR.REDDY", "DR.REDDY'S"];
            const upper = name.trim().toUpperCase();
            for (const p of prefixes) {
                if (upper.startsWith(p + " ")) {
                    return name.trim().substring(p.length + 1).trim();
                }
            }
            return name.trim();
        }

        renderReorderPage() {

            const tableBody = document.getElementById("reorder-table-body");
            if (!tableBody) return;

            const reorders = this.getReorders();
            console.log(`[Reorder Chain] getReorders(): ${reorders.length}`);
            const searchQ = (document.getElementById("reorder-search") ? document.getElementById("reorder-search").value : "").toLowerCase().trim();
            const statusFilter = document.getElementById("reorder-status-filter") ? document.getElementById("reorder-status-filter").value : "ALL";

            // KPIs
            const todayStr = new Date().toISOString().split("T")[0];
            const pending = reorders.filter(r => r.status === "Pending" || r.status === "Partially Ordered");
            const ordered = reorders.filter(r => r.status === "Ordered");
            const completedToday = reorders.filter(r => r.status === "Completed" && r.lastUpdated && r.lastUpdated.startsWith(todayStr));
            const totalQty = pending.reduce((s, r) => s + (r.toOrderQty || 0), 0);

            const kpiPending = document.getElementById("ro-kpi-pending"); if (kpiPending) kpiPending.textContent = pending.length;
            const kpiOrdered = document.getElementById("ro-kpi-ordered"); if (kpiOrdered) kpiOrdered.textContent = ordered.length;
            const kpiCompleted = document.getElementById("ro-kpi-completed"); if (kpiCompleted) kpiCompleted.textContent = completedToday.length;
            const kpiTotalQty = document.getElementById("ro-kpi-total-qty"); if (kpiTotalQty) kpiTotalQty.textContent = totalQty;

            const filtered = reorders.filter(r => {
                if (statusFilter !== "ALL" && r.status !== statusFilter) return false;
                if (!searchQ) return true;
                return (r.dispensaryId || "").toLowerCase().includes(searchQ) ||
                       (r.dispensaryName || "").toLowerCase().includes(searchQ) ||
                       (r.tabletName || "").toLowerCase().includes(searchQ) ||
                       (r.genericName || "").toLowerCase().includes(searchQ) ||
                       (r.supplier || "").toLowerCase().includes(searchQ) ||
                       (r.date || "").toLowerCase().includes(searchQ) ||
                       (r.orderId || "").toLowerCase().includes(searchQ);
            });

            console.log(`[Reorder Chain] After filter (status=${statusFilter}, search="${searchQ}"): ${filtered.length}`);

            if (filtered.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="14" class="text-center text-muted" style="padding:30px;">No reorder items match the current filter.</td></tr>`;
                this.updateReorderBadge();
                return;
            }

            tableBody.innerHTML = "";
            let renderedCount = 0;
            [...filtered].reverse().forEach(ro => {
              // BUGFIX: mirrors the Master Data "All Products" fix -- this loop
              // previously had no error isolation, so one malformed reorder
              // record (e.g. a missing tabletName/category) threw mid-iteration
              // and forEach silently stopped rendering every row after it. The
              // KPI counters above are computed separately and still looked
              // correct, producing "Pending count is right but table is empty
              // (or short)". Wrapping each row means one bad record is skipped
              // and logged instead of taking the rest of the list down with it.
              try {
                const prioColors = { "Normal": "badge-info", "High": "badge-warning", "Critical": "badge-danger" };
                const statusColors = { "Pending": "badge-danger", "Ordered": "badge-warning", "Partially Ordered": "badge-warning", "Completed": "badge-success" };

                const tablets = this.getTablets();
                const tabObj = (ro.tabletCode && ro.tabletCode !== "N/A" ? this.getTabletByCode(ro.tabletCode) : null) || tablets.find(t => t.name === ro.tabletName);
                const cat = tabObj ? tabObj.category : "Tablets & Capsules";
                // BUGFIX: `tps` (tabs-per-strip) was referenced below without ever
                // being declared in this function, throwing a ReferenceError on the
                // very first row. Since this forEach populates the table body, that
                // exception silently aborted rendering of every row -- the KPI
                // counters above (computed before this loop) still updated
                // correctly, producing exactly the reported symptom: "Pending count
                // updates, but the Reorder table stays empty."
                const tps = tabObj ? (tabObj.tabsPerStrip || 10) : 10;

                const toOrderFmt = this.fmtStock(ro.toOrderQty, tps, cat);

                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td><span class="status-badge ${prioColors[ro.priority] || 'badge-info'}">${ro.priority || "Normal"}</span></td>
                    <td><strong>${this.escapeHtml(this.getCleanTabletName(ro.tabletName))}</strong>${ro.isNewMedicine ? '<div><span class="status-badge badge-info" style="font-size:0.65rem;padding:1px 5px;margin-top:3px;display:inline-block;">New Medicine</span></div>' : ''}</td>
                    <td>${ro.genericName || "N/A"}</td>
                    <td>${ro.strength || "—"}</td>
                    <td><strong>${ro.dispensaryId || "N/A"}</strong><div style="font-size:0.72em;color:var(--text-muted)">${ro.dispensaryName || ""}</div></td>
                    <td><code>${ro.orderId || "N/A"}</code></td>
                    <td>${this.fmtStock(ro.reqQty, tps, cat)}</td>
                    <td>${this.fmtStock(ro.availQty, tps, cat)}</td>
                    <td><span class="font-weight-700 text-coral">${toOrderFmt}</span></td>
                    <td><input type="text" value="${(ro.supplier || "").replace(/"/g, '&quot;')}" placeholder="Supplier" onchange="window.app.updateReorderField('${ro.id}', 'supplier', this.value)" style="width:110px;font-size:0.78rem;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;"></td>
                    <td><input type="text" value="${(ro.notes || "").replace(/"/g, '&quot;')}" placeholder="Remarks" onchange="window.app.updateReorderField('${ro.id}', 'notes', this.value)" style="width:110px;font-size:0.78rem;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;"></td>
                    <td>${ro.date || "—"}</td>
                    <td><span class="status-badge ${statusColors[ro.status] || 'badge-info'}">${ro.status}</span></td>
                    <td>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;">
                            ${ro.status !== "Completed" ? `
                                <select onchange="window.app.updateReorderStatus('${ro.id}', this.value)" style="font-size:0.75rem;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;cursor:pointer;">
                                    <option value="Pending" ${ro.status==="Pending"?"selected":""}>Pending</option>
                                    <option value="Ordered" ${ro.status==="Ordered"?"selected":""}>Ordered</option>
                                    <option value="Partially Ordered" ${ro.status==="Partially Ordered"?"selected":""}>Partial</option>
                                    <option value="Completed" ${ro.status==="Completed"?"selected":""}>Completed</option>
                                </select>
                                <select onchange="window.app.updateReorderPriority('${ro.id}', this.value)" style="font-size:0.75rem;padding:4px 8px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;cursor:pointer;">
                                    <option value="Normal" ${ro.priority==="Normal"?"selected":""}>Normal</option>
                                    <option value="High" ${ro.priority==="High"?"selected":""}>High</option>
                                    <option value="Critical" ${ro.priority==="Critical"?"selected":""}>Critical</option>
                                </select>
                            ` : ""}
                            <button class="btn-icon-only danger" onclick="window.app.deleteReorderItem('${ro.id}')" title="Delete">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"></path></svg>
                            </button>
                        </div>
                    </td>
                `;
                tableBody.appendChild(tr);
                renderedCount++;
              } catch (rowErr) {
                console.error("Skipping one malformed reorder row (see [Reorder Chain] log):", ro, rowErr);
              }
            });

            console.log(`[Reorder Chain] Rendered: ${renderedCount}` + (renderedCount !== filtered.length ? ` (⚠ dropped ${filtered.length - renderedCount} row(s) — see error above)` : ""));

            this.updateReorderBadge();
        }

        updateReorderStatus(id, newStatus) {
            const reorders = this.getReorders();
            const item = reorders.find(r => r.id === id);
            if (!item) return;
            item.status = newStatus;
            item.lastUpdated = new Date().toISOString().replace("T"," ").substring(0,19);
            this.setReorders(reorders);
            this.renderReorderPage();
            this.showToast(`Reorder status updated to "${newStatus}".`);
        }

        updateReorderPriority(id, priority) {
            const reorders = this.getReorders();
            const item = reorders.find(r => r.id === id);
            if (!item) return;
            item.priority = priority;
            item.lastUpdated = new Date().toISOString().replace("T"," ").substring(0,19);
            this.setReorders(reorders);
            this.renderReorderPage();
        }

        updateReorderField(id, field, value) {
            const reorders = this.getReorders();
            const item = reorders.find(r => r.id === id);
            if (!item) return;
            item[field] = value;
            item.lastUpdated = new Date().toISOString().replace("T"," ").substring(0,19);
            this.setReorders(reorders);
            // No re-render needed here — re-rendering would rebuild the input the
            // user just typed into and could steal focus mid-edit.
        }

        deleteReorderItem(id) {
            if (!confirm("Delete this reorder item?")) return;
            let reorders = this.getReorders();
            reorders = reorders.filter(r => r.id !== id);
            this.setReorders(reorders);
            this.renderReorderPage();
        }

        async approveReorderDayEnd(btn) {
            const role = this.currentUser ? this.currentUser.role : "Staff";
            if (role !== "Administrator") {
                this.showToast("Only an Administrator can approve Day End.", "error");
                return;
            }
            if (!confirm("Convert all pending/partially-ordered Reorder items into Due Orders?\nThis action cannot be undone.")) return;
            if (btn && btn.disabled) return;

            const reorders = this.getReorders();
            const pending = reorders.filter(r => r.status === "Pending" || r.status === "Partially Ordered");
            if (pending.length === 0) {
                this.showToast("No pending reorder items to convert.", "info");
                return;
            }

            await this.withButtonLoading(btn, "Approving...", async () => {
                const nowStr = new Date().toISOString().replace("T"," ").substring(0,19);
                const dues = this.getDueOrders();
                const tablets = this.getTablets();

                // Balance tablets carried over at Day End are due the NEXT day,
                // not today -- they shouldn't appear as "due now" on the main
                // Due Orders tab (that confuses the order team into thinking
                // they need to act on it immediately). They're tagged as a
                // Day End carryover and only surfaced under Reorder History.
                const tomorrow = new Date();
                tomorrow.setDate(tomorrow.getDate() + 1);
                const tomorrowStr = tomorrow.toISOString().split("T")[0];

                pending.forEach(ro => {
                    const tabObj = (ro.tabletCode && ro.tabletCode !== "N/A" ? this.getTabletByCode(ro.tabletCode) : null) || tablets.find(t => t.name === ro.tabletName);
                    dues.push({
                        id: `due-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                        workflowId: ro.workflowId || null,
                        dispensaryId: ro.dispensaryId,
                        dispensaryName: ro.dispensaryName || "",
                        orderId: ro.orderId,
                        date: nowStr.split(" ")[0],
                        dueDate: tomorrowStr,
                        isDayEndCarryover: true,
                        tabletCode: ro.tabletCode || "N/A",
                        tabletName: ro.tabletName,
                        reqQty: ro.reqQty,
                        allocatedQty: ro.availQty || 0,
                        dueQty: ro.toOrderQty,
                        status: "Pending",
                        priority: ro.priority || "Normal",
                        notes: "Converted from Reorder Management (Day End Approval) — due " + tomorrowStr,
                        lastUpdated: nowStr
                    });

                    ro.status = "Completed";
                    ro.lastUpdated = nowStr;

                    // Same Workflow ID carries through -- never regenerated.
                    if (ro.workflowId) {
                        this.updateWorkflowStatus(ro.workflowId, "Due Order");
                        this.logWorkflowEvent(ro.workflowId, "Day End Approved", "Due Orders", `Reorder for "${ro.tabletName}" converted to a Due Order at Day End.`);
                    }
                });

                const dayEndResult = await this.commitBatch([
                    { key: "ti_due_orders", data: dues, label: "Due Orders" },
                    { key: "ti_reorders", data: reorders, label: "Reorder List" }
                ], "Due Orders");
                this.logAudit("Due Orders", "Day End Approval", null,
                    { convertedCount: pending.length }, `Day End (${pending.length} item(s))`);

                this.renderReorderPage();
                this.renderDueOrdersPage();
                this.renderDashboard();

                if (dayEndResult.allCloudOk) {
                    this.showToast(`${pending.length} reorder item(s) converted to Due Orders and synced to cloud.`);
                } else {
                    this.showToast(`${pending.length} reorder item(s) converted locally. Cloud sync will retry automatically.`, "warning");
                }
            });
        }

        exportReorderCSV() {
            const reorders = this.getReorders();
            let csv = "ID,Medicine,Generic Name,Strength,Dispensary ID,Dispensary Name,Order Ref,Required Qty,Available Qty,To Order,Date,Status,Priority\n";
            reorders.forEach(r => {
                csv += `${r.id},"${r.tabletName}","${r.genericName || ""}","${r.strength || ""}","${r.dispensaryId}","${r.dispensaryName || ""}","${r.orderId}",${r.reqQty},${r.availQty},${r.toOrderQty},${r.date},"${r.status}","${r.priority || "Normal"}"\n`;
            });
            const blob = new Blob([csv], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `Reorder_Export_${new Date().toISOString().split("T")[0]}.csv`;
            a.click();
        }

        renderDashboard() {
            const tablets = this.getTablets();
            const dues = this.getDueOrders().filter(d => d.status === "Pending" || d.status === "Partially Completed");
            const history = this.getHistory();

            // Total stock count
            let totalStock = tablets.reduce((sum, item) => sum + item.stock, 0);
            document.getElementById("kpi-total-stock").textContent = totalStock.toLocaleString();

            // Total valuation
            let totalValuation = tablets.reduce((sum, item) => sum + (item.stock * item.cost), 0);
            document.getElementById("kpi-total-value").textContent = `₹${totalValuation.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

            // Low Stock alerts count
            let lowStockCount = tablets.filter(item => item.stock <= item.reorder).length;
            const kpiLow = document.getElementById("kpi-low-stock");
            kpiLow.textContent = lowStockCount;
            const lowCard = kpiLow.closest(".kpi-card");
            if (lowStockCount > 0) {
                lowCard.classList.add("amber-glow");
            } else {
                lowCard.classList.remove("amber-glow");
            }

            // ---- OCR / Upload KPI row: Admin & Senior Staff (Senior Officer) ONLY ----
            const ocrKpiGrid = document.getElementById("ocr-kpi-grid");
            const role = this.currentUser ? this.currentUser.role : "Staff";
            const canSeeOcrKpis = role === "Administrator" || role === "Senior Officer";
            if (ocrKpiGrid) {
                ocrKpiGrid.style.display = canSeeOcrKpis ? "" : "none";
                if (canSeeOcrKpis) {
                    const stats = this.getOcrStats();
                    document.getElementById("kpi-order-pages-uploaded").textContent = (stats.orderPagesUploaded || 0).toLocaleString();
                    document.getElementById("kpi-supplier-bills-uploaded").textContent = (stats.supplierBillsUploaded || 0).toLocaleString();
                    document.getElementById("kpi-ocr-success").textContent = (stats.ocrSuccess || 0).toLocaleString();
                    document.getElementById("kpi-ocr-failed").textContent = (stats.ocrFailed || 0).toLocaleString();
                    document.getElementById("kpi-pending-files").textContent = (stats.pendingFiles || 0).toLocaleString();
                    const samples = stats.ocrTimeSamplesMs || [];
                    const avgMs = samples.length > 0 ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
                    document.getElementById("kpi-avg-ocr-time").textContent = avgMs > 0 ? `${(avgMs / 1000).toFixed(1)}s` : "0s";
                }
            }

            // Render Recent Activity Logs list (latest 5)
            const activityList = document.getElementById("recent-activity-list");
            activityList.innerHTML = "";
            const sortedHistory = [...history].sort((a, b) => new Date(b.datetime) - new Date(a.datetime)).slice(0, 5);
            
            if (sortedHistory.length === 0) {
                activityList.innerHTML = `<div class="activity-text text-muted">No activity logged yet.</div>`;
            } else {
                sortedHistory.forEach(act => {
                    let typeClass = "info";
                    if (act.type === "Inventory Reserved" || act.type === "STOCK OUT") typeClass = "warning";
                    else if (act.type === "Purchase Bill Uploaded" || act.type === "STOCK IN") typeClass = "success";
                    else if (act.type.includes("Due") || act.type.includes("DUE") || act.type === "Due Order Created" || act.type === "Due Order Completed") typeClass = "danger";
                    else if (act.type === "Order Verified" || act.type === "Order Uploaded" || act.type === "Inventory Updated") typeClass = "info";

                    const timeStr = this.formatTimeAgo(act.datetime);
                    const qtyLabel = (act.type === "Order Uploaded" || act.type === "Order Verified")
                        ? `${act.qty} item${act.qty === 1 ? "" : "s"}`
                        : `${act.qty} packs`;

                    const div = document.createElement("div");
                    div.className = "activity-item";
                    div.innerHTML = `
                        <div class="activity-bullet ${typeClass}"></div>
                        <div class="activity-desc">
                            <span class="activity-text">${act.type}: <strong>${act.tabletName}</strong> (${qtyLabel})</span>
                            <span class="activity-time">${act.details} • ${timeStr}</span>
                        </div>
                    `;
                    activityList.appendChild(div);
                });
            }

            // Render Dashboard Due Table (latest 4)
            const dueTableBody = document.getElementById("dashboard-due-table-body");
            dueTableBody.innerHTML = "";
            const activeDues = dues.slice(0, 4);

            if (activeDues.length === 0) {
                dueTableBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">No active due items. Stock is healthy!</td></tr>`;
            } else {
                activeDues.forEach(due => {
                    const tabObj = (due.tabletCode && due.tabletCode !== "N/A" ? this.getTabletByCode(due.tabletCode) : null) || tablets.find(t => t.name === due.tabletName);
                    
                    let currentStock = 0;
                    if (tabObj) {
                        const tabsPerStrip = tabObj.tabsPerStrip || 10;
                        const category = tabObj.category;
                        if (category === "Tablets & Capsules" || category === "Rotacaps") {
                            currentStock = Math.round(tabObj.stock / tabsPerStrip);
                        } else {
                            currentStock = Math.round(tabObj.stock);
                        }
                    }
                    
                    const tr = document.createElement("tr");
                    tr.innerHTML = `
                        <td><strong>${due.dispensaryId || due.orderId || "N/A"}</strong></td>
                        <td>${due.date}</td>
                        <td>${this.escapeHtml(due.tabletName)}</td>
                        <td>${due.reqQty}</td>
                        <td>${currentStock}</td>
                        <td><span class="badge badge-error active font-weight-700">${due.dueQty}</span></td>
                        <td>
                            <button class="btn btn-secondary btn-sm" onclick="window.app.quickFulfillDue('${due.id}')" ${currentStock >= due.dueQty ? '' : 'disabled'}>
                                Fulfill
                            </button>
                        </td>
                    `;
                    dueTableBody.appendChild(tr);
                });
            }

            // Update due counts and status badge text
            const kpiDueTrend = document.getElementById("kpi-due-orders-trend");
            if (dues.length > 0) {
                kpiDueTrend.textContent = `${dues.length} pending items`;
                kpiDueTrend.className = "kpi-trend negative";
            } else {
                kpiDueTrend.textContent = "Fully cleared";
                kpiDueTrend.className = "kpi-trend positive";
            }

            this.updateDueBadges();
            this.checkExpiries();
            this.renderSummaryCharts();
        }

        // Dashboard Doughnut Chart
        renderSummaryCharts() {
            const tablets = this.getTablets();
            const duesCount = this.getDueOrders().filter(d => d.status === "Pending").length;
            
            let inStockCount = tablets.filter(t => t.stock > t.reorder).length;
            let lowStockCount = tablets.filter(t => t.stock <= t.reorder).length;

            const ctx = document.getElementById("inventorySummaryChart");
            if (!ctx) return;

            // Destroy previous chart if exists to avoid overlap
            if (this.charts["summary"]) {
                this.charts["summary"].destroy();
            }

            if (window.Chart) {
                this.charts["summary"] = new Chart(ctx, {
                    type: 'doughnut',
                    data: {
                        labels: ['In Stock (Healthy)', 'Low Stock Alert', 'Due Item Rows'],
                        datasets: [{
                            data: [inStockCount, lowStockCount, duesCount],
                            backgroundColor: [
                                '#10b981', // emerald
                                '#f59e0b', // amber
                                '#ef4444'  // coral
                            ],
                            borderColor: 'rgba(22, 28, 45, 0.8)',
                            borderWidth: 2,
                            hoverOffset: 6
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'bottom',
                                labels: {
                                    color: '#94a3b8',
                                    font: { family: 'Outfit', size: 12 }
                                }
                            }
                        },
                        cutout: '65%'
                    }
                });
            } else {
                // Render pure HTML visual fallback if Chart.js is not loaded
                const wrapper = ctx.parentElement;
                wrapper.innerHTML = `
                    <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:15px; color:#94a3b8;">
                        <span style="font-size:0.9rem;">Chart.js Offline. Data Summary:</span>
                        <div style="display:flex; gap:20px; font-weight:700;">
                            <span style="color:#10b981">In Stock: ${inStockCount}</span>
                            <span style="color:#f59e0b">Low Stock: ${lowStockCount}</span>
                            <span style="color:#ef4444">Dues: ${duesCount}</span>
                        </div>
                    </div>
                `;
            }
        }

        // --- MASTER DATA PANEL ---
        renderTabletList(searchQuery = "") {
            this.updateManualBillDatalist();
            const tableBody = document.getElementById("tablet-list-table-body");
            if (!tableBody) return;

            tableBody.innerHTML = "";
            const tablets = this.getTablets();
            console.log(`[Master Data Chain] Database: ${tablets.length}`);
            const q = searchQuery.toLowerCase().trim();
            const activeCategory = this._activeCategoryFilter || "ALL";

            const filteredTablets = tablets.filter(t => {
                // Category Filter
                if (activeCategory !== "ALL") {
                    const tCategory = t.category || "Tablets & Capsules";
                    if (tCategory !== activeCategory) {
                        return false;
                    }
                }

                if (!q) return true;
                
                const terms = q.split(/\s+/).filter(Boolean);
                if (terms.length === 0) return true;
                
                return terms.every(term => {
                    if (t.code.toLowerCase().includes(term) ||
                        t.brand.toLowerCase().includes(term) ||
                        t.name.toLowerCase().includes(term) ||
                        (t.drugName || "").toLowerCase().includes(term)) {
                        return true;
                    }
                    
                    const batches = t.batches || [];
                    if (batches.some(b => b.batchNumber.toLowerCase().includes(term))) {
                        return true;
                    }
                    
                    if (term.length >= 3 && !/^\d+$/.test(term)) {
                        const nameWords = t.name.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
                        for (const w of nameWords) {
                            if (w.length >= 3 && this.calculateLevenshteinDistance(term, w) >= 70) {
                                return true;
                            }
                        }
                        
                        if (t.drugName) {
                            const drugWords = t.drugName.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
                            for (const w of drugWords) {
                                if (w.length >= 3 && this.calculateLevenshteinDistance(term, w) >= 70) {
                                    return true;
                                }
                            }
                        }
                    }
                    
                    return false;
                });
            });

            console.log(`[Master Data Chain] After Filter (category=${activeCategory}, search="${q}"): ${filteredTablets.length}`);

            if (filteredTablets.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="11" class="text-center text-muted">No tablets found matching search.</td></tr>`;
                return;
            }

            // Master Data must always be sorted alphabetically by Brand
            // Name (never by dosage-form suffix like TAB/CAP/GEL). Prefer
            // the dedicated `brand` field; fall back to `name` only if a
            // record has no brand set.
            filteredTablets.sort((a, b) => {
                const brandA = (a.brand || a.name || "").trim();
                const brandB = (b.brand || b.name || "").trim();
                const cmp = brandA.localeCompare(brandB, undefined, { sensitivity: "base" });
                if (cmp !== 0) return cmp;
                return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base", numeric: true });
            });

            let renderedCount = 0;
            filteredTablets.forEach(tab => {
              // BUGFIX (Master Data "All Products" bug): this loop used to have
              // no error isolation. A single record with a malformed numeric
              // field (e.g. missing/undefined MRP, hit via `tab.mrp.toFixed(2)`
              // below) threw an uncaught exception mid-iteration. Since rows are
              // appended in the middle of a forEach, that exception silently
              // aborted the ENTIRE loop -- every product sorted after the bad
              // record never got rendered, even though it exists in Master
              // Data. Wrapping each row in try/catch means one bad record is
              // skipped (and logged) instead of taking the rest of the list
              // down with it.
              try {
                const isLow = tab.stock <= tab.reorder;
                const stockCellClass = isLow ? "text-danger font-weight-700" : "text-success";
                
                const cat = tab.category;
                const isTabletForm = (cat === "Tablets & Capsules" || cat === "Rotacaps");
                const tabsPerStrip = tab.tabsPerStrip || 10;
                // Number of Tablets is the single source of truth (tab.stock is always
                // stored in tablets, never strips, per the app's core inventory rule).
                // Number of Strips is derived from it, never hardcoded:
                //   Number of Strips = Number of Tablets / Packing Size
                let stripsDisplay = "";
                let tabletsDisplay = "";
                if (isTabletForm) {
                    tabletsDisplay = Math.round(tab.stock);
                    stripsDisplay = Math.round(tab.stock / tabsPerStrip);
                } else {
                    // Non-tablet products (syrups, creams, injections, etc.) have no
                    // strip/tablet concept — just show the item/unit count once.
                    tabletsDisplay = Math.round(tab.stock);
                    stripsDisplay = "—";
                }
                const stockDisplay = tabletsDisplay;

                const expiryVal = (tab.batches && tab.batches[0]) ? tab.batches[0].expiryDate : "N/A";

                const tr = document.createElement("tr");
                tr.className = "master-row";
                tr.innerHTML = `
                    <td class="toggle-expand" data-label="" style="cursor:pointer; text-align:center; color:var(--color-primary); font-weight:700; font-size:1.1rem; user-select:none;">▸</td>
                    <td data-label="Medicine"><strong>${tab.name}</strong>${this.isTabletNew(tab) ? ' <span class="status-badge badge-warning" style="margin-left: 8px; padding: 2px 6px; font-size: 0.65rem;">New</span>' : ''}</td>
                    <td data-label="Drug Name">${tab.drugName || "N/A"}</td>
                    <td data-label="Brand">${tab.brand}</td>
                    <td data-label="Pack">${tab.pack}</td>
                    <td data-label="Strips">
                        <span style="font-weight: 600; font-size: 0.9rem; color: var(--text-secondary);">${stripsDisplay}</span>
                    </td>
                    <td data-label="Stock">
                        <span class="${stockCellClass}" style="font-weight: 700; font-size: 0.95rem;">${stockDisplay}</span>
                    </td>
                    <td data-label="Expiry"><span style="font-family: monospace;">${expiryVal}</span></td>
                    <td data-label="MRP">₹${(Number(tab.mrp) || 0).toFixed(2)}</td>
                    <td data-label="Reorder Level">${tab.reorder}</td>
                    <td data-label="" class="mobile-card-actions">
                        <div style="display:flex; gap:6px;">
                            <button class="btn-icon-only" onclick="window.app.openEditTabletModal('${tab.code}')" title="Edit details">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                            </button>
                            <button class="btn-icon-only danger" onclick="window.app.deleteTablet('${tab.code}', this)" title="Delete Tablet">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                            </button>
                        </div>
                    </td>
                `;
                tableBody.appendChild(tr);

                // Add collapsible details row
                const detailTr = document.createElement("tr");
                detailTr.className = "detail-row hidden";
                
                let batchesHTML = "";
                const batches = tab.batches || [];
                if (batches.length === 0) {
                    batchesHTML = `<div class="text-muted p-2" style="font-size:0.8rem; font-style:italic;">No active batches recorded.</div>`;
                } else {
                    batchesHTML = `
                        <table class="data-table small" style="margin: 5px 0; background: rgba(255, 255, 255, 0.02); width: 100%; border-collapse: collapse;">
                            <thead>
                                <tr style="background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid var(--border-color);">
                                    <th style="font-size: 0.75rem; padding: 6px; text-align: left; color: var(--text-secondary);">Batch Number</th>
                                    <th style="font-size: 0.75rem; padding: 6px; text-align: left; color: var(--text-secondary);">Expiry Date</th>
                                    <th style="font-size: 0.75rem; padding: 6px; text-align: left; color: var(--text-secondary);">Strips / Tablets</th>
                                    <th style="font-size: 0.75rem; padding: 6px; text-align: left; color: var(--text-secondary);">Cost Price (₹)</th>
                                    <th style="font-size: 0.75rem; padding: 6px; text-align: left; color: var(--text-secondary);">MRP (₹)</th>
                                    <th style="font-size: 0.75rem; padding: 6px; text-align: left; color: var(--text-secondary);">Status / Expiry days</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${batches.map(b => {
                                    const expDate = this.parseExpiryDate(b.expiryDate);
                                    const today = new Date();
                                    const diffTime = expDate - today;
                                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                                    
                                    let statusLabel = `${diffDays} days left`;
                                    let color = "#10b981"; // emerald
                                    if (diffDays < 0) {
                                        statusLabel = "Expired";
                                        color = "#f43f5e"; // coral
                                    } else if (diffDays < 90) {
                                        statusLabel = `Critical (${diffDays}d)`;
                                        color = "#f59e0b"; // amber
                                    }

                                    const tabsPerStrip = tab.tabsPerStrip || 10;
                                    let qtyPacks = b.quantity;
                                    if (cat === "Tablets & Capsules" || cat === "Rotacaps") {
                                        qtyPacks = Math.round(b.quantity / tabsPerStrip);
                                    } else {
                                        qtyPacks = Math.round(b.quantity);
                                    }

                                    return `
                                        <tr style="background: none; border-bottom: 1px solid rgba(255, 255, 255, 0.03);">
                                            <td style="font-family: monospace; font-size: 0.75rem; padding: 6px;">${b.batchNumber}</td>
                                            <td style="font-family: monospace; font-size: 0.75rem; padding: 6px;">${b.expiryDate}</td>
                                            <td style="font-size: 0.75rem; padding: 6px; font-weight: 600;">${qtyPacks}</td>
                                            <td style="font-size: 0.75rem; padding: 6px;">₹${(b.cost || 0).toFixed(2)}</td>
                                            <td style="font-size: 0.75rem; padding: 6px;">₹${(b.mrp || 0).toFixed(2)}</td>
                                            <td style="font-size: 0.75rem; padding: 6px; color: ${color}; font-weight: 600;">${statusLabel}</td>
                                        </tr>
                                    `;
                                }).join("")}
                            </tbody>
                        </table>
                    `;
                }

                detailTr.innerHTML = `
                    <td colspan="10" style="background: rgba(0, 0, 0, 0.25); padding: 12px 20px; border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">Batch Breakdown</span>
                                <span style="font-size: 0.72rem; color: var(--text-muted);">
                                     <strong>Pack Breakdown:</strong> ${this.formatPackConversion(tab.stock, tab.pack, tab.name)} (based on ${this.parsePackSize(tab.pack, tab.name).tabsPerStrip} tabs/strip, ${this.parsePackSize(tab.pack, tab.name).stripsPerBox} strips/box)
                                </span>
                            </div>
                            <span style="font-size: 0.8rem; font-weight: 700; color: var(--color-primary-dark); background: rgba(79, 172, 254, 0.1); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(79, 172, 254, 0.2);">GST: ${tab.gst || "5%"}</span>
                        </div>
                        ${batchesHTML}
                    </td>
                `;
                tableBody.appendChild(detailTr);

                // Bind toggle event to first column cell click
                const toggleCell = tr.querySelector(".toggle-expand");
                toggleCell.addEventListener("click", () => {
                    const isHidden = detailTr.classList.contains("hidden");
                    if (isHidden) {
                        detailTr.classList.remove("hidden");
                        toggleCell.textContent = "▼";
                        toggleCell.style.color = "var(--color-primary-dark)";
                        tr.style.background = "rgba(255, 255, 255, 0.03)";
                    } else {
                        detailTr.classList.add("hidden");
                        toggleCell.textContent = "▸";
                        toggleCell.style.color = "var(--color-primary)";
                        tr.style.background = "";
                    }
                });
                renderedCount++;
              } catch (rowErr) {
                // Never let one malformed record take down the whole list --
                // log it so it's discoverable/fixable, but keep rendering the
                // rest of Master Data.
                console.error(`renderTabletList: failed to render row for product "${tab && tab.name}" (code: ${tab && tab.code}):`, rowErr);
              }
            });

            console.log(`[Master Data Chain] Rendered: ${renderedCount}` + (renderedCount !== filteredTablets.length ? ` (⚠ dropped ${filteredTablets.length - renderedCount} row(s) — see error above)` : ""));
        }

        openAddTabletModal() {
            document.getElementById("modal-title").textContent = "Add New Tablet Model";
            document.getElementById("tablet-form").reset();
            document.getElementById("edit-original-code").value = "";
            document.getElementById("tab-code").readOnly = false;
            
            document.getElementById("tab-batch").value = "";
            document.getElementById("tab-expiry").value = "";
            document.getElementById("tab-gst").value = "5%";
            if (document.getElementById("tab-category")) {
                document.getElementById("tab-category").value = "Tablets & Capsules";
            }
            if (document.getElementById("tab-purchase-unit")) {
                document.getElementById("tab-purchase-unit").value = "Strip";
            }
            if (document.getElementById("tab-strips-per-box")) {
                document.getElementById("tab-strips-per-box").value = "";
            }
            if (document.getElementById("tab-units-per-box")) {
                document.getElementById("tab-units-per-box").value = "";
            }

            const modal = document.getElementById("tablet-modal");
            modal.classList.remove("hidden");
            modal.classList.add("active");
            this.updateStockFieldLabel();
        }

        openEditTabletModal(code) {
            const tablet = this.getTablets().find(t => t.code === code);
            if (!tablet) return;

            // Snapshot the version this session is editing from, so we can
            // detect if another user saved a change to this same medicine
            // in between opening this form and clicking Save.
            this._editTabletVersionSnapshot = tablet._v || 0;

            document.getElementById("modal-title").textContent = "Edit Tablet Details";
            document.getElementById("edit-original-code").value = tablet.code;
            
            document.getElementById("tab-code").value = tablet.code;
            document.getElementById("tab-code").readOnly = true; // Code code acts as key
            document.getElementById("tab-name").value = tablet.name;
            document.getElementById("tab-brand").value = tablet.brand;
            if (document.getElementById("tab-drug")) {
                document.getElementById("tab-drug").value = tablet.drugName || "";
            }
            document.getElementById("tab-pack").value = tablet.pack;
            document.getElementById("tab-reorder").value = tablet.reorder;
            if (document.getElementById("tab-strip-policy")) {
                // Legacy/pre-migration records have no stripPolicy set -- default
                // to the same safe "ask every time" behavior as the DB column.
                document.getElementById("tab-strip-policy").value = tablet.stripPolicy || "always_cut";
            }
            const editCategory = tablet.category || this.detectCategoryFromName(tablet.name, tablet.pack);
            const editIsTabletForm = (editCategory === "Tablets & Capsules" || editCategory === "Rotacaps");
            if (editIsTabletForm) {
                const editTabsPerStrip = tablet.tabsPerStrip || this.parsePackSize(tablet.pack, tablet.name).tabsPerStrip || 10;
                document.getElementById("tab-stock").value = Math.round(tablet.stock / editTabsPerStrip);
            } else {
                document.getElementById("tab-stock").value = tablet.stock;
            }
            document.getElementById("tab-cost").value = tablet.cost;
            document.getElementById("tab-mrp").value = tablet.mrp;
            
            if (document.getElementById("tab-category")) {
                document.getElementById("tab-category").value = tablet.category || this.detectCategoryFromName(tablet.name, tablet.pack);
            }
            if (document.getElementById("tab-purchase-unit")) {
                document.getElementById("tab-purchase-unit").value = tablet.purchaseUnit || "Strip";
            }
            if (document.getElementById("tab-strips-per-box")) {
                document.getElementById("tab-strips-per-box").value = tablet.stripsPerBox || "";
            }
            if (document.getElementById("tab-units-per-box")) {
                document.getElementById("tab-units-per-box").value = tablet.unitsPerBox || "";
            }

            const defaultBatch = (tablet.batches && tablet.batches[0]) ? tablet.batches[0].batchNumber : "INI-BATCH";
            const defaultExpiry = (tablet.batches && tablet.batches[0]) ? tablet.batches[0].expiryDate : "12/28";
            const defaultGst = tablet.gst || "5%";
            
            document.getElementById("tab-batch").value = defaultBatch;
            document.getElementById("tab-expiry").value = defaultExpiry;
            document.getElementById("tab-gst").value = defaultGst;

            const modal = document.getElementById("tablet-modal");
            modal.classList.remove("hidden");
            modal.classList.add("active");
            this.updateStockFieldLabel();
        }

        closeTabletModal() {
            const modal = document.getElementById("tablet-modal");
            modal.classList.remove("active");
        }

        // Keeps the Master Data stock field honest: for tablet/capsule forms it
        // is always "Number of Strips" with Number of Tablets computed live as
        // Packing Size x Strips (never a manually-typed tablet total). For
        // non-tablet forms (syrups, creams, injections, etc.) it stays a plain
        // item/unit count, per spec.
        updateStockFieldLabel() {
            const categoryEl = document.getElementById("tab-category");
            const labelEl = document.getElementById("tab-stock-label");
            const hintEl = document.getElementById("tab-stock-hint");
            const stockEl = document.getElementById("tab-stock");
            const packEl = document.getElementById("tab-pack");
            if (!categoryEl || !labelEl || !hintEl || !stockEl) return;

            const category = categoryEl.value;
            const isTabletForm = (category === "Tablets & Capsules" || category === "Rotacaps");

            if (isTabletForm) {
                labelEl.textContent = "Number of Strips";
                const tabsPerStrip = this.parsePackSize(packEl ? packEl.value : "", "").tabsPerStrip || 10;
                const strips = parseInt(stockEl.value) || 0;
                const tablets = strips * tabsPerStrip;
                hintEl.textContent = `= ${tablets} Tablets (${strips} strips x ${tabsPerStrip} tabs/strip). Tablet total is always calculated, not manually entered.`;
            } else {
                labelEl.textContent = "Current Stock (units)";
                hintEl.textContent = "";
            }
        }

        async saveTabletForm(btn) {
            btn = btn || document.getElementById("btn-save-tablet");
            if (btn && btn.disabled) return; // already saving — ignore repeat clicks
            const _origBtnHTML = btn ? btn.innerHTML : null;
            if (btn) { btn.disabled = true; btn.innerHTML = "Saving..."; }
            try {
                return await this._saveTabletFormInner();
            } finally {
                if (btn) { btn.disabled = false; btn.innerHTML = _origBtnHTML; }
            }
        }

        async _saveTabletFormInner() {
            const originalCode = document.getElementById("edit-original-code").value;
            const code = document.getElementById("tab-code").value.trim().toUpperCase();
            const name = document.getElementById("tab-name").value.trim();
            const brand = document.getElementById("tab-brand").value.trim();
            const drugName = document.getElementById("tab-drug") ? document.getElementById("tab-drug").value.trim() : "";
            const pack = document.getElementById("tab-pack").value.trim();
            const reorder = parseInt(document.getElementById("tab-reorder").value);
            const stripPolicyEl = document.getElementById("tab-strip-policy");
            const stripPolicy = stripPolicyEl ? stripPolicyEl.value : "always_cut";
            const stockFieldValue = parseInt(document.getElementById("tab-stock").value) || 0;
            const cost = parseFloat(document.getElementById("tab-cost").value);
            const mrp = parseFloat(document.getElementById("tab-mrp").value);
            
            const categoryEl = document.getElementById("tab-category");
            const category = categoryEl ? categoryEl.value : this.detectCategoryFromName(name, pack);

            // Number of Tablets is NEVER a manually-typed value for tablet/capsule
            // forms — it is always calculated as Packing Size x Number of Strips,
            // using the pack-size the user just entered (never hardcoded).
            const isTabletForm = (category === "Tablets & Capsules" || category === "Rotacaps");
            const tabsPerStripForSave = this.parsePackSize(pack, name).tabsPerStrip || 10;
            const stock = isTabletForm ? (stockFieldValue * tabsPerStripForSave) : stockFieldValue;

            const purchaseUnitVal = document.getElementById("tab-purchase-unit") ? document.getElementById("tab-purchase-unit").value : "Strip";
            const stripsPerBoxVal = document.getElementById("tab-strips-per-box") && document.getElementById("tab-strips-per-box").value ? parseInt(document.getElementById("tab-strips-per-box").value) : null;
            const unitsPerBoxVal = document.getElementById("tab-units-per-box") && document.getElementById("tab-units-per-box").value ? parseInt(document.getElementById("tab-units-per-box").value) : null;

            const batchNum = document.getElementById("tab-batch").value.trim().toUpperCase() || "B-901";
            const expiryStr = document.getElementById("tab-expiry").value.trim() || "12/28";
            let gstStr = document.getElementById("tab-gst").value.trim() || "5%";
            if (gstStr && !gstStr.endsWith("%")) gstStr += "%";

            let tablets = this.getTablets();
            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

            // Duplicate check before save -- reuses the same Medicine Identity
            // Engine cascade (resolveMedicine: Product Code -> Brand+Strength
            // +Form -> Generic -> Fuzzy >95%) that Bill/Order Processing OCR
            // already relies on, instead of a raw exact-string name compare.
            // This is the single duplicate-prevention algorithm for the whole
            // app -- manual entry (this form) now follows the identical rules
            // as OCR, so "ROSEDAY 10" / "Roseday-10" / "ROSEDAY 10 MG" /
            // "USV L. ROSEDAY 10MG" are recognized as the same medicine here
            // too, while different strengths (5/10/20/40 MG) never merge.
            //
            // NOTE: resolveMedicine()'s Brand/Strength/Generic cascade reads
            // Master Data via getIndexes() (live storage), not the `tablets`
            // array passed in here -- only its fuzzy-candidate fallback
            // actually honors a filtered subset. So when editing an existing
            // record (originalCode set), we can't rely on filtering the input
            // array to exclude "itself" -- we explicitly exclude a self-code
            // match after resolution instead, below.
            const _resolution = this.resolveMedicine(name, pack, tablets);
            const _resolvedIsSelf = originalCode && _resolution.tablet && _resolution.tablet.code === originalCode;

            if (_resolution.status === "exact" && _resolution.tablet && !_resolvedIsSelf) {
                const existing = _resolution.tablet;
                this.triggerNotification(
                    "Inventory", "Duplicate medicine detected",
                    "Duplicate Medicine Name\nName: " + name + "\nMatches existing Master Data record: " + existing.name + " (" + existing.code + ")",
                    "Warning", { medicineName: name }
                );
                const useExisting = confirm(
                    `A matching medicine already exists in Master Data:\n\n${existing.name} (${existing.code})\n\n` +
                    `Click OK to open that record for editing instead of creating a duplicate, or Cancel to go back and change the details.`
                );
                if (useExisting) {
                    this.closeTabletModal();
                    this.openEditTabletModal(existing.code);
                } else {
                    this.showToast(`Medicine "${name}" already exists in Master Data as ${existing.name} (${existing.code}).`, "error");
                }
                return;
            }

            const _dupCandidates = (_resolution.candidates || []).filter(c => c.code !== originalCode);
            if (!originalCode && _dupCandidates.length > 0) {
                // No exact match, but the cascade found similar medicine(s)
                // (e.g. same brand at a different strength, or a fuzzy match
                // at/below the 95% auto-accept threshold) -- never silently
                // create a new record; require explicit confirmation first.
                const candidateList = _dupCandidates.slice(0, 5).map(c => `• ${c.name} (${c.code})`).join("\n");
                const proceed = confirm(
                    `No exact match found, but similar medicine(s) already exist in Master Data:\n\n${candidateList}\n\n` +
                    `Click OK to create "${name}" as a new medicine anyway, or Cancel to review the details first.`
                );
                if (!proceed) return;
            }

            if (originalCode) {
                // EDIT MODE
                const index = tablets.findIndex(t => t.code === originalCode);
                if (index !== -1) {
                    // Realtime conflict check: if another user's edit landed
                    // (via realtime sync) since this form was opened, the
                    // version counter will have moved. Never silently
                    // overwrite their change.
                    if (!this._forceOverwriteTabletEdit && (tablets[index]._v || 0) !== this._editTabletVersionSnapshot) {
                        this.showEditConflictModal(originalCode);
                        return;
                    }
                    this._forceOverwriteTabletEdit = false;

                    const oldSnapshot = { category: tablets[index].category, stock: tablets[index].stock, mrp: tablets[index].mrp, cost: tablets[index].cost, reorder: tablets[index].reorder };
                    const originalStock = tablets[index].stock;
                    let existingBatches = tablets[index].batches || [];
                    
                    if (existingBatches.length === 0) {
                        existingBatches = [{ batchNumber: batchNum, expiryDate: expiryStr, quantity: stock, mrp: mrp, cost: cost }];
                    } else {
                        const diff = stock - originalStock;
                        existingBatches[0].quantity = Math.max(0, existingBatches[0].quantity + diff);
                        existingBatches[0].batchNumber = batchNum;
                        existingBatches[0].expiryDate = expiryStr;
                        existingBatches[0].mrp = mrp;
                        existingBatches[0].cost = cost;
                    }
                    
                    const packSize = this.parsePackSize(pack, name);
                    tablets[index] = {
                        code, name, brand, pack, category,
                        stock: existingBatches.reduce((sum, b) => sum + b.quantity, 0),
                        reorder, cost, mrp, gst: gstStr,
                        stripPolicy,
                        batches: existingBatches,
                        drugName,
                        importedOn: tablets[index].importedOn || "",
                        tabsPerStrip: packSize.tabsPerStrip,
                        purchaseUnit: purchaseUnitVal,
                        stripsPerBox: stripsPerBoxVal || packSize.stripsPerBox,
                        unitsPerBox: unitsPerBoxVal || packSize.totalTablets,
                        totalTablets: packSize.totalTablets,
                        _v: (tablets[index]._v || 0) + 1
                    };
                    const syncResult = await this.saveWithCloudConfirmation("ti_tablets", tablets, "Inventory", "Master Data / Tablets");
                    this.logAudit("Inventory", "Edit Medicine", oldSnapshot,
                        { category, stock: tablets[index].stock, mrp, cost, reorder }, name);
                    
                    // Log adjustment difference if stock changed
                    if (stock !== originalStock) {
                        const tabsPerStrip = packSize.tabsPerStrip || 10;
                        const originalStrips = (category === "Tablets & Capsules" || category === "Rotacaps") 
                            ? Math.round(originalStock / tabsPerStrip) 
                            : Math.round(originalStock);
                        const currentStrips = (category === "Tablets & Capsules" || category === "Rotacaps") 
                            ? Math.round(stock / tabsPerStrip) 
                            : Math.round(stock);
                        const diffStrips = Math.abs(currentStrips - originalStrips);
                        
                        this.logHistory(
                            "Inventory Updated",
                            name,
                            batchNum,
                            diffStrips,
                            `Edited stock quantity manually inside form (From ${originalStrips} to ${currentStrips} packs)`
                        );
                    }
                    if (syncResult.cloudOk) {
                        this.showToast("Tablet details updated and saved to cloud database.");
                    } else if (syncResult.reason === "not_configured") {
                        this.showToast("Tablet details updated successfully.");
                    } else {
                        this.showToast("Saved locally — cloud sync will retry automatically. Other devices won't see this change until sync succeeds.", "warning");
                    }
                }
            } else {
                // ADD NEW MODE
                if (tablets.some(t => t.code === code)) {
                    this.showToast(`Tablet with code "${code}" already exists!`, "error");
                    return;
                }

                const packSize = this.parsePackSize(pack, name);
                const newBatches = [{ batchNumber: batchNum, expiryDate: expiryStr, quantity: stock, mrp: mrp, cost: cost }];
                tablets.push({
                    code, name, brand, pack, category,
                    stock: stock,
                    reorder, cost, mrp, gst: gstStr,
                    stripPolicy,
                    batches: newBatches,
                    drugName,
                    importedOn: nowStr,
                    tabsPerStrip: packSize.tabsPerStrip,
                    purchaseUnit: purchaseUnitVal,
                    stripsPerBox: stripsPerBoxVal || packSize.stripsPerBox,
                    unitsPerBox: unitsPerBoxVal || packSize.totalTablets,
                    totalTablets: packSize.totalTablets
                });
                const syncResult = await this.saveWithCloudConfirmation("ti_tablets", tablets, "Inventory", "Master Data / Tablets");
                
                if (stock > 0) {
                    const tabsPerStrip = packSize.tabsPerStrip || 10;
                    const stockPacks = (category === "Tablets & Capsules" || category === "Rotacaps") 
                        ? Math.round(stock / tabsPerStrip) 
                        : Math.round(stock);
                    this.logHistory("Inventory Updated", name, batchNum, stockPacks, `Added new product to system with initial stock of ${stockPacks} packs.`);
                }
                
                if (syncResult.cloudOk) {
                    this.showToast(`Tablet "${name}" added to master database and saved to cloud.`);
                } else if (syncResult.reason === "not_configured") {
                    this.showToast(`Tablet "${name}" added to master database.`);
                } else {
                    this.showToast(`Tablet "${name}" saved locally — cloud sync will retry automatically.`, "warning");
                }
            }

            this.closeTabletModal();
            this.renderTabletList();
            this.renderDashboard();

            // If this Add/Edit was triggered from a "Medicine Not Found" resolution
            // during OCR verification or bill import, resolve that pending item now
            // and continue the matching queue automatically.
            if (this._notFoundResolveContext) {
                const ctx = this._notFoundResolveContext;
                this._notFoundResolveContext = null;
                const freshTablets = this.getTablets();
                const newTab = freshTablets.find(t => t.code === code) || freshTablets[freshTablets.length - 1];

                if (newTab) {
                    if (ctx.type === "bill" && ctx.rowElement) {
                        const codeSelect = ctx.rowElement.querySelector(".edit-item-code");
                        if (codeSelect) {
                            let opt = codeSelect.querySelector(`option[value="${newTab.code}"]`);
                            if (!opt) {
                                opt = document.createElement("option");
                                opt.value = newTab.code;
                                opt.textContent = `${newTab.name} (${newTab.code})`;
                                codeSelect.appendChild(opt);
                            }
                            codeSelect.value = newTab.code;
                        }

                        // Master Data is the single source of truth: this
                        // medicine was flagged "New Medicine" in Reorder
                        // (temporary ID, no Master Data record) and is now
                        // actually being purchased via Supplier Bill
                        // Processing -> convert it to a permanent record and
                        // auto-update every linked Reorder entry to reference
                        // the new Master Data Code, per the required flow.
                        const ctxNameLower = (ctx.name || "").toLowerCase().trim();
                        const newTabNameLower = newTab.name.toLowerCase().trim();
                        const reordersToLink = this.getReorders();
                        let reorderLinked = false;
                        const linkNowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
                        reordersToLink.forEach(r => {
                            if (!r.isNewMedicine) return;
                            const rNameLower = (r.tabletName || "").toLowerCase().trim();
                            if (rNameLower === ctxNameLower || rNameLower === newTabNameLower) {
                                r.tabletCode = newTab.code;
                                r.tempId = null;
                                r.isNewMedicine = false;
                                r.notes = `Auto-linked to Master Data record ${newTab.code} after Supplier Bill purchase.`;
                                r.lastUpdated = linkNowStr;
                                reorderLinked = true;
                            }
                        });
                        if (reorderLinked) {
                            this.setReorders(reordersToLink);
                            this.showToast(`Linked existing Reorder entries to new Master Data code ${newTab.code}.`, "info");
                        }
                    } else if (ctx.type === "order" && this.orderVerificationContext) {
                        this.orderVerificationContext.items[ctx.itemIndex].resolvedTablet = newTab;
                    }

                    this.ocrMatchQueueIndex++;
                    if (this.ocrMatchQueueIndex < this.ocrMatchQueue.length) {
                        this.showOcrMatchModal();
                    } else {
                        this.closeOcrMatchModal();
                        if (ctx.type === "bill") {
                            this.importExtractedBillResolved();
                        } else if (ctx.type === "order" && this.orderVerificationContext) {
                            const c2 = this.orderVerificationContext;
                            this.verifyStockItemsResolved(c2.refId, c2.date, c2.dispensaryId, c2.dispensaryName, c2.items);
                        }
                    }
                }
            }
        }

        // --- REALTIME EDIT CONFLICT HANDLING ---
        showEditConflictModal(code) {
            this._conflictTabletCode = code;
            const msgEl = document.getElementById("edit-conflict-message");
            const tab = this.getTablets().find(t => t.code === code);
            if (msgEl) {
                msgEl.innerHTML = `<strong style="color:#ff6b6b;">Conflict Detected</strong><br>"${tab ? tab.name : code}" was updated by another user while you were editing it. Your changes were NOT saved to avoid overwriting theirs.`;
            }
            const overwriteBtn = document.getElementById("btn-conflict-overwrite");
            if (overwriteBtn) {
                overwriteBtn.style.display = (this.currentUser && this.currentUser.role === "Administrator") ? "" : "none";
            }
            const modal = document.getElementById("edit-conflict-modal");
            if (modal) modal.classList.add("active");
        }

        closeEditConflictModal() {
            const modal = document.getElementById("edit-conflict-modal");
            if (modal) modal.classList.remove("active");
        }

        // "Reload Latest" — discard this session's edits, close the form,
        // and re-open it pre-filled with the other user's latest values.
        conflictReloadLatest() {
            const code = this._conflictTabletCode;
            this.closeEditConflictModal();
            this.closeTabletModal();
            this.renderTabletList();
            if (code) this.openEditTabletModal(code);
            this.showToast("Reloaded the latest version of this medicine.", "info");
        }

        // "Overwrite" (Administrator only) — re-submit this session's edit,
        // bypassing the version check exactly once.
        conflictOverwrite() {
            if (!this.currentUser || this.currentUser.role !== "Administrator") {
                this.showToast("Only an Administrator can overwrite another user's change.", "error");
                return;
            }
            this.closeEditConflictModal();
            this._forceOverwriteTabletEdit = true;
            this.saveTabletForm();
        }

        async deleteTablet(code, btn) {
            if (!confirm(`Are you sure you want to delete tablet with code "${code}"?`)) return;

            let tablets = this.getTablets();
            const tablet = tablets.find(t => t.code === code);
            if (!tablet) return;

            await this.withButtonLoading(btn, "Deleting...", async () => {
                tablets = tablets.filter(t => t.code !== code);
                const syncResult = await this.saveWithCloudConfirmation("ti_tablets", tablets, "Inventory", "Master Data / Tablets");

                const tabsPerStrip = tablet.tabsPerStrip || 10;
                const category = tablet.category;
                const stockPacks = (category === "Tablets & Capsules" || category === "Rotacaps")
                    ? Math.round(tablet.stock / tabsPerStrip)
                    : Math.round(tablet.stock);
                this.logHistory("Inventory Updated", tablet.name, "DELETED", stockPacks, `Deleted tablet product code "${code}" from system.`);
                this.logAudit("Inventory", "Delete Medicine", { code: tablet.code, name: tablet.name, stock: tablet.stock }, null, tablet.name);

                this.renderTabletList();
                this.renderDashboard();

                if (syncResult.cloudOk) {
                    this.showToast(`Deleted ${tablet.name} from inventory and synced to cloud.`);
                } else if (syncResult.reason === "not_configured") {
                    this.showToast(`Deleted ${tablet.name} from inventory.`);
                } else {
                    this.showToast(`Deleted ${tablet.name} locally — cloud sync will retry automatically.`, "warning");
                }
            });
        }


        // --- BILL PROCESSING OCR SCANNERS ---
        copyCanvasImageToClipboard(silent = false) {
            const canvas = document.getElementById("scanner-canvas");
            if (!canvas) {
                if (!silent) this.showToast("No active image found to copy.", "error");
                return;
            }
            if (typeof ClipboardItem === "undefined" || !navigator.clipboard || !navigator.clipboard.write) {
                if (!silent) this.showToast("Browser does not support direct image copying. Please right-click or long-press the canvas to copy the image.", "warning");
                return;
            }
            try {
                canvas.toBlob(blob => {
                    try {
                        const item = new ClipboardItem({ [blob.type]: blob });
                        navigator.clipboard.write([item]).then(() => {
                            if (!silent) this.showToast("Image copied to clipboard! Paste it directly into Google Lens.");
                        }).catch(err => {
                            console.error("Clipboard write failed:", err);
                            if (!silent) this.showToast("Failed to copy image automatically. Please drag or right-click to copy.", "warning");
                        });
                    } catch (innerErr) {
                        console.error("ClipboardItem creation failed:", innerErr);
                        if (!silent) this.showToast("Failed to copy image automatically. Please drag or right-click to copy.", "warning");
                    }
                });
            } catch (err) {
                console.error("toBlob failed:", err);
                if (!silent) this.showToast("Failed to copy image automatically. Try dragging it instead.", "warning");
            }
        }

        triggerOCRScan(fileName, fileObj = null) {
            const nameLower = (fileName || "").toLowerCase();
            // Gated behind an explicit opt-in flag rather than filename
            // sniffing -- see the matching fix in the bill-scan handler.
            // "kastoori" was the highest-risk match here specifically: it's
            // the pharmacy's own name, so any real invoice photo saved with
            // a filename like "Kastoori_Medicals_Invoice.jpg" would have
            // matched by coincidence.
            const isMockTemplate = localStorage.getItem("ti_enable_demo_ocr_templates") === "1" && (
                                   nameLower.includes("26kk404") || nameLower.includes("26kk405") || 
                                   nameLower.includes("26kk398") || nameLower.includes("26kk401") ||
                                   nameLower.includes("1781937") || nameLower.includes("1781945") ||
                                   nameLower.includes("1782029421019") || nameLower.includes("1782029421030") ||
                                   nameLower.includes("1782029421043") || nameLower.includes("1782029421050") ||
                                   nameLower.includes("1782029421230") || nameLower.includes("kastoori"));

            if (!isMockTemplate) {
                const apiKey = localStorage.getItem("ti_ai_key");
                if (!apiKey) {
                    this.showToast("Gemini API key is missing. OCR requests blocked.", "error");
                    this.initGeminiConnection();
                    return;
                }
                if (!apiKey.startsWith("AIza")) {
                    this.showToast("Invalid Gemini API Key format. OCR requests blocked.", "error");
                    this.initGeminiConnection();
                    return;
                }
            }

            if (fileObj) {
                const isImg = (fileObj.type && fileObj.type.startsWith('image/')) || 
                              /\.(png|jpe?g|gif|webp|bmp)$/i.test(fileName || fileObj.name || "");
                const isPdf = fileObj.type === "application/pdf" || /\bpdf\b/i.test(fileName || fileObj.name || "");
                if (!isImg && !isPdf) {
                    this.showToast("Invalid file format. Please upload a valid invoice image (PNG, JPEG, WebP) or PDF document.", "error");
                    this.resetBillOCR();
                    return;
                }
            }

            const scannerBox = document.getElementById("scanner-visualizer-box");
            const emptyState = document.getElementById("scanner-empty-state");
            const canvas = document.getElementById("scanner-canvas");
            const statusBadge = document.getElementById("ocr-badge-status");
            const lensHelper = document.getElementById("lens-helper-panel");

            if (!scannerBox || !canvas) return;

            // Reset UI
            emptyState.classList.add("hidden");
            canvas.classList.remove("hidden");
            document.getElementById("extracted-invoice-details").classList.add("hidden");
            statusBadge.className = "status-badge badge-warning";
            statusBadge.textContent = "Scanning...";

            const ctx = canvas.getContext("2d");
            const _readStart = performance.now();

            // Check if actual file object was uploaded
            if (fileObj) {
                const isPdf = fileObj.type === "application/pdf" || /\bpdf\b/i.test(fileName || fileObj.name || "");
                if (isPdf) {
                    // Draw PDF placeholder message on canvas
                    canvas.width = 600;
                    canvas.height = 300;
                    ctx.fillStyle = "#1e293b";
                    ctx.fillRect(0, 0, 600, 300);
                    ctx.fillStyle = "#38bdf8";
                    ctx.font = "bold 20px Outfit";
                    ctx.fillText("PDF Document Uploaded", 180, 130);
                    ctx.font = "14px Outfit";
                    ctx.fillStyle = "#94a3b8";
                    ctx.fillText("Extracting text directly via Gemini multimodal OCR...", 140, 170);

                    const reader = new FileReader();
                    reader.onload = (e) => {
                        this._lastOcrImageLoadMs = Math.round(performance.now() - _readStart);
                        const base64Data = e.target.result.split(',')[1];
                        this.runStagedOCRScan(base64Data, "application/pdf", fileName);
                    };
                    reader.readAsDataURL(fileObj);
                    return;
                }

                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        // Draw image to canvas fitting bounds (increased to 1600 for high-fidelity OCR)
                        const maxW = 1600;
                        const maxH = 1600;
                        let w = img.width;
                        let h = img.height;
                        if (w > maxW || h > maxH) {
                            if (w > h) {
                                h = Math.round(h * (maxW / w));
                                w = maxW;
                            } else {
                                w = Math.round(w * (maxH / h));
                                h = maxH;
                            }
                        }
                        canvas.width = w;
                        canvas.height = h;
                        ctx.drawImage(img, 0, 0, w, h);

                        // Hide helper panel initially
                        if (lensHelper) lensHelper.classList.add("hidden");

                        // Extract preprocessed image data
                        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
                        const commaIdx = dataUrl.indexOf(",");
                        const base64Data = dataUrl.substring(commaIdx + 1);
                        const mimeType = "image/jpeg";
                        this._lastOcrImageLoadMs = Math.round(performance.now() - _readStart);
                        this.runStagedOCRScan(base64Data, mimeType, fileName);
                    };
                    img.onerror = () => {
                        statusBadge.className = "status-badge badge-error";
                        statusBadge.textContent = "Scan Failed";
                        this.showToast("Failed to load invoice image file.", "error");
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(fileObj);
            } else {
                this.drawKastooriMockInvoice(canvas);
                const dataUrl = canvas.toDataURL("image/jpeg");
                const commaIdx = dataUrl.indexOf(",");
                const base64Data = dataUrl.substring(commaIdx + 1);
                this._lastOcrImageLoadMs = Math.round(performance.now() - _readStart);
                this.runStagedOCRScan(base64Data, "image/jpeg", fileName);
            }
        }

        showEmptyOCRResults(fileName, toastMsg) {
            const statusBadge = document.getElementById("ocr-badge-status");
            statusBadge.className = "status-badge badge-warning";
            statusBadge.textContent = "No items matched";

            document.getElementById("ext-supplier").value = "Unrecognized Supplier";
            document.getElementById("ext-invoice-no").value = "OCR-FAILED";
            document.getElementById("ext-invoice-date").value = new Date().toISOString().split('T')[0];

            this.currentExtractedBill = null;

            const tableBody = document.getElementById("extracted-items-table-body");
            tableBody.innerHTML = `<tr><td colspan="10" class="text-center text-muted">No medicines could be parsed automatically from this image. You can retry the scan, or use the "Paste Text Bill (Backup)" tab to enter items manually.</td></tr>`;

            document.getElementById("extracted-invoice-details").classList.remove("hidden");
            this.showToast(toastMsg || "No matches found.", "warning");
            
            // Disable verify button
            document.getElementById("btn-import-bill")?.setAttribute("disabled", "true");

            // Hide summary card
            document.getElementById("ocr-summary-card")?.classList.add("hidden");

            // Per spec: never auto-switch to the manual Paste Text tab. The
            // image stays loaded and the user can retry or switch tabs
            // themselves — the "Paste Text Bill (Backup)" tab remains
            // available as an optional manual tool only.
        }

        // Parse individual line using regular expressions
        parseOcrLine(line) {
            line = line.trim();
            if (!line || line.length < 15) return null;

            // Search for expiry date MM/YY (e.g. 02/28, 12/26) or MM/YYYY with various separators (/, -, ., space)
            const expRegex = /\b(\d{2})[\/\-.\s](\d{2}|\d{4})\b/;
            const expMatch = line.match(expRegex);
            if (!expMatch) return null;

            const expiry = expMatch[0].replace(/[\-\.\s]/g, '/');
            const expIndex = line.indexOf(expMatch[0]);

            let beforeExp = line.substring(0, expIndex).trim();
            let afterExp = line.substring(expIndex + expiry.length).trim();

            // Clean HSN / Serial numbers before name
            beforeExp = beforeExp.replace(/^\d+\s+/, ''); // remove S.No
            beforeExp = beforeExp.replace(/\b\d{8}\b/, ''); // remove 8-digit HSN code

            // Clean and extract brand prefixes
            let brand = "Generic";
            const brandWords = ["USV L.", "USV", "PHAR", "LUPIN", "GRAN", "REDD", "UNJOINT", "AVEN", "SUN P", "SUN", "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", "GLEN", "MICR", "ALLE", "NOVA", "ANGL", "GERM", "SUNW", "LINK", "CIPLA", "MSD", "RANB", "MANO"];
            for (const b of brandWords) {
                if (beforeExp.toLowerCase().startsWith(b.toLowerCase())) {
                    brand = b;
                    beforeExp = beforeExp.substring(b.length).trim();
                    break;
                }
            }

            // Clean remaining name
            let name = beforeExp.replace(/[^a-zA-Z0-9\s\.\-]/g, '').trim();
            if (name.length < 3) return null;

            // Extract Batch code (usually alphanumeric word before expiry)
            let batch = null;
            const words = name.split(/\s+/);
            if (words.length > 1) {
                const potentialBatch = words[words.length - 1];
                if (potentialBatch.match(/^[a-z0-9]+$/i) && potentialBatch.length >= 3 && potentialBatch.length <= 8) {
                    batch = potentialBatch.toUpperCase();
                    name = name.substring(0, name.lastIndexOf(potentialBatch)).trim();
                }
            }

            // Extract pack size (e.g., 10's, 15's, 1s)
            const packRegex = /\b(\d+)\s*['s|s]\b/i;
            const packMatch = afterExp.match(packRegex);
            let pack = "10's";
            if (packMatch) {
                pack = packMatch[0].replace(/\s+/g, '');
                afterExp = afterExp.replace(packRegex, '').trim();
            }

            // Extract Qty (integer before decimal numbers)
            const numbers = afterExp.match(/\b\d+\b/g) || [];
            let qty = null;
            if (numbers.length > 0) {
                const parsedQty = parseInt(numbers[0]);
                if (parsedQty > 0 && parsedQty <= 1000) {
                    qty = parsedQty;
                }
            }

            // Extract MRP (decimal number in the text after expiry, e.g. 106.78)
            const decimals = afterExp.match(/\b\d+\.\d{2}\b/g) || [];
            let mrp = null;
            if (decimals.length > 0) {
                mrp = parseFloat(decimals[0]);
            }

            // Clean product name casing
            const fullName = brand !== "Generic" ? `${brand} ${name.toUpperCase()}` : name.toUpperCase();

            // Extract GST percentage
            const gstRegex = /\b(\d{1,2})\s*%\b/;
            const gstMatch = line.match(gstRegex);
            const gst = gstMatch ? gstMatch[0].replace(/\s+/g, '') : "5%";

            return {
                name: fullName,
                brand: brand,
                batch: batch,
                exp: expiry,
                pack: pack,
                qty: qty,
                cost: mrp !== null ? mrp / 1.4 : null,
                mrp: mrp,
                gst: gst
            };
        }

        parseOcrLineLenient(line, tablets) {
            line = line.trim();
            if (!line || line.length < 3) return null;

            // 1. Try to find any database medicine name match in this line
            const upperLine = line.toUpperCase();
            let matchedTab = null;
            
            // Sort by name length descending so we match the longest name first
            const sortedTabs = [...tablets].sort((a, b) => b.name.length - a.name.length);
            for (const tab of sortedTabs) {
                if (upperLine.includes(tab.name.toUpperCase()) || upperLine.includes(tab.code.toUpperCase())) {
                    matchedTab = tab;
                    break;
                }
            }

            // 2. If no direct database match, do fuzzy word matching
            if (!matchedTab) {
                for (const tab of sortedTabs) {
                    const firstWord = tab.name.split(/\s+/)[0];
                    if (firstWord.length > 3 && upperLine.includes(firstWord.toUpperCase())) {
                        matchedTab = tab;
                        break;
                    }
                }
            }

            let name = "";
            let brand = "Generic";
            let cost = null;
            let mrp = null;
            let pack = "10's";

            if (matchedTab) {
                name = matchedTab.name;
                brand = matchedTab.brand;
                cost = matchedTab.cost;
                mrp = matchedTab.mrp;
                pack = matchedTab.pack;
            } else {
                // If it is a completely new product line, clean it
                name = line.replace(/\b\d{8}\b/g, '') // remove HSN
                           .replace(/\b\d{2}\/\d{2,4}\b/g, '') // remove expiry
                           .replace(/[^\w\s\.\-]/g, '') // remove symbols
                           .trim();
                
                // Get first few words as name
                const words = name.split(/\s+/).filter(w => !w.match(/^\d+$/) && w.length > 1);
                if (words.length === 0) return null;
                name = words.slice(0, 4).join(" ").toUpperCase();
                brand = this.getBrandFromName(name);
            }

            // 3. Extract quantity
            const integers = line.match(/\b\d+\b/g) || [];
            let qty = null;
            
            const candidates = integers.map(n => parseInt(n)).filter(val => val > 0 && val < 500);
            if (candidates.length > 0) {
                const typicalQtys = [90, 180, 30, 20, 10, 50, 100, 150, 60, 120];
                const matchTypical = candidates.find(c => typicalQtys.includes(c));
                qty = matchTypical || candidates[candidates.length - 1];
            }

            // 4. Extract expiry
            const expRegex = /\b(\d{2})[\/\-.\s](\d{2}|\d{4})\b/;
            const expMatch = line.match(expRegex);
            const expiry = expMatch ? expMatch[0].replace(/[\-\.\s]/g, '/') : null;

            // 5. Extract batch
            let batch = null;
            const words = line.split(/\s+/);
            const potentialBatches = words.filter(w => {
                const cleanW = w.replace(/[^a-z0-9]/gi, '');
                return cleanW.length >= 3 && cleanW.length <= 10 && 
                       !cleanW.match(/^\d+$/) && 
                       !name.includes(cleanW.toUpperCase()) &&
                       !["BATCH", "EXP", "QTY", "MRP", "TAB", "PACKS", "PACK"].includes(cleanW.toUpperCase());
            });
            if (potentialBatches.length > 0) {
                batch = potentialBatches[0].replace(/[^a-z0-9]/gi, '').toUpperCase();
            }

            // Extract MRP (decimal number, e.g. 106.78)
            const decimals = line.match(/\b\d+\.\d{2}\b/g) || [];
            if (decimals.length > 0) {
                mrp = parseFloat(decimals[0]);
                cost = mrp / 1.4;
            }

            // Extract GST percentage
            const gstRegex = /\b(\d{1,2})\s*%\b/;
            const gstMatch = line.match(gstRegex);
            const gst = gstMatch ? gstMatch[0].replace(/\s+/g, '') : "5%";

            return {
                name: name,
                brand: brand,
                batch: batch,
                exp: expiry,
                pack: pack,
                qty: qty,
                cost: cost,
                mrp: mrp,
                gst: gst
            };
        }

        drawKastooriMockInvoice(canvas) {
            if (!canvas) return;
            const ctx = canvas.getContext("2d");
            canvas.width = 400;
            canvas.height = 300;
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 400, 300);

            ctx.fillStyle = "#1e293b";
            ctx.font = "bold 14px Outfit";
            ctx.fillText("KASTOORI MEDICALS", 130, 25);
            ctx.font = "8px monospace";
            ctx.fillText("No 51/4, Mariadoss Street, Royapuram, Chennai - 600013", 70, 38);
            ctx.fillText("Bill No: 26KK404              Date: 09/04/26", 40, 55);
            ctx.fillText("Cust Name: RBI KILPAUK STAFF QUARTERS", 40, 68);

            ctx.strokeStyle = "#cbd5e1";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(30, 78); ctx.lineTo(370, 78);
            ctx.moveTo(30, 90); ctx.lineTo(370, 90);
            ctx.moveTo(30, 240); ctx.lineTo(370, 240);
            ctx.stroke();

            ctx.font = "bold 7px monospace";
            ctx.fillText("S.No   Product Name            Batch   Qty   MRP   Amount", 32, 86);

            ctx.font = "7px monospace";
            const mockRows = [
                "1.    USV L. ROSEDAY 20MG      5012    90    416.44 2498.64",
                "2.    USV L. GLYCOMET 250MG    2232    90    14.90  134.10",
                "3.    PHAR SUPRACAL XT         5009    90    220.31 1321.86",
                "4.    USV L. GLYCOMET GP 0.5   578B    90    94.90  569.40",
                "5.    USV L. LUPIMEG TAB       5143    90    329.62 1977.72",
                "6.    GRAN RENERVE PLUS        1747    90    302.97 1818.35",
                "7.    LUPIN LUPIMED 2.5MG      0395    180   79.63  955.56",
                "8.    USV L. TAZLOC 40MG       9035    90    103.06 618.36"
            ];
            mockRows.forEach((row, i) => {
                ctx.fillText(row, 32, 104 + (i * 15));
            });

            ctx.font = "bold 8px monospace";
            ctx.fillText("GRAND TOTAL:                          ₹17,865.35", 32, 255);
        }

        showOCRResultsKastoori() {
            const statusBadge = document.getElementById("ocr-badge-status");
            if (statusBadge) {
                statusBadge.className = "status-badge badge-success";
                statusBadge.textContent = "OCR Scanned";
            }

            const canvas = document.getElementById("scanner-canvas");
            if (canvas) {
                this.drawKastooriMockInvoice(canvas);
            }

            this.renderExtractedItems(KASTOORI_INVOICE_ITEMS, "Kastoori Medicals", "INV-26KK404", "2026-04-09");

            const detailsForm = document.getElementById("extracted-invoice-details");
            if (detailsForm) detailsForm.classList.remove("hidden");
            this.showToast("Kastoori Medicals Bill parsed perfectly (20 items).", "success");
        }

        showOCRResultsKastoori405() {
            const statusBadge = document.getElementById("ocr-badge-status");
            statusBadge.className = "status-badge badge-success";
            statusBadge.textContent = "OCR Scanned";

            this.renderExtractedItems(KASTOORI_INVOICE_ITEMS_405, "Kastoori Medicals", "INV-26KK405", "2026-04-09");

            document.getElementById("extracted-invoice-details").classList.remove("hidden");
            this.showToast("Kastoori Medicals Bill parsed perfectly (12 items).", "success");
        }

        showOCRResultsKastoori398() {
            const statusBadge = document.getElementById("ocr-badge-status");
            statusBadge.className = "status-badge badge-success";
            statusBadge.textContent = "OCR Scanned";

            this.renderExtractedItems(KASTOORI_INVOICE_ITEMS_398, "Kastoori Medicals", "INV-26KK398", "2026-04-09");

            document.getElementById("extracted-invoice-details").classList.remove("hidden");
            this.showToast("Kastoori Medicals Bill parsed perfectly (6 items).", "success");
        }

        showOCRResultsKastoori401() {
            const statusBadge = document.getElementById("ocr-badge-status");
            statusBadge.className = "status-badge badge-success";
            statusBadge.textContent = "OCR Scanned";

            this.renderExtractedItems(KASTOORI_INVOICE_ITEMS_401, "Kastoori Medicals", "INV-26KK401", "2026-04-09");

            document.getElementById("extracted-invoice-details").classList.remove("hidden");
            this.showToast("Kastoori Medicals Bill parsed perfectly (1 item).", "success");
        }

        calculateLevenshteinDistance(s1, s2) {
            const str1 = (s1 || "").trim().toUpperCase();
            const str2 = (s2 || "").trim().toUpperCase();
            
            if (str1 === str2) return 100;
            if (str1.length === 0 || str2.length === 0) return 0;
            
            const track = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
            for (let i = 0; i <= str1.length; i += 1) {
                track[0][i] = i;
            }
            for (let j = 0; j <= str2.length; j += 1) {
                track[j][0] = j;
            }
            for (let j = 1; j <= str2.length; j += 1) {
                for (let i = 1; i <= str1.length; i += 1) {
                    const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
                    track[j][i] = Math.min(
                        track[j][i - 1] + 1, // deletion
                        track[j - 1][i] + 1, // insertion
                        track[j - 1][i - 1] + indicator // substitution
                    );
                }
            }
            const distance = track[str2.length][str1.length];
            const maxLength = Math.max(str1.length, str2.length);
            return Math.round((1 - distance / maxLength) * 100);
        }

        // Wraps fetch() with a hard timeout via AbortController. The user
        // should never wait minutes for a hung Gemini request -- past this
        // limit we abort and let the caller fall back (local OCR, retry,
        // etc.) instead of leaving the UI stuck on "AI OCR processing...".
        async fetchWithTimeout(url, options, timeoutMs = 20000) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                return await fetch(url, { ...options, signal: controller.signal });
            } catch (err) {
                if (err.name === "AbortError") {
                    const timeoutErr = new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s.`);
                    timeoutErr.isTimeout = true;
                    throw timeoutErr;
                }
                throw err;
            } finally {
                clearTimeout(timer);
            }
        }

        parseGeminiJSON(text) {
            if (!text) return null;
            let jsonText = text.trim();

            // Strip markdown code fences (```json ... ``` or ``` ... ```).
            jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

            // Try the whole cleaned text first.
            try {
                return JSON.parse(jsonText);
            } catch (e) { /* fall through to candidate extraction below */ }

            // Extract the FIRST valid JSON object/array by scanning for
            // balanced brace/bracket pairs, rather than a single greedy
            // first-{-to-last-} regex (which breaks if trailing text after
            // the JSON contains an unrelated closing brace).
            const tryExtractBalanced = (openCh, closeCh) => {
                const start = jsonText.indexOf(openCh);
                if (start === -1) return null;
                let depth = 0;
                for (let i = start; i < jsonText.length; i++) {
                    if (jsonText[i] === openCh) depth++;
                    else if (jsonText[i] === closeCh) {
                        depth--;
                        if (depth === 0) {
                            const candidate = jsonText.substring(start, i + 1);
                            try { return JSON.parse(candidate); } catch (e) { return null; }
                        }
                    }
                }
                return null;
            };

            const objResult = tryExtractBalanced("{", "}");
            if (objResult !== null) return objResult;
            const arrResult = tryExtractBalanced("[", "]");
            if (arrResult !== null) return arrResult;

            console.error("Failed to parse Gemini JSON:", text);
            throw new Error("Invalid AI response format. Failed to parse JSON.");
        }


        // Maps a medicine name's Dosage Form to a short, unambiguous code
        // used in the product code. Independent of the coarser "category"
        // grouping (which lumps Tablets & Capsules together) since the
        // product code must distinguish Tablet from Capsule from Rotacap.
        detectFormCodeFromName(name, categoryHint) {
            const n = (name || "").toUpperCase();
            if (/\bROTACAP/.test(n)) return "RC";
            if (/\b(CAPSULE|CAPSULES|CAP|CAPS)\b/.test(n)) return "C";
            if (/\b(SUSPENSION|SUSP|SUS)\b/.test(n)) return "SUS";
            if (/\b(SYRUP|SYP|ORAL\s+SOL(UTION)?|ORAL\s+LIQUID)\b/.test(n)) return "SY";
            if (/\b(INJECTION|INJECTIONS|INJ|IV|IM|AMPOULE|AMPOULES|VIAL|VIALS)\b/.test(n)) return "INJ";
            if (/\b(INHALER|INHALERS|MDI|DPI)\b/.test(n)) return "INH";
            if (/\bGEL(S)?\b/.test(n)) return "GEL";
            if (/\bCREAM(S)?\b/.test(n)) return "CRM";
            if (/\b(OINTMENT|OINTMENTS|OINT|OINTS)\b/.test(n)) return "OIN";
            if (/\bLOTION(S)?\b/.test(n)) return "LOT";
            if (/\bTUBE(S)?\b/.test(n)) return "TUB";
            if (/\b(POWDER|POWDERS|SACHET|SACHETS|GRANULES)\b/.test(n)) return "PWD";
            if (/\bOIL(S)?\b/.test(n)) return "OIL";
            if (/\bDROP(S)?\b/.test(n)) return "DRP";
            if (/\bSPRAY(S)?\b/.test(n)) return "SPR";
            if (/\b(TAB|TABLET|TABLETS|TABS)\b/.test(n)) return "T";

            if (categoryHint) {
                const c = categoryHint.toLowerCase();
                if (c.includes("rotacap")) return "RC";
                if (c.includes("capsule")) return "C";
                if (c.includes("respule") || c.includes("suspension")) return "SUS";
                if (c.includes("syrup") || c.includes("solution")) return "SY";
                if (c.includes("inhaler")) return "INH";
                if (c.includes("inject")) return "INJ";
                if (c.includes("cream")) return "CRM";
                if (c.includes("gel")) return "GEL";
                if (c.includes("ointment")) return "OIN";
                if (c.includes("lotion")) return "LOT";
                if (c.includes("powder")) return "PWD";
                if (c.includes("drop")) return "DRP";
                if (c.includes("spray")) return "SPR";
            }
            return "T";
        }

        // Normalizes a Strength value into the code-safe token used in the
        // product code: strip the unit for MG (the implicit default),
        // otherwise keep the unit suffix (MCG/ML/IU/%); decimals use "P" in
        // place of ".". Examples: "10 MG" -> "10", "0.5 MG" -> "0P5",
        // "100 MCG" -> "100MCG", "5 ML" -> "5ML", "40 IU" -> "40IU".
        normalizeStrengthToken(name) {
            const n = (name || "").toUpperCase();
            const m = n.match(/\b(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|IU|%)\b/);
            let value, unit;
            if (m) {
                value = m[1];
                unit = m[2];
            } else {
                const bare = n.match(/\b(\d+(?:\.\d+)?)\b/);
                if (!bare) return "0";
                value = bare[1];
                unit = "MG";
            }
            const valueToken = value.replace(".", "P");
            return unit === "MG" ? valueToken : `${valueToken}${unit}`;
        }

        // --- BRAND CODE REGISTRY ---
        // A Brand Code, once assigned to a brand word, is PERMANENT and is
        // NEVER reused for a different brand. This is stored independently
        // of Master Data (ti_brand_codes: { brandWord -> brandCode }) so the
        // assignment survives even if that brand's only Master Data record
        // is later edited or deleted, and so the same brand always resolves
        // to the same code no matter which product variant triggers lookup.
        getBrandCodeRegistry() { return JSON.parse(localStorage.getItem("ti_brand_codes") || "{}"); }
        setBrandCodeRegistry(data) { return this._safeSetItem("ti_brand_codes", JSON.stringify(data), "Master Data", "Brand Code Registry"); }

        // Returns the permanent Brand Code for a given brand word, assigning
        // and persisting a new one if this brand hasn't been seen before.
        // Starts at 5 letters and extends one letter at a time
        // (ROSEV -> ROSEVA -> ROSEVAS...) only when a genuinely different
        // brand already owns that prefix -- guaranteeing uniqueness across
        // 30,000+ products without ever reusing another medicine's code.
        getOrAssignBrandCode(brandWord) {
            const baseWord = (brandWord || "GEN").toUpperCase().replace(/[^A-Z]/g, "") || "GEN";
            const registry = this.getBrandCodeRegistry();

            if (registry[baseWord]) return registry[baseWord];

            const usedCodes = new Set(Object.values(registry));
            let len = Math.min(5, baseWord.length) || 3;
            let code = baseWord.substring(0, len) || "GEN";
            while (usedCodes.has(code) && len < baseWord.length) {
                len++;
                code = baseWord.substring(0, len);
            }
            // Extremely rare fallback: even the full word is already taken
            // by a different brand (e.g. two distinct brands with the exact
            // same first word) -- disambiguate with a numeric suffix on the
            // full word (ROSEVAS -> ROSEVAS1 -> ROSEVAS2...) so we still
            // never reuse another medicine's Brand Code.
            let suffix = 1;
            while (usedCodes.has(code)) {
                code = `${baseWord}${suffix}`;
                suffix++;
            }

            registry[baseWord] = code;
            this.setBrandCodeRegistry(registry);
            return code;
        }

        // Permanent product code, format: [BrandCode]-[Strength]-[Form]-[Pack]
        // e.g. ROSEV-10-T-10 (Rosevast 10mg Tablet, pack of 10).
        //
        // Every field must agree (Brand + Strength + Dosage Form + Pack
        // Size) for two products to legitimately share a code. The Brand
        // Code comes from the permanent registry above -- never recomputed
        // ad hoc, never reused across different brands.
        //
        // Once generated for a given Brand + Strength + Form + Pack, the
        // code is never regenerated -- see resolveMedicine(), which
        // always reuses an existing Master Data record for that exact
        // combination before ever calling this function.
        generateProductCode(name, packNumber, category) {
            if (!name) return "GEN-0-T-10";
            let cleanName = name.trim().toUpperCase();

            // Strip known manufacturer/distributor prefixes (not the brand
            // name itself) so they don't pollute the Brand Code.
            const prefixes = ["USV L.", "USV", "PHAR", "LUPIN", "GRAN", "REDD", "UNJOINT", "AVEN", "SUN P", "SUN", "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", "GLEN", "MICR", "ALLE", "NOVA", "ANGL", "GERM", "SUNW", "LINK", "CIPLA", "MSD", "RANB", "MANO", "CADILA", "ABBOTT", "ALKEM", "TORRENT", "ZYDUS", "SANOFI", "GLAXO", "GSK", "PFIZER", "DR.REDDY", "DR.REDDY'S"];
            for (const p of prefixes) {
                if (cleanName.startsWith(p + " ")) {
                    cleanName = cleanName.substring(p.length + 1).trim();
                }
            }

            const strengthPart = this.normalizeStrengthToken(cleanName);
            const formCode = this.detectFormCodeFromName(cleanName, category);

            let pack = packNumber;
            if (!pack) pack = this.extractPackNumber(cleanName) || 10;

            const firstWord = cleanName.split(/[\s\-\.\/\+]+/)[0].replace(/[^A-Z]/gi, '');
            const brandCode = this.getOrAssignBrandCode(firstWord);

            return `${brandCode}-${strengthPart}-${formCode}-${pack}`;
        }

        // Pulls the leading pack-size number out of a pack string like
        // "10's", "15 Pack", "10 X 15", etc. Falls back to parsePackSize's
        // tabsPerStrip detection so this always agrees with the rest of the app.
        extractPackNumber(packStr, name) {
            if (packStr) {
                const m = String(packStr).match(/\b(\d+)\b/);
                if (m) return parseInt(m[1], 10);
            }
            const parsed = this.parsePackSize(packStr, name);
            return parsed ? parsed.tabsPerStrip : null;
        }

        // ============================================================
        // MEDICINE IDENTITY ENGINE -- the ONE matching function used by
        // every workflow (Order Sheet, Supplier Bill, Inventory
        // Verification, Reorder, Due Orders, Manual Search, Master Data).
        // Replaces the old findMatchingTablet / findSimilarMatches /
        // resolveMedicineMatch trio -- there is exactly one identity
        // engine now, everything else calls into it.
        //
        //   resolveMedicine()
        //     -> Normalize OCR (self-learning correction shortcut)
        //     -> Find Brand
        //     -> Find Strength
        //     -> Find Dosage Form
        //     -> Find Pack
        //     -> Return Result
        //
        // Result shape:
        //   {
        //     status: "exact" | "new" | "pack_confirm",
        //     tablet: <best matching record, or null>,
        //     matchScore: 0-100,
        //     candidates: [ <record>, ... ]  // ranked fuzzy suggestions
        //     parsed: { brand, strength, form, pack },
        //     existingPack, scannedPack        // only set for pack_confirm
        //   }
        //
        // Popup rule (unchanged): Brand differs -> New Medicine, no popup.
        // Strength differs -> New Medicine, no popup. Dosage Form differs
        // -> New Medicine, no popup. Pack Size is the ONLY field allowed
        // to interrupt the user (Accept New Pack / Reuse Existing / Cancel).
        //
        // opts.includeCandidates: force the fuzzy candidate list to be
        // computed even on an "exact" cascade hit -- used by manual
        // search / OCR match-edit callers that always want a ranked list,
        // not just the single best match.
        resolveMedicine(rawName, rawPack, tablets, opts = {}) {
            const result = { status: "new", tablet: null, matchScore: 0, candidates: [], parsed: null, existingPack: null, scannedPack: null };
            if (!rawName || !tablets || tablets.length === 0) return result;

            // Step 1: Normalize OCR.
            //   Uppercase -> collapse extra whitespace -> split a digit
            //   glued directly to its unit ("10MG" -> "10 MG") -> normalize
            //   TAB/TABS/CAP/CAPS to their full word. This is the single
            //   normalization pass every downstream field extractor
            //   (Brand/Strength/Form/Pack) and the fuzzy matcher both run on
            //   -- OCR spacing/abbreviation variations never reach a raw
            //   string comparison unnormalized.
            const normalizedName = this._normalizeOcrText(rawName);

            // Self-learning correction loop wins immediately over everything
            // else (the user already confirmed this exact OCR text maps to
            // this exact Product Code before). Keyed on plain
            // uppercase+trim -- intentionally NOT the fuller normalization
            // above, so it stays byte-identical to the key format written
            // by Supplier Bill import (see importExtractedBillResolved).
            const corrections = JSON.parse(localStorage.getItem("ti_ocr_corrections") || "{}");
            const correctionKey = rawName.toUpperCase().trim();
            if (corrections[correctionKey]) {
                const found = tablets.find(t => t.code === corrections[correctionKey]);
                if (found) {
                    result.status = "exact";
                    result.tablet = { ...found, matchScore: 100 };
                    result.matchScore = 100;
                    result.candidates = [found];
                    result.parsed = {
                        brand: this.extractProductBrandWord(normalizedName),
                        strength: this.normalizeStrengthToken(normalizedName),
                        form: this.detectFormCodeFromName(normalizedName),
                        pack: this.extractPackNumber(rawPack, normalizedName)
                    };
                    return result;
                }
            }

            // Step 2-5: Find Brand -> Find Strength -> Find Dosage Form ->
            // Find Pack, via the Brand/Brand+Strength composite index --
            // O(1) lookup instead of scanning every Master Data record.
            const brand = this.extractProductBrandWord(normalizedName);
            const strength = this.normalizeStrengthToken(normalizedName);
            const form = this.detectFormCodeFromName(normalizedName);
            const pack = this.extractPackNumber(rawPack, normalizedName);
            result.parsed = { brand, strength, form, pack };

            if (brand) {
                const indexes = this.getIndexes();
                const brandMatches = indexes.byBrand.get(brand);
                if (brandMatches && brandMatches.length > 0) {
                    const strengthMatches = indexes.byBrandStrength.get(`${brand}|${strength}`) || [];
                    if (strengthMatches.length > 0) {
                        const formMatches = strengthMatches.filter(t => this.detectFormCodeFromName(t.name, t.category) === form);
                        if (formMatches.length > 0) {
                            if (!pack) {
                                // Pack size not readable from OCR at all -- best-effort
                                // reuse the existing record rather than blocking the workflow.
                                result.status = "exact";
                                result.tablet = { ...formMatches[0], matchScore: 100 };
                                result.matchScore = 100;
                            } else {
                                const packMatch = formMatches.find(t => this.extractPackNumber(t.pack, t.name) === pack);
                                if (packMatch) {
                                    result.status = "exact";
                                    result.tablet = { ...packMatch, matchScore: 100 };
                                    result.matchScore = 100;
                                } else {
                                    // Pack Size differs -- popup required.
                                    result.status = "pack_confirm";
                                    result.tablet = formMatches[0];
                                    result.existingPack = this.extractPackNumber(formMatches[0].pack, formMatches[0].name);
                                    result.scannedPack = pack;
                                }
                            }
                        }
                    } else if (strength) {
                        // Same Brand, but NOT at this Strength (MG differs) --
                        // this is the "Same medicine but different MG" case and
                        // MUST popup, never silently become a "New Medicine" or
                        // get auto-picked further down the cascade. Surface every
                        // strength variant of this brand as candidates so the
                        // Medicine Confirmation popup can offer them, and leave
                        // result.tablet unset so no caller can silently use it.
                        result.status = "new";
                        result.candidates = brandMatches
                            .filter(t => this.detectFormCodeFromName(t.name, t.category) === form)
                            .map(t => ({ ...t, matchScore: 90 }));
                        if (result.candidates.length === 0) {
                            result.candidates = brandMatches.map(t => ({ ...t, matchScore: 85 }));
                        }
                        return result;
                    }
                }
            }

            // Step 5.5: Generic/Drug Name -> Brand resolution. Only runs when
            // the Brand-word cascade above did not already land on an exact
            // or pack_confirm result (i.e. the scanned text's first word
            // isn't a known brand word at all). Tries the scanned text,
            // stripped of its strength/unit and dosage-form tokens, as a
            // Generic Name against the byDrugName index -- e.g. OCR reads
            // "ATORVASTATIN 10MG TAB" and Master Data only has brand records
            // (Aztor 10, Storvas 10, Atorlip 10...), each carrying
            // drugName: "Atorvastatin".
            //   - Exactly one brand exists for that generic+strength+form:
            //     resolve silently as "exact", same as an unambiguous brand hit.
            //   - More than one brand exists: this is the ambiguous case the
            //     Brand<->Generic requirement exists for. NEVER auto-pick --
            //     populate result.candidates with all of them and leave
            //     result.status as "new" so the caller's gate (which now
            //     checks candidates before creating a duplicate) routes to
            //     the existing showOcrMatchModal() popup instead.
            if (result.status !== "exact" && result.status !== "pack_confirm") {
                const genericGuess = this._extractGenericNameGuess(normalizedName);
                if (genericGuess) {
                    const indexes = this.getIndexes();
                    const genericMatches = indexes.byDrugNameStrength.get(`${genericGuess}|${strength}`)
                        || indexes.byDrugName.get(genericGuess) || [];
                    const formFiltered = genericMatches.filter(t => this.detectFormCodeFromName(t.name, t.category) === form);
                    const candidatePool = formFiltered.length > 0 ? formFiltered : genericMatches;
                    if (candidatePool.length === 1) {
                        result.status = "exact";
                        result.tablet = { ...candidatePool[0], matchScore: 100 };
                        result.matchScore = 100;
                    } else if (candidatePool.length > 1) {
                        result.candidates = candidatePool.map(t => ({ ...t, matchScore: 95 }));
                    }
                }
            }

            // Step 6: Return Result -- fuzzy candidate ranking. Only computed
            // when the cascade (Brand or Generic) didn't already land on an
            // exact resolution or find generic candidates above, so New
            // Medicine / Not Found popups still have suggestions to offer,
            // or when the caller explicitly wants a ranked list regardless
            // of outcome (manual search boxes, the OCR match-edit box, etc.).
            if (result.candidates.length === 0 && (opts.includeCandidates || result.status !== "exact")) {
                result.candidates = this._fuzzyMatchCandidates(normalizedName, tablets);
                if (!result.tablet && result.candidates.length > 0 && result.candidates[0].matchScore > 95) {
                    // Fuzzy match ONLY auto-accepted when confidence is above 95%
                    // (e.g. OCR "Rozeday 10" vs Master "Roseday 10"). At or below
                    // 95%, result.tablet is deliberately left unset so every
                    // caller checking status !== "exact" routes to a popup instead
                    // of silently guessing.
                    result.tablet = result.candidates[0];
                    result.matchScore = result.candidates[0].matchScore;
                }
            }

            return result;
        }

        // Step 1 of resolveMedicine()'s pipeline, exposed as its own method
        // so every caller normalizes identically:
        //   Uppercase -> Remove extra spaces -> Normalize MG (split a digit
        //   glued to its unit) -> Normalize TAB/TABLET/CAP/CAPSULE -> ready
        //   for Brand/Strength/Form/Pack extraction and fuzzy comparison.
        // Deliberately does NOT touch PCM/PAN/MDI-style abbreviation
        // expansion (that stays inside _fuzzyMatchCandidates only) and does
        // NOT feed the self-learning correction-key lookup (that key must
        // stay byte-identical to the format written by Supplier Bill import).
        _normalizeOcrText(rawName) {
            if (!rawName) return "";
            let n = rawName.toUpperCase().trim();
            n = n.replace(/\s+/g, " ");                          // collapse extra spaces
            n = n.replace(/([A-Z])(\d)/g, "$1 $2");              // letter->digit boundary: "ROSEVAST10" -> "ROSEVAST 10"
            n = n.replace(/(\d)(MG|MCG|ML|GM|IU)/g, "$1 $2");    // digit->unit boundary: "10MG" -> "10 MG"
            n = n.replace(/(MG|MCG|ML|GM|IU)([A-Z])/g, "$1 $2"); // unit->letter boundary: "MGTAB" -> "MG TAB"
            n = n.replace(/\s+/g, " ").trim();
            n = n.replace(/\bTABS?\b/g, "TABLET");               // TAB/TABS -> TABLET
            n = n.replace(/\bCAPS?\b/g, "CAPSULE");              // CAP/CAPS -> CAPSULE
            return n;
        }

        // Strips the strength+unit token and known dosage-form words from an
        // already-normalized OCR string, leaving a Generic Name candidate to
        // look up against the byDrugName index. E.g.
        // "ATORVASTATIN 10 MG TABLET" -> "ATORVASTATIN"
        // "N ACETYL CYSTEINE 150 MG TABLET" -> "N ACETYL CYSTEINE"
        // Deliberately conservative: only strips the FIRST strength+unit
        // match and known form words, never touches combination-drug "+"
        // segments -- if that leaves nothing (e.g. the input was just a
        // number), returns "" so the byDrugName lookup is skipped rather
        // than matching on an empty/garbage key.
        _extractGenericNameGuess(normalizedName) {
            if (!normalizedName) return "";
            let g = normalizedName;
            g = g.replace(/\b\d+(?:\.\d+)?\s*(MG|MCG|G|ML|IU|%)\b/, " ");
            g = g.replace(/\b(TABLET|TABLETS|CAPSULE|CAPSULES|ROTACAP|SYRUP|SUSPENSION|INJECTION|DROPS|GEL|CREAM|OINTMENT|LOTION|OIL|POWDER|TUBE|SPRAY|INHALER|SACHET|GRANULES|AMPOULE|VIAL)\b/g, " ");
            g = g.replace(/\s+/g, " ").trim();
            return g;
        }

        // Fuzzy candidate ranking used internally by resolveMedicine() --
        // brand/name substring + word-level Levenshtein overlap against
        // name/drugName/code, with Strength/Dosage Form/Manufacturer/Pack
        // agreement as ranking bonuses only. A specified-but-mismatched
        // Strength is a hard exclusion (mirrors the "Strength differs ->
        // New Medicine" rule used everywhere else -- a strength-mismatched
        // record is never a useful suggestion).
        _fuzzyMatchCandidates(rawQuery, tablets) {
            if (!rawQuery || !tablets || tablets.length === 0) return [];

            let processed = rawQuery.toUpperCase().trim();
            processed = processed.replace(/\b(PCM|APAP|PARA)\b/g, "PARACETAMOL");
            processed = processed.replace(/\bPAN\b/g, "PANTOPRAZOLE");
            processed = processed.replace(/\b(MDI|MD|METERED\s+DOSE)\b/g, "INHALER");
            const qLower = processed.toLowerCase();

            const extractStrength = (str) => {
                const m = str.match(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|%)\b/i);
                return m ? m[0].toLowerCase().replace(/\s+/g, "") : null;
            };
            const qStrength = extractStrength(qLower);

            const DOSAGE_FORMS = ["tablet", "tablets", "capsule", "capsules", "syrup", "syp", "injection", "inj", "drop", "drops", "cream", "gel", "ointment", "spray", "suspension", "susp", "solution", "powder", "respule", "respules", "rotacap", "rotacaps"];
            const GENERIC_WORDS = new Set(["gel", "tab", "tabs", "cap", "caps", "syrup", "syp", "inj", "injection", "drop", "drops", "cream", "spray", "susp", "suspension", "solution", "lotion", "powder", "ointment", "plus", "forte", "extra", "tablet", "capsule", "oral", "inhaler", "rotocap", "respule"]);
            const qForm = DOSAGE_FORMS.find(f => qLower.includes(f));
            const qWords = qLower.split(/[^a-z]+/i).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));

            const scored = [];
            tablets.forEach(t => {
                const tNameLower = (t.name || "").toLowerCase().trim();
                const tCodeLower = (t.code || "").toLowerCase().trim();
                const tDrugLower = (t.drugName || "").toLowerCase().trim();
                const tBrandLower = (t.brand || "").toLowerCase().trim();
                const tMfgLower = (t.manufacturer || "").toLowerCase().trim();
                const tPackLower = (t.pack || "").toLowerCase().trim();

                if (tNameLower === qLower || tCodeLower === qLower || tDrugLower === qLower) {
                    scored.push({ tablet: t, score: 100 });
                    return;
                }

                const tStrength = extractStrength(tNameLower) || (t.strength ? t.strength.toLowerCase().replace(/\s+/g, "") : null);
                if (qStrength && tStrength && qStrength !== tStrength) return;

                let score = 0;
                if (tBrandLower && (tBrandLower.includes(qLower) || qLower.includes(tBrandLower))) score = 60;
                if (tNameLower && (tNameLower.includes(qLower) || qLower.includes(tNameLower))) score = Math.max(score, 60);

                const tWords = (tNameLower + " " + tDrugLower + " " + tCodeLower)
                    .split(/[^a-z]+/i).filter(w => w.length >= 3 && !GENERIC_WORDS.has(w));
                let matchedCount = 0;
                let maxWordScore = 0;
                for (const qw of qWords) {
                    let bestForThisWord = 0;
                    for (const tw of tWords) {
                        if (tw === qw) { bestForThisWord = 95; break; }
                        const wScore = this.calculateLevenshteinDistance(qw, tw);
                        if (wScore >= 80) bestForThisWord = Math.max(bestForThisWord, wScore);
                    }
                    if (bestForThisWord > 0) { matchedCount++; maxWordScore = Math.max(maxWordScore, bestForThisWord); }
                }
                const wordsRequirementMet = matchedCount > 0 && !(qWords.length >= 2 && matchedCount < Math.ceil(qWords.length * 0.5));
                if (wordsRequirementMet) score = Math.max(score, maxWordScore);

                if (score === 0) return;

                // Ranking bonuses only -- never enough alone to create a match.
                if (qStrength && tStrength && qStrength === tStrength) score += 15;
                const tForm = DOSAGE_FORMS.find(f => (t.category || "").toLowerCase().includes(f) || tNameLower.includes(f));
                if (qForm && tForm && qForm === tForm) score += 10;
                if (tMfgLower && qLower.includes(tMfgLower)) score += 5;
                if (tPackLower && qLower.includes(tPackLower)) score += 3;

                scored.push({ tablet: t, score: Math.min(100, score) });
            });

            scored.sort((a, b) => b.score - a.score);
            return scored.filter(s => s.score >= 40).map(s => ({ ...s.tablet, matchScore: s.score }));
        }

        // Fast, index-backed lookup by exact Product Code -- used wherever
        // the app already has a code and just needs the record (Step 1 of
        // the matching cascade: "Match by Product Code if available").
        getTabletByCode(code) {
            if (!code) return null;
            return this.getIndexes().byCode.get(code) || null;
        }

        // Builds a brand-new Master Data record from scratch (no existing
        // family to clone from) for a genuinely unmatched Brand/Strength/
        // Dosage Form. Used when Supplier Bill Processing needs to create a
        // permanent record silently (a bill implies an actual purchase, so
        // "New Medicine" here means create-and-continue, not a temp stub).
        createNewMedicineFromScratch(rawName, rawPack) {
            const category = this.detectCategoryFromName(rawName, rawPack);
            const packSize = this.parsePackSize(rawPack, rawName);
            const packNumber = this.extractPackNumber(rawPack, rawName) || packSize.tabsPerStrip || 10;
            const code = this.generateProductCode(rawName, packNumber, category);
            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

            return {
                code,
                name: rawName.trim(),
                brand: this.getBrandFromName(rawName),
                drugName: "",
                category,
                pack: (rawPack || `${packNumber}'s`).toString().trim(),
                stock: 0,
                reorder: 0,
                cost: 0,
                mrp: 0,
                batches: [],
                tabsPerStrip: packSize.tabsPerStrip,
                stripsPerBox: packSize.stripsPerBox,
                unitsPerBox: packSize.totalTablets,
                totalTablets: packSize.totalTablets,
                importedOn: nowStr,
                _v: 0
            };
        }

        // Clones an existing Master Data record into a new Pack Size variant.
        // Everything except Pack Size (and the Pack Size portion of the code)
        // stays identical. New variants start with zero stock/batches — the
        // catalog entry is created automatically, stock arrives normally via
        // a supplier bill or manual entry afterwards.
        createPackSizeVariant(baseTablet, rawPack) {
            const packSize = this.parsePackSize(rawPack, baseTablet.name);
            const packNumber = this.extractPackNumber(rawPack, baseTablet.name) || packSize.tabsPerStrip;
            const newCode = this.generateProductCode(baseTablet.name, packNumber, baseTablet.category);
            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

            return {
                ...baseTablet,
                code: newCode,
                pack: (rawPack || baseTablet.pack).toString().trim(),
                stock: 0,
                batches: [],
                importedOn: nowStr,
                tabsPerStrip: packSize.tabsPerStrip,
                stripsPerBox: packSize.stripsPerBox,
                unitsPerBox: packSize.totalTablets,
                totalTablets: packSize.totalTablets,
                _v: 0
            };
        }

        // Persists an auto-created Pack Size variant into Master Data
        // immediately (synchronously) so later lookups in the same workflow
        // find it by code right away.
        persistNewMedicine(newTablet) {
            const tablets = this.getTablets();
            if (tablets.some(t => t.code === newTablet.code)) return tablets;
            tablets.push(newTablet);
            this.setTablets(tablets);
            this.logHistory("Inventory Updated", newTablet.name, "—", 0,
                `Auto-created new Pack Size variant (${newTablet.pack}) — Code: ${newTablet.code}`);
            return tablets;
        }

        isTabletNew(tab) {
            if (!tab.importedOn) return false;
            
            const importDate = new Date(tab.importedOn.replace(' ', 'T'));
            if (isNaN(importDate.getTime())) return false;
            
            const today = new Date();
            const diffTime = Math.abs(today - importDate);
            const diffDays = diffTime / (1000 * 60 * 60 * 24);
            
            return diffDays <= 2;
        }

        getBrandFromName(name) {
            if (!name) return "Generic";
            const brandWords = ["USV L.", "USV", "PHAR", "LUPIN", "GRAN", "REDD", "UNJOINT", "AVEN", "SUN P", "SUN", "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", "GLEN", "MICR", "ALLE", "NOVA", "ANGL", "GERM", "SUNW", "LINK", "CIPLA", "MSD", "RANB", "MANO"];
            const upper = name.toUpperCase();
            for (const b of brandWords) {
                if (upper.startsWith(b)) {
                    return b;
                }
            }
            return "Generic";
        }

        // Extracts the MEDICINE's own brand word (e.g. "ROSEVAST"), as
        // distinct from getBrandFromName() above which detects the
        // manufacturer/distributor (e.g. "USV"). Strips manufacturer
        // prefixes first, then takes the first remaining word. This is the
        // single source of truth for "Brand Name" comparisons in the
        // matching cascade below, and mirrors the prefix list used by
        // generateProductCode() so brand grouping stays consistent with the
        // Brand Code Registry.
        extractProductBrandWord(name) {
            if (!name) return "";
            let cleanName = name.trim().toUpperCase();
            const prefixes = ["USV L.", "USV", "PHAR", "LUPIN", "GRAN", "REDD", "UNJOINT", "AVEN", "SUN P", "SUN", "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", "GLEN", "MICR", "ALLE", "NOVA", "ANGL", "GERM", "SUNW", "LINK", "CIPLA", "MSD", "RANB", "MANO", "CADILA", "ABBOTT", "ALKEM", "TORRENT", "ZYDUS", "SANOFI", "GLAXO", "GSK", "PFIZER", "DR.REDDY", "DR.REDDY'S"];
            for (const p of prefixes) {
                if (cleanName.startsWith(p + " ")) {
                    cleanName = cleanName.substring(p.length + 1).trim();
                }
            }
            return cleanName.split(/[\s\-\.\/\+]+/)[0].replace(/[^A-Z]/g, "");
        }

        // Import the parsed bill items
        importExtractedBill() {
            if (!this.currentExtractedBill) return;

            const supplierInputVal = document.getElementById("ext-supplier").value.trim();
            const invoiceNoInputVal = document.getElementById("ext-invoice-no").value.trim();
            const invoiceDateInputVal = document.getElementById("ext-invoice-date").value.trim();

            if (!supplierInputVal || !invoiceNoInputVal || !invoiceDateInputVal) {
                this.showToast("Invoice header details are required.", "error");
                return;
            }

            // Duplicate-invoice detection (cross-device, with a Skip/Update/
            // Cancel choice) happens once, at the actual commit point in
            // importExtractedBillResolved() below -- not here, so the user
            // isn't hard-blocked before even reaching that choice.
            const pendingQueue = [];
            let hasInvalidRows = false;

            tableRows.forEach((row, index) => {
                const nameInput = row.querySelector(".edit-item-name");
                if (!nameInput) return;
                const name = nameInput.value.trim();

                const codeInput = row.querySelector(".edit-item-code");
                let code = codeInput ? codeInput.value.trim().toUpperCase() : "";

                // Validate row fields first to make sure we don't resolve matches for invalid rows
                const batchInput = row.querySelector(".edit-item-batch");
                const expInput = row.querySelector(".edit-item-exp");
                const qtyInput = row.querySelector(".edit-item-qty");
                const mrpInput = row.querySelector(".edit-item-mrp");

                const batch = batchInput.value.trim();
                const exp = expInput.value.trim();
                const qtyValStr = qtyInput ? qtyInput.value.trim() : "";
                const mrp = mrpInput.value.trim();

                const expRegex = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/;
                const isValidExp = expRegex.test(exp);
                const isNumericQty = qtyValStr !== "" && !isNaN(parseFloat(qtyValStr)) && parseFloat(qtyValStr) > 0;
                const isValidMrp = mrp !== "" && !isNaN(parseFloat(mrp)) && parseFloat(mrp) > 0;
                const isValidBatch = batch.length > 0 && /[a-zA-Z0-9]/.test(batch);

                if (!isValidExp || !isNumericQty || !isValidMrp || !isValidBatch) {
                    const _failReasons = [];
                    if (!isValidBatch) _failReasons.push("Missing/invalid batch number");
                    if (!isValidExp)   _failReasons.push("Missing/invalid expiry date");
                    if (!isNumericQty) _failReasons.push("Missing/invalid quantity");
                    if (!isValidMrp)   _failReasons.push("Missing/invalid MRP");
                    this.triggerNotification(
                        "Bill Processing", "Supplier bill validation failure",
                        `🟠 Bill Row Validation Failure\nMedicine: ${name}\nIssues: ${_failReasons.join(", ")}\nBatch: ${batch || "—"}  Expiry: ${exp || "—"}  Qty: ${qtyValStr || "—"}  MRP: ${mrp || "—"}`,
                        "Warning", { medicineName: name, invoiceNo: invoiceNoInputVal }
                    );
                    row.classList.add("expiring-orange-glow");
                    hasInvalidRows = true;
                    return;
                }
                row.classList.remove("expiring-orange-glow");

                // Confidence-based gate (separate from the structural check
                // above): a row can pass batch/exp/qty/MRP completeness yet
                // still carry a low confidence_score from a weak strength
                // reading or an uncertain medicine match -- that row shows a
                // "Manual Review" badge in the UI, but until this check
                // nothing here actually stopped it from being imported
                // anyway.
                const rowConfidence = row.dataset.confidence ? parseInt(row.dataset.confidence) : null;
                if (rowConfidence === null || isNaN(rowConfidence) || rowConfidence < 90) {
                    this.triggerNotification(
                        "Bill Processing", "Low confidence row blocked from import",
                        `🟠 Low Confidence Row\nMedicine: ${name}\nConfidence: ${rowConfidence !== null && !isNaN(rowConfidence) ? rowConfidence + "%" : "Unknown"}\nThis row must be manually reviewed and corrected before the invoice can be imported.`,
                        "Warning", { medicineName: name, invoiceNo: invoiceNoInputVal }
                    );
                    row.classList.add("expiring-orange-glow");
                    hasInvalidRows = true;
                    return;
                }

                // Check matches if not already resolved/selected
                if (!code) {
                    const matches = this.resolveMedicine(name, null, tablets, { includeCandidates: true }).candidates;
                    if (matches.length === 1) {
                        // Exact match rule -> set code immediately
                        const codeVal = matches[0].code;
                        const codeSelect = row.querySelector(".edit-item-code");
                        if (codeSelect) {
                            let opt = codeSelect.querySelector(`option[value="${codeVal}"]`);
                            if (!opt) {
                                opt = document.createElement("option");
                                opt.value = codeVal;
                                opt.textContent = `${matches[0].name} (${codeVal})`;
                                codeSelect.appendChild(opt);
                            }
                            codeSelect.value = codeVal;
                        }
                    } else {
                        // Zero matches -> Medicine Not Found; multiple -> Medicine Confirmation.
                        pendingQueue.push({
                            type: "bill",
                            rowElement: row,
                            name: name,
                            matches: matches
                        });
                    }
                }
            });

            if (hasInvalidRows) {
                this.showToast("Please correct manual review errors first.", "error");
                return;
            }

            if (pendingQueue.length > 0) {
                this.ocrMatchQueue = pendingQueue;
                this.ocrMatchQueueIndex = 0;
                this.showOcrMatchModal();
                return;
            }

            // No pending matches -> execute normal import!
            return this.importExtractedBillResolved();
        }

        // Pack Size / Strength / Brand mismatch detection between what the
        // supplier bill actually says (item) and the Master Data record it
        // resolved to (matched). Returns an array of human-readable reasons
        // (empty if nothing mismatches). Used to gate on an immediate
        // confirmation popup rather than silently accepting the item or
        // routing it to the Notification Center.
        detectBillItemMismatch(item, matched) {
            const reasons = [];
            const extractStrength = (str) => {
                const m = (str || "").match(/\b(\d+(\.\d+)?\s*(mg|mcg|ml|g|iu|%))/i);
                return m ? m[0].toLowerCase().replace(/\s+/g, "") : null;
            };
            const billStrength = extractStrength(item.name);
            const dbStrength = extractStrength(matched.name);
            if (billStrength && dbStrength && billStrength !== dbStrength) {
                reasons.push(`Strength mismatch: bill shows "${billStrength}", Master Data has "${dbStrength}"`);
            }

            // NOTE: Pack Size differences are intentionally NOT flagged here.
            // Per the simplified wholesale workflow, a Pack Size difference on
            // an otherwise-matching medicine means a new Pack Size variant,
            // created automatically with no popup (see resolveMedicine /
            // createPackSizeVariant). That's handled upstream in the import
            // gate, before this function is reached for such an item.

            const billBrand = (item.brand_name || "").toString().trim().toUpperCase();
            const dbBrand = (matched.brand || "").toString().trim().toUpperCase();
            if (billBrand && dbBrand && billBrand !== "GENERIC" && dbBrand !== "GENERIC" && billBrand !== dbBrand) {
                reasons.push(`Brand mismatch: bill shows "${item.brand_name}", Master Data has "${matched.brand}"`);
            }

            return reasons;
        }

        // Reveals the inline "Due qty" input next to a row's Qty field when
        // the "+ Due" button is clicked (Supplier Due capture at import time
        // -- see importExtractedBillResolved for where this value is read).
        toggleRowDueInput(btn) {
            const container = btn.closest(".edit-item-due-toggle");
            const dueInput = container ? container.querySelector(".edit-item-due-qty") : null;
            if (!dueInput) return;
            const showing = dueInput.style.display !== "none";
            dueInput.style.display = showing ? "none" : "block";
            btn.textContent = showing ? "+ Due" : "− Due";
            if (!showing) dueInput.focus();
            else dueInput.value = "";
        }

                async importExtractedBillResolved() {
            if (!this.currentExtractedBill) return;

            // Reset the per-import capture list -- allocateStockToReorders()
            // pushes into this as it links incoming stock to Reorder entries,
            // so we can record which Workflow IDs this Supplier Bill touched.
            this._pendingBillWorkflowIds = [];

            const supplierInputVal = document.getElementById("ext-supplier").value.trim();
            const invoiceNoInputVal = document.getElementById("ext-invoice-no").value.trim();
            const invoiceDateInputVal = document.getElementById("ext-invoice-date").value.trim();

            if (!supplierInputVal || !invoiceNoInputVal || !invoiceDateInputVal) {
                this.showToast("Invoice header details are required.", "error");
                return;
            }

            const existingBills = this.getBills();
            const localDuplicate = existingBills.find(b =>
                b.invoiceNo.trim().toUpperCase() === invoiceNoInputVal.trim().toUpperCase() &&
                (b.supplier || "").trim().toUpperCase() === supplierInputVal.trim().toUpperCase() &&
                (b.date || "") === invoiceDateInputVal
            );

            // Cross-device check: the local `ti_bills` blob is per-browser,
            // so a duplicate imported from a different device wouldn't show
            // up in existingBills above. Ask the live supplier_bills table,
            // which every device writes to, before deciding this is new.
            let remoteDuplicate = null;
            if (supabaseClient) {
                try {
                    const { data, error } = await supabaseClient
                        .from("supplier_bills")
                        .select("id, invoice_number, supplier_name, invoice_date, total_items")
                        .ilike("invoice_number", invoiceNoInputVal.trim())
                        .ilike("supplier_name", supplierInputVal.trim())
                        .eq("invoice_date", invoiceDateInputVal)
                        .maybeSingle();
                    if (error) console.warn("Duplicate-invoice check failed (continuing without cross-device check):", error.message);
                    else remoteDuplicate = data;
                } catch (err) {
                    console.warn("Duplicate-invoice check failed (continuing without cross-device check):", err);
                }
            }

            let duplicateResolution = "new"; // "new" | "update" | "skip" | "cancel"
            if (localDuplicate || remoteDuplicate) {
                const updateChosen = confirm(
                    `Duplicate Invoice Detected\n\nInvoice No: ${invoiceNoInputVal}\nSupplier: ${supplierInputVal}\nDate: ${invoiceDateInputVal}\n\nThis invoice already exists (found on ${localDuplicate ? "this device" : "another device"}).\n\nClick OK to UPDATE the existing record with these items.\nClick Cancel to choose Skip or fully cancel instead.`
                );
                if (updateChosen) {
                    duplicateResolution = "update";
                } else {
                    const skipChosen = confirm(
                        `Click OK to SKIP this import (existing record is kept unchanged).\nClick Cancel to fully CANCEL and go back to edit the invoice details.`
                    );
                    duplicateResolution = skipChosen ? "skip" : "cancel";
                }
            }

            if (duplicateResolution === "skip" || duplicateResolution === "cancel") {
                this.showToast(
                    duplicateResolution === "skip"
                        ? `Import skipped — existing record for Invoice "${invoiceNoInputVal}" was kept.`
                        : "Import cancelled.",
                    "info"
                );
                return;
            }

            const tableRows = document.querySelectorAll("#extracted-items-table-body tr");
            const compiledItems = [];
            const rowsToRemove = [];
            let invalidCount = 0;

            tableRows.forEach((row, index) => {
                const supplierInput = row.querySelector(".edit-item-supplier");
                const billdateInput = row.querySelector(".edit-item-billdate");
                const nameInput = row.querySelector(".edit-item-name");
                const brandInput = row.querySelector(".edit-item-brand");
                const drugInput = row.querySelector(".edit-item-drug");
                const batchInput = row.querySelector(".edit-item-batch");
                const expInput = row.querySelector(".edit-item-exp");
                const packInput = row.querySelector(".edit-item-pack");
                const qtyInput = row.querySelector(".edit-item-qty");
                const freeInput = row.querySelector(".edit-item-free");
                const discountInput = row.querySelector(".edit-item-discount");
                const costInput = row.querySelector(".edit-item-cost");
                const mrpInput = row.querySelector(".edit-item-mrp");
                const gstInput = row.querySelector(".edit-item-gst");

                if (!nameInput) return;

                const name = nameInput.value.trim();
                const supplier_name = supplierInput ? supplierInput.value.trim() : supplierInputVal;
                const bill_date = billdateInput ? billdateInput.value.trim() : invoiceDateInputVal;
                const brand_name = brandInput ? brandInput.value.trim() : "";
                const drug_name = drugInput ? drugInput.value.trim() : "";
                const pack = packInput ? packInput.value.trim() : "10's";
                const discount_percent = discountInput ? discountInput.value.trim() : "0%";
                const batch = batchInput.value.trim() !== "" ? batchInput.value.trim() : null;
                const exp = expInput.value.trim() !== "" ? expInput.value.trim() : null;
                
                const codeInput = row.querySelector(".edit-item-code");
                let code = codeInput ? codeInput.value.trim().toUpperCase() : "";

                const confidence = row.dataset.confidence ? parseInt(row.dataset.confidence) : null;
                const tablets = this.getTablets();
                const matchedTablet = code ? tablets.find(t => t.code === code) : this.resolveMedicine(name, null, tablets).tablet;
                
                if (!code && matchedTablet) {
                    code = matchedTablet.code;
                }

                // Parse quantity and unit
                const qtyValStr = qtyInput ? qtyInput.value.trim() : "";
                const freeValStr = freeInput ? freeInput.value.trim() : "0";
                const parsedQty = this.parseQtyAndUnit(qtyValStr, name, matchedTablet);
                const parsedFree = this.parseQtyAndUnit(freeValStr, name, matchedTablet);

                // Supplier Due capture: the "+ Due" input (hidden unless the
                // staff member toggles it) holds the shortfall quantity, in
                // the same unit as Qty. When present and > 0, only
                // (ordered - due) is written to inventory here -- the due
                // amount is recorded separately via create_supplier_due_atomic
                // below, never added to stock. ordered_qty is preserved
                // unmodified for the Supplier Due record even though
                // parsedQty.qty (used for inventory) is reduced.
                const dueQtyInput = row.querySelector(".edit-item-due-qty");
                const dueQtyRaw = dueQtyInput && dueQtyInput.value.trim() !== "" ? parseFloat(dueQtyInput.value) : 0;
                const orderedQty = parsedQty.qty;
                let dueQty = (dueQtyRaw > 0 && dueQtyRaw < orderedQty) ? dueQtyRaw : 0;
                if (dueQtyRaw >= orderedQty && dueQtyRaw > 0) {
                    // Guard against staff mistakenly entering a due qty >=
                    // the ordered qty (would mean "nothing was received" --
                    // that's a fully-missing line item, not a partial due,
                    // and this simple per-row capture isn't the right tool
                    // for it). Clamp to ordered-1 minus, and flag instead of
                    // silently accepting a value that would zero-or-negative
                    // the inventory add.
                    dueQty = orderedQty - 1 > 0 ? orderedQty - 1 : 0;
                    this.showToast(`Due qty for ${name} was reduced to stay below the ordered quantity — enter the fully-missing item separately if none of it arrived.`, "info");
                }
                if (dueQty > 0) {
                    parsedQty.qty = orderedQty - dueQty;
                }

                const mrp = mrpInput.value.trim() !== "" ? parseFloat(mrpInput.value) : null;
                const cost = (costInput && costInput.value.trim() !== "") ? parseFloat(costInput.value) : (mrp !== null ? mrp / 1.4 : null);
                const gst = gstInput.value.trim();

                const tempItem = { 
                    name, 
                    code, 
                    batch, 
                    exp, 
                    pack, 
                    qty: parsedQty.qty, 
                    qty_unit: parsedQty.unit,
                    free_qty: parsedFree.qty, 
                    free_unit: parsedFree.unit,
                    cost, 
                    mrp, 
                    gst, 
                    supplier_name, 
                    bill_date, 
                    _row: row,
                    brand_name, 
                    drug_name, 
                    discount_percent, 
                    confidence_score: confidence,
                    due_qty: dueQty,
                    ordered_qty: orderedQty
                };
                
                const expRegex = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/;
                const isValidExp = tempItem.exp !== null && tempItem.exp !== undefined && expRegex.test(tempItem.exp.trim());
                const isNumericQty = tempItem.qty !== null && tempItem.qty !== undefined && !isNaN(tempItem.qty) && tempItem.qty > 0;
                const isValidMrp = tempItem.mrp !== null && tempItem.mrp !== undefined && !isNaN(tempItem.mrp) && parseFloat(tempItem.mrp) > 0;
                const isValidBatch = tempItem.batch !== null && tempItem.batch !== undefined && tempItem.batch.trim().length > 0 && /[a-zA-Z0-9]/.test(tempItem.batch);

                if (!isValidExp || !isNumericQty || !isValidMrp || !isValidBatch) {
                    const _fr2 = [];
                    if (!isValidBatch) _fr2.push("Missing/invalid batch");
                    if (!isValidExp)   _fr2.push("Missing/invalid expiry");
                    if (!isNumericQty) _fr2.push("Invalid quantity");
                    if (!isValidMrp)   _fr2.push("Invalid MRP");
                    this.triggerNotification(
                        "Bill Processing", "Supplier bill validation failure",
                        `🟠 Bill Row Validation Failure\nMedicine: ${name}\nIssues: ${_fr2.join(", ")}`,
                        "Warning", { medicineName: name, invoiceNo: invoiceNoInputVal }
                    );
                    invalidCount++;
                    row.classList.add("expiring-orange-glow");
                    return;
                }

                row.classList.remove("expiring-orange-glow");
                compiledItems.push(tempItem);
                rowsToRemove.push(row);
                // High-value medicine alert for Bill Processing
                this.checkHighValueMedicineAlert(tempItem.name, tempItem.qty + " units", "Bill Processing", invoiceNoInputVal);
            });

            if (compiledItems.length === 0) {
                this.showToast("No valid items to import. Please correct manual review errors first.", "error");
                return;
            }

            // Hard gate before any inventory write happens: every item must
            // resolve to a Master Data record. Per the finalized matching
            // cascade (Brand -> Generic -> Strength -> Dosage Form -> Pack):
            //   - All agree -> Exact Match, resolved silently, no popup.
            //   - Brand/Strength/Dosage Form mismatch, but Generic Name or
            //     fuzzy candidates exist -> show the existing Medicine
            //     Confirmation popup (showOcrMatchModal), never auto-create.
            //   - No match of any kind -> Medicine Not Found modal; a new
            //     Master Data record is only created after the user
            //     explicitly clicks "Add New Medicine" and saves it.
            //   - Only a Pack Size difference -> Pack Size Confirmation popup.
            let tabletsForGate = this.getTablets();
            let codeIndex = new Map(tabletsForGate.map(t => [t.code, t]));
            const unresolvedGateQueue = [];
            compiledItems.forEach(item => {
                let alreadyResolved = !!(item.code && codeIndex.has(item.code));

                if (!alreadyResolved) {
                    const resolution = this.resolveMedicine(item.name, item.pack, tabletsForGate);

                    if (resolution.status === "exact") {
                        // Exact Match rule — resolve silently, no popup needed.
                        item.code = resolution.tablet.code;
                        alreadyResolved = true;
                    } else if (resolution.status === "new") {
                        // No Brand/Strength/Dosage Form match. Never silently
                        // create a duplicate -- route to the existing
                        // Medicine Confirmation popup with whatever Generic
                        // Name / fuzzy candidates resolveMedicine() already
                        // found (empty array falls through to the Medicine
                        // Not Found modal automatically). A new record is
                        // only ever created after explicit user confirmation.
                        unresolvedGateQueue.push({
                            type: "bill",
                            rowElement: item._row,
                            name: item.name,
                            matches: resolution.candidates
                        });
                        return;
                    } else if (resolution.status === "pack_confirm") {
                        // Pack Size is the ONLY difference -- and the ONLY
                        // case allowed to ask the user.
                        unresolvedGateQueue.push({
                            type: "bill-pack-confirm",
                            rowElement: item._row,
                            name: item.name,
                            existingTablet: resolution.tablet,
                            existingPack: resolution.existingPack,
                            scannedPack: resolution.scannedPack,
                            rawPack: item.pack
                        });
                        return;
                    } else {
                        // Fallback safety net (should be unreachable given
                        // the cascade above always returns one of the three
                        // statuses) -- still needs the user.
                        const gateMatches = this.resolveMedicine(item.name, null, tabletsForGate, { includeCandidates: true }).candidates;
                        unresolvedGateQueue.push({
                            type: "bill",
                            rowElement: item._row,
                            name: item.name,
                            matches: gateMatches
                        });
                        return;
                    }
                }
            });

            if (unresolvedGateQueue.length > 0) {
                this.ocrMatchQueue = unresolvedGateQueue;
                this.ocrMatchQueueIndex = 0;
                this.showOcrMatchModal();
                return;
            }

            try {
                // Begin atomic transaction and check database lock
                this.beginTransaction();

                let tablets = this.getTablets();
                let history = this.getHistory();
                let bills = this.getBills();
                
                const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
                let matchCount = 0;
                let newCount = 0;
                const skippedItems = [];

                const corrections = JSON.parse(localStorage.getItem("ti_ocr_corrections") || "{}");
                let correctionsUpdated = false;
                const pendingDueItems = [];

                compiledItems.forEach(item => {
                    let matched = null;
                    let targetCode = item.code;
                    if (item.code) {
                        matched = tablets.find(t => t.code === item.code);
                    }
                    if (matched) {
                        // Pack size mismatch check
                        // Pack size mismatch is silently accepted for now — no
                        // Notification Center entry, since normal workflow/matching
                        // events don't belong there per spec section 5. (If you want
                        // this surfaced to the user, it should be an inline warning
                        // in the bill review table, not a system notification.)
                        // Strength mismatch check
                        const _extractSt = (str) => { const m = str.match(/\b(\d+(\.\d+)?\s*(mg|mcg|ml|g|%))/i); return m ? m[0].toLowerCase().replace(/\s+/g, "") : null; };
                        const _billSt = _extractSt(item.name || "");
                        const _dbSt   = _extractSt(matched.name || "");
                        // Strength mismatch: same reasoning — no system notification,
                        // matching itself is unaffected.
                    }
                    
                    // Quantity calculation using calculateTotalUnits
                    const qtyUnitsObj = this.calculateTotalUnits(item.name, item.qty, item.pack, item.qty_unit, matched);
                    const freeUnitsObj = this.calculateTotalUnits(item.name, item.free_qty, item.pack, item.free_unit, matched);
                    
                    const totalQty = qtyUnitsObj.totalUnits + freeUnitsObj.totalUnits;
                    const remainingQty = this.allocateIncomingStock(matched ? matched.name : item.name, totalQty);

                    // Standardize cost per base unit
                    let costPerBaseUnit = item.cost;

                    if (matched) {
                        matched.gst = item.gst || matched.gst || "5%";
                        matched.mrp = item.mrp;
                        matched.cost = costPerBaseUnit;
                        
                        matched.batches = matched.batches || [];
                        const batchMatch = matched.batches.find(b => b.batchNumber === item.batch);
                        if (batchMatch) {
                            batchMatch.quantity += remainingQty;
                            batchMatch.mrp = item.mrp;
                            batchMatch.cost = costPerBaseUnit;
                            batchMatch.expiryDate = item.exp || batchMatch.expiryDate;
                        } else {
                            matched.batches.push({
                                batchNumber: item.batch || "BAT-999",
                                expiryDate: item.exp || "12/28",
                                quantity: remainingQty,
                                mrp: item.mrp,
                                cost: costPerBaseUnit
                            });
                        }
                        matched.stock = matched.batches.reduce((sum, b) => sum + b.quantity, 0);
                        matchCount++;
                        targetCode = matched.code;

                        // Supplier Due capture: if this row's staff-entered
                        // "+ Due" quantity is set, only (ordered - due) was
                        // added to matched.stock above via item.qty already
                        // being reduced during row compilation -- this just
                        // records the shortfall itself. Collected here and
                        // created after this loop (create_supplier_due_atomic
                        // is async; this forEach is not).
                        if (item.due_qty && item.due_qty > 0) {
                            pendingDueItems.push({
                                p_supplier_name: supplierInputVal,
                                p_invoice_id: null, // filled in after the supplier_bills row is written, if available
                                p_invoice_number: invoiceNoInputVal,
                                p_product_code: matched.code,
                                p_medicine_name: matched.name,
                                p_strength: this.normalizeStrengthToken(matched.name) || null,
                                p_ordered_quantity: item.ordered_qty,
                                p_received_quantity: item.ordered_qty - item.due_qty,
                                p_unit: item.qty_unit || "strips",
                                p_reason: "Partial supply — invoice " + invoiceNoInputVal,
                                p_created_by: (this.currentUser && this.currentUser.name) || "Unknown"
                            });
                        }
                        
                        const tabsPerStrip = matched.tabsPerStrip || 10;
                        const category = matched.category || "Tablets & Capsules";
                        const qtyLogged = (category === "Tablets & Capsules" || category === "Rotacaps") 
                            ? Math.round(totalQty / tabsPerStrip) 
                            : Math.round(totalQty);
                        
                        const allocatedPacks = (category === "Tablets & Capsules" || category === "Rotacaps")
                            ? Math.round((totalQty - remainingQty) / tabsPerStrip)
                            : Math.round(totalQty - remainingQty);

                        // Log standardized activity: Purchase Bill Uploaded
                        history.push({
                            datetime: nowStr,
                            type: "Purchase Bill Uploaded",
                            tabletName: matched.name,
                            batch: item.batch,
                            qty: qtyLogged,
                            details: `Uploaded supplier invoice ${invoiceNoInputVal} from ${supplierInputVal} (incl. ${item.free_qty || 0} free, Allocated ${allocatedPacks} packs to dues)`,
                            supplierName: supplierInputVal,
                            invoiceNumber: invoiceNoInputVal
                        });
                    } else {
                        // Should be unreachable: the gate before beginTransaction()
                        // already required every item to resolve to a real Master
                        // Data match (or stop and show Medicine Not Found /
                        // Medicine Confirmation). If this is ever hit anyway (e.g.
                        // the matched tablet was deleted mid-import by another
                        // user), skip the item rather than silently creating a
                        // new medicine — that decision must always be explicit.
                        skippedItems.push(item.name);
                        return;
                    }

                    // Update corrections
                    const cleanName = item.name.trim().toUpperCase();
                    if (cleanName && targetCode) {
                        corrections[cleanName] = targetCode;
                        correctionsUpdated = true;
                    }
                });

                if (correctionsUpdated) {
                    localStorage.setItem("ti_ocr_corrections", JSON.stringify(corrections));
                }

                // Save state updates — await cloud confirmation for the core
                // writes so a failed sync is reported immediately instead of
                // silently assumed. (Reorder/Due Order allocation inside
                // allocateIncomingStock() above still uses best-effort sync
                // with automatic retry, same as before.)
                const batchResult = await this.commitBatch([
                    { key: "ti_tablets", data: tablets, label: "Master Data / Tablets" },
                    { key: "ti_history", data: history, label: "Movement History" }
                ], "Bill Processing");
                
                // Save or Update bill record
                let existingBill = bills.find(b =>
                    b.invoiceNo === invoiceNoInputVal &&
                    (b.supplier || "") === supplierInputVal &&
                    (b.date || "") === invoiceDateInputVal
                );
                const batchCost = compiledItems.reduce((sum, item) => sum + (item.qty * item.cost), 0);
                const remarksEl = document.getElementById("ext-remarks") || document.getElementById("bill-manual-remarks");
                const billRemarks = remarksEl ? remarksEl.value : "";
                
                // Keep history of OCR results and extracted medicines
                const rawOcrText = this.currentExtractedBillOcrText || "";
                
                if (existingBill) {
                    if (duplicateResolution === "update") {
                        // Replace, don't accumulate -- this is a re-import of
                        // the same invoice, not additional new items.
                        existingBill.itemsCount = compiledItems.length;
                        existingBill.totalCost = batchCost;
                        existingBill.items = compiledItems;
                    } else {
                        existingBill.itemsCount += compiledItems.length;
                        existingBill.totalCost += batchCost;
                        existingBill.items = existingBill.items || [];
                        existingBill.items.push(...compiledItems);
                    }
                    existingBill.remarks = billRemarks || existingBill.remarks || "";
                    existingBill.rawOcrText = rawOcrText || existingBill.rawOcrText || "";
                    existingBill.matchedWorkflowIds = Array.from(new Set([...(existingBill.matchedWorkflowIds || []), ...(this._pendingBillWorkflowIds || [])]));
                } else {
                    bills.push({
                        invoiceNo: invoiceNoInputVal,
                        supplier: supplierInputVal,
                        date: invoiceDateInputVal,
                        itemsCount: compiledItems.length,
                        totalCost: batchCost,
                        remarks: billRemarks,
                        rawOcrText: rawOcrText,
                        items: compiledItems,
                        status: "Processed",
                        importedOn: nowStr,
                        matchedWorkflowIds: this._pendingBillWorkflowIds || []
                    });
                }

                // Supplier Bill Processing -> Match Workflow IDs wherever
                // applicable and store Invoice Number / Supplier / Purchase
                // Date against each linked workflow.
                (this._pendingBillWorkflowIds || []).forEach(wfId => {
                    this.logWorkflowEvent(wfId, "Supplier Bill Imported", "Supplier Bill Processing",
                        `Invoice ${invoiceNoInputVal} from ${supplierInputVal} (dated ${invoiceDateInputVal}) matched against this workflow's Reorder.`);
                });
                this._pendingBillWorkflowIds = [];
                const billSyncResult = await this.saveWithCloudConfirmation("ti_bills", bills, "Bill Processing", "Bills");
                this.logAudit("Bill Processing", "Import Bill", null, { invoiceNo: invoiceNoInputVal, supplier: supplierInputVal, itemsCount: compiledItems.length }, invoiceNoInputVal);
                syncInvoiceItemsRows(compiledItems, { invoiceNo: invoiceNoInputVal, supplier: supplierInputVal, date: invoiceDateInputVal });

                // Supplier Due creation -- best-effort, after the core
                // inventory/bill commit above has already succeeded.
                // Deliberately NOT inside the same try that guards inventory
                // correctness: a Due-record failure must never roll back or
                // block the actual stock update, since matched.stock above
                // already correctly reflects only the received quantity
                // regardless of whether this succeeds. Surfaced as a warning
                // toast + notification rather than silently swallowed.
                if (pendingDueItems.length > 0) {
                    if (!supabaseClient) {
                        this.triggerNotification("Supplier Due", "Due not recorded — offline",
                            `${pendingDueItems.length} short-supplied item(s) from invoice ${invoiceNoInputVal} were NOT recorded as Supplier Due because the app is not connected to the cloud database. Record them manually once connected.`,
                            "Warning", { invoiceNo: invoiceNoInputVal });
                    } else {
                        const dueFailures = [];
                        for (const dueParams of pendingDueItems) {
                            try {
                                const { error: dueErr } = await supabaseClient.rpc("create_supplier_due_atomic", dueParams);
                                if (dueErr) dueFailures.push(`${dueParams.p_medicine_name}: ${dueErr.message}`);
                            } catch (dueCallErr) {
                                dueFailures.push(`${dueParams.p_medicine_name}: ${dueCallErr.message || dueCallErr}`);
                            }
                        }
                        if (dueFailures.length > 0) {
                            this.triggerNotification("Supplier Due", "Some Due records failed to save",
                                `${dueFailures.length} of ${pendingDueItems.length} Supplier Due record(s) from invoice ${invoiceNoInputVal} failed to save:\n${dueFailures.join("\n")}\nInventory was still updated correctly for the received quantities -- only the Due tracking record failed. Re-enter these manually in Supplier Due.`,
                                "Critical", { invoiceNo: invoiceNoInputVal });
                        }
                    }
                }

                // Commit transaction and clear locks
                this.commitTransaction();

                // Remove successfully imported rows from UI table
                rowsToRemove.forEach(row => row.remove());

                this.renderDashboard();
                this.renderTabletList(); // Immediately refresh Master Data
                this.renderProcessedBillsTable();

                const allCloudOk = batchResult.allCloudOk && (billSyncResult.cloudOk || billSyncResult.reason === "not_configured");
                if (!allCloudOk && supabaseClient) {
                    this.showToast("Bill imported. Some data is still syncing to the cloud and will retry automatically.", "warning");
                }

                if (invalidCount > 0) {
                    this.showToast(`Imported ${compiledItems.length} valid items to inventory. ${invalidCount} items still need manual review.`, "warning");
                } else if (skippedItems.length > 0) {
                    this.showToast(`Imported ${matchCount} item(s). ${skippedItems.length} item(s) were skipped and NOT added — resolve them via Add New Medicine / Edit OCR Text before re-uploading: ${skippedItems.join(", ")}`, "warning");
                    this.resetBillOCR();
                } else {
                    this.showToast(`✅ All items imported and matched to existing Master Data (${matchCount} item(s)). No medicine was auto-created — every match was explicitly confirmed.`, "success");
                    this.resetBillOCR();
                    // Auto-navigate to Master Data so user sees imported products immediately
                    setTimeout(() => {
                        this.switchTab('master-view');
                    }, 800);
                }
            } catch (err) {
                // Rollback database modifications on exception
                this.rollbackTransaction();
                console.error("Bill import transaction rolled back:", err);
                const _isNetworkErr = err.message && (err.message.includes("fetch") || err.message.includes("Failed to") || err.message.toLowerCase().includes("network") || err.message.toLowerCase().includes("timeout"));
                this.triggerNotification(
                    "Bill Processing", _isNetworkErr ? "Network failure" : "System exception",
                    (_isNetworkErr ? "Network Failure During Bill Import\n" : "Bill Import Exception\n") + "Error: " + err.message + "\nTransaction rolled back. All partial changes undone.",
                    "Critical", { stackTrace: err.stack }
                );
                this.showToast(`Bill Import Failed: ${err.message}`, "error");
            }
        }

        resetBillOCR() {
            this.currentExtractedBill = null;
            document.getElementById("extracted-invoice-details").classList.add("hidden");
            document.getElementById("ocr-status-container").classList.add("hidden");
            document.getElementById("scanner-canvas").classList.add("hidden");
            document.getElementById("scanner-empty-state").classList.remove("hidden");
            
            const badge = document.getElementById("ocr-badge-status");
            badge.className = "status-badge badge-warning";
            badge.textContent = "Waiting for file";

            const laser = document.querySelector(".scan-line");
            if (laser) laser.style.display = "none";

            // Disable verify button
            document.getElementById("btn-import-bill")?.setAttribute("disabled", "true");

            // Hide summary card
            document.getElementById("ocr-summary-card")?.classList.add("hidden");
        }

        renderProcessedBillsTable() {
            const tableBody = document.getElementById("processed-bills-table-body");
            if (!tableBody) return;

            const bills = this.getBills();
            tableBody.innerHTML = "";

            if (bills.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">No invoices processed yet.</td></tr>`;
                return;
            }

            // Sort latest imported first
            [...bills].reverse().forEach(bill => {
                const tr = document.createElement("tr");
                // bill.invoiceNo / bill.supplier can be raw OCR text
                // (validatedData.invoice_number / supplier_name from Gemini) --
                // escape before innerHTML.
                tr.innerHTML = `
                    <td><strong>${this.escapeHtml(bill.invoiceNo)}</strong></td>
                    <td>${this.escapeHtml(bill.supplier)}</td>
                    <td>${bill.date}</td>
                    <td>${bill.itemsCount} items</td>
                    <td>₹${bill.totalCost.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                    <td>${this.escapeHtml(bill.remarks || "-")}</td>
                    <td><span class="status-badge badge-success">${bill.status}</span></td>
                    <td>${bill.importedOn}</td>
                `;
                tableBody.appendChild(tr);
            });
        }


        // --- ORDER PROCESSING & VERIFICATION ---
        switchOrderSubTab(type) {
            // Remove active class from all order subtab buttons
            document.querySelectorAll("#order-view .sub-tab-bar .sub-tab-btn").forEach(btn => {
                btn.classList.remove("active");
            });
            const activeBtn = document.getElementById(`order-subtab-btn-${type}`);
            if (activeBtn) activeBtn.classList.add("active");

            // Remove active class from all order subtab contents
            document.querySelectorAll("#order-view .subtab-content").forEach(content => {
                content.classList.remove("active");
            });
            const activeContent = document.getElementById(`order-subtab-${type}`);
            if (activeContent) activeContent.classList.add("active");

            if (type === "history") {
                this.renderOrderHistoryTable();
            }
        }

        // Duplicate-request guard: a double-click (or re-uploading before the
        // first scan finished) used to fire a second, fully redundant OCR
        // call in parallel with the first -- the same class of bug already
        // fixed for Supplier Bill (see runStagedOCRScan). Real work is
        // unchanged, still in _triggerOrderOCRScanInner below.
        async triggerOrderOCRScan(file, isSample = false) {
            if (this._orderOcrInFlight) {
                this.showToast("An order sheet scan is already in progress — please wait for it to finish.", "info");
                return;
            }
            this._orderOcrInFlight = true;
            try {
                return await this._triggerOrderOCRScanInner(file, isSample);
            } finally {
                this._orderOcrInFlight = false;
            }
        }

        async _triggerOrderOCRScanInner(file, isSample = false) {
            this.bumpOcrStat("orderPagesUploaded");
            this.bumpOcrStat("pendingFiles", 1);
            const _orderOcrStartTime = performance.now();
            const ocrStatus = document.getElementById("order-ocr-status-container");
            const ocrProgress = document.getElementById("order-ocr-progress");
            const ocrStatusText = document.getElementById("order-ocr-status-text");
            const visualizerBox = document.getElementById("order-scanner-visualizer-box");
            const canvas = document.getElementById("order-scanner-canvas");

            if (ocrStatus) ocrStatus.classList.remove("hidden");
            if (ocrProgress) ocrProgress.style.width = "5%";
            if (ocrStatusText) ocrStatusText.textContent = "Preparing order scanner...";
            if (visualizerBox) visualizerBox.classList.remove("hidden");

            // Show scanning laser line inside order scanner visualizer box
            let laser = visualizerBox.querySelector(".scan-line");
            if (!laser) {
                laser = document.createElement("div");
                laser.className = "scan-line";
                visualizerBox.appendChild(laser);
            }
            laser.style.display = "block";

            const nameLower = (file && file.name || "").toLowerCase();
            const isOfflineSample = isSample || nameLower.includes("sample_order_sheet") || nameLower.includes("1782474664670");

            // If it is a sample order image simulation
            if (isOfflineSample) {
                // If there's an actual file object, draw it on the canvas for realism!
                if (file) {
                    const ctx = canvas.getContext("2d");
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        const img = new Image();
                        img.onload = () => {
                            canvas.width = 600;
                            canvas.height = 300;
                            ctx.clearRect(0, 0, canvas.width, canvas.height);
                            const ratio = Math.min(canvas.width / img.width, canvas.height / img.height);
                            const x = (canvas.width - img.width * ratio) / 2;
                            const y = (canvas.height - img.height * ratio) / 2;
                            ctx.drawImage(img, 0, 0, img.width, img.height, x, y, img.width * ratio, img.height * ratio);
                        };
                        img.src = e.target.result;
                    };
                    reader.readAsDataURL(file);
                } else {
                    // Draw mockup text on order scanner canvas
                    const ctx = canvas.getContext("2d");
                    canvas.width = 400;
                    canvas.height = 200;
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, 400, 200);
                    ctx.fillStyle = "#1e293b";
                    ctx.font = "bold 14px Outfit";
                    ctx.fillText("RBI KILPAUK MEDICALS", 120, 30);
                    ctx.font = "bold 10px Outfit";
                    ctx.fillText("Order List - ORD-2026-055", 130, 50);
                    ctx.font = "9px monospace";
                    ctx.fillText("1. L. ROSEDAY 20MG  -  60 packs", 80, 80);
                    ctx.fillText("2. RENERVE PLUS     - 100 packs", 80, 100);
                    ctx.fillText("3. L. TAZLOC 40MG   - 250 packs", 80, 120);
                    ctx.fillText("4. GLYCOMET FORTE 850 - 45 packs", 80, 140);
                }

                let progress = 0;
                const interval = setInterval(() => {
                    progress += 10;
                    if (ocrProgress) ocrProgress.style.width = `${progress}%`;
                    if (ocrStatusText) ocrStatusText.textContent = `Scanning sample order sheet... (${progress}%)`;
                    
                    if (progress >= 100) {
                        clearInterval(interval);
                        laser.style.display = "none";
                        if (ocrStatus) ocrStatus.classList.add("hidden");
                        if (visualizerBox) visualizerBox.classList.add("hidden");
                        
                        // Populate with sample items
                        const sampleItems = [
                            { medicine_name: "USV L. ROSEDAY 20MG", quantity: 60 },
                            { medicine_name: "GRAN RENERVE PLUS", quantity: 100 },
                            { medicine_name: "USV L. TAZLOC 40MG", quantity: 250 },
                            { medicine_name: "GLYCOMET FORTE 850MG", quantity: 45 }
                        ];
                        this.populateOrderBuilder(sampleItems);
                        this.showToast("Sample paper order scanned successfully!", "success");
                    }
                }, 200);
                return;
            }

            if (!file) return;

            // Render uploaded file on canvas
            const ctx = canvas.getContext("2d");
            
            const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
            if (isPdf) {
                // PDF Placeholder
                canvas.width = 600;
                canvas.height = 300;
                ctx.fillStyle = "#1e293b";
                ctx.fillRect(0, 0, 600, 300);
                ctx.fillStyle = "#38bdf8";
                ctx.font = "bold 20px Outfit";
                ctx.fillText("PDF Order Sheet Uploaded", 170, 130);
                ctx.font = "14px Outfit";
                ctx.fillStyle = "#94a3b8";
                ctx.fillText("Processing order sheet directly via Gemini...", 160, 170);

                if (ocrProgress) ocrProgress.style.width = "30%";
                if (ocrStatusText) ocrStatusText.textContent = "AI OCR processing PDF order sheet...";

                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const base64Data = e.target.result.split(',')[1];
                        const _cloudImageUploadPromise = this._uploadBillImageToCloud(base64Data, "application/pdf", file ? file.name : "order_sheet.pdf", "order_sheet").catch(() => null);

                        // Check the OCR cache first -- rescanning the exact
                        // same order sheet should be instant instead of
                        // re-calling Gemini (same pattern as Supplier Bill).
                        const fileHash = await this.computeFileHash(base64Data);
                        const orderCache = fileHash ? this.getOrderOcrCache() : null;
                        if (orderCache && orderCache[fileHash]) {
                            laser.style.display = "none";
                            if (ocrStatus) ocrStatus.classList.add("hidden");
                            if (visualizerBox) visualizerBox.classList.add("hidden");
                            const cachedItems = orderCache[fileHash].items;
                            this.populateOrderBuilder(cachedItems);
                            this.showToast(`This exact order sheet was scanned before — loaded ${cachedItems.length} item(s) instantly from cache.`, "success");
                            return;
                        }

                        const parsedData = await this.parseOrderSheet(base64Data, "application/pdf");
                        
                        laser.style.display = "none";
                        if (ocrStatus) ocrStatus.classList.add("hidden");
                        if (visualizerBox) visualizerBox.classList.add("hidden");

                        const itemsList = Array.isArray(parsedData) ? parsedData : (parsedData && parsedData.items);
                        if (itemsList && itemsList.length > 0) {
                            this.populateOrderBuilder(parsedData);
                            if (fileHash) this.setOrderOcrCache({ ...this.getOrderOcrCache(), [fileHash]: { items: itemsList, cachedOn: new Date().toISOString() } });
                            this.showToast(`Successfully extracted ${itemsList.length} order items from PDF!`, "success");
                            this.bumpOcrStat("ocrSuccess");
                            this.bumpOcrStat("pendingFiles", -1);
                            this.bumpOcrStat("medicinesExtracted", itemsList.length);
                            this.recordOcrTiming(Math.round(performance.now() - _orderOcrStartTime));
                            _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "success"));
                        } else {
                            this.showToast("No order items could be parsed from the PDF. You can retry, or use \"Paste Order Text\" to enter items manually.", "warning");
                            this.triggerNotification(
                                "Order Processing", "Order sheet validation failure",
                                `🟠 Order Sheet Validation Failure\nFile: ${file ? file.name : "unknown.pdf"}\nNo order items could be extracted from the PDF. Please try pasting the order text manually.`,
                                "Warning", { errorDetails: "Zero items returned from Gemini PDF order-sheet parse" }
                            );
                            this.bumpOcrStat("ocrFailed");
                            this.bumpOcrStat("pendingFiles", -1);
                            _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "failed"));
                        }
                    } catch (err) {
                        // PDF order sheets have no local OCR fallback available (Tesseract
                        // needs a rendered image, not raw PDF bytes, and no PDF-rendering
                        // library is bundled). Per spec, never auto-switch to Paste Order
                        // Text -- surface the failure, keep the image in memory, and let
                        // the user retry or switch tabs themselves.
                        console.error("Order PDF OCR scan failed:", err);
                        this.bumpOcrStat("ocrFailed");
                        this.bumpOcrStat("pendingFiles", -1);
                        _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "failed"));
                        laser.style.display = "none";
                        if (ocrStatus) ocrStatus.classList.add("hidden");
                        if (visualizerBox) visualizerBox.classList.add("hidden");
                        this.showToast(`PDF AI scan unavailable (${err.message}). You can retry, or use "Paste Order Text" to enter items manually.`, "warning");
                        this.triggerNotification(
                            "Order Processing", "Order sheet validation failure",
                            `🔴 Order Sheet Validation Failure\nFile: ${file ? file.name : "unknown.pdf"}\nError: ${err.message}\nNo local OCR fallback exists for PDF files. Please paste the order text manually in the "Paste Order Text" tab.`,
                            "Critical", { errorDetails: err.message, stackTrace: err.stack }
                        );
                    }
                };
                reader.readAsDataURL(file);
                return;
            }

            const _readStart = performance.now();
            const reader = new FileReader();
            reader.onload = (e) => {
                const _imageLoadMs = Math.round(performance.now() - _readStart);
                const img = new Image();
                img.onload = async () => {
                    // Fit image to canvas aspect ratio
                    canvas.width = 600;
                    canvas.height = 300;
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    
                    const ratio = Math.min(canvas.width / img.width, canvas.height / img.height);
                    const x = (canvas.width - img.width * ratio) / 2;
                    const y = (canvas.height - img.height * ratio) / 2;
                    ctx.drawImage(img, 0, 0, img.width, img.height, x, y, img.width * ratio, img.height * ratio);

                    // Start actual OCR with Gemini
                    if (ocrProgress) ocrProgress.style.width = "30%";
                    if (ocrStatusText) ocrStatusText.textContent = "AI OCR processing order sheet...";

                    const base64Data = e.target.result.split(',')[1];
                    const _cloudImageUploadPromise = this._uploadBillImageToCloud(base64Data, file ? file.type : "image/jpeg", file ? file.name : "order_sheet.jpg", "order_sheet").catch(() => null);

                    // Check the OCR cache first -- rescanning the exact same
                    // order sheet image should be instant instead of
                    // re-calling Gemini/Tesseract (same pattern as Supplier Bill).
                    const fileHash = await this.computeFileHash(base64Data);
                    const orderCache = fileHash ? this.getOrderOcrCache() : null;
                    if (orderCache && orderCache[fileHash]) {
                        laser.style.display = "none";
                        if (ocrStatus) ocrStatus.classList.add("hidden");
                        if (visualizerBox) visualizerBox.classList.add("hidden");
                        const cachedItems = orderCache[fileHash].items;
                        this.populateOrderBuilder(cachedItems);
                        this.showToast(`This exact order sheet was scanned before — loaded ${cachedItems.length} item(s) instantly from cache.`, "success");
                        return;
                    }

                    // --- Lean pipeline (mirrors Supplier Bill's parseSupplierBill) ---
                    // ONE Gemini Vision request (with its own internal high-demand
                    // retry/backoff + model fallback), JSON straight back. Local OCR /
                    // regex field parser / AI text parser are NOT part of this flow --
                    // they still exist for the manual "Paste Order Text" tab, but are
                    // never auto-chained here. Wrapped in a named function so "Retry
                    // Scan" can re-run the exact same pipeline against the SAME
                    // in-memory base64Data, without requiring a re-upload.
                    const attemptOrderScan = async () => {
                        const _pipelineStart = performance.now();
                        const diag = { geminiStatus: "SKIPPED", jsonRepair: "N/A", imageLoadMs: _imageLoadMs };

                        let parsedData = null;
                        const _geminiStart = performance.now();
                        try {
                            parsedData = await this.parseOrderSheet(base64Data, file.type, (progress) => {
                                if (!ocrStatusText) return;
                                if (progress.phase === "attempting" && progress.attempt === 1) {
                                    ocrStatusText.textContent = "AI OCR processing order sheet...";
                                } else if (progress.phase === "waiting" || progress.phase === "busy") {
                                    ocrStatusText.textContent = `Gemini is busy. Retrying... Attempt ${progress.attempt} of ${progress.total}`;
                                } else if (progress.phase === "attempting") {
                                    ocrStatusText.textContent = `Attempt ${progress.attempt} of ${progress.total}...`;
                                }
                            });
                            diag.geminiStatus = "PASS";
                            diag.jsonRepair = this._lastGeminiUsedJsonRepair ? "PASS (retried)" : "N/A";
                        } catch (err) {
                            diag.resizeMs = this._lastOcrResizeMs || 0;
                            diag.ocrTimeMs = Math.round(performance.now() - _geminiStart);
                            diag.geminiStatus = err.geminiErrorLabel || (err.isGeminiBusy ? "Service Busy" : "OCR Extraction Failed");
                            diag.jsonRepair = this._lastGeminiUsedJsonRepair ? "FAIL" : "N/A";
                            diag.matched = 0;
                            diag.manualReview = 0;
                            diag.totalTimeMs = Math.round(performance.now() - _pipelineStart);
                            if (err.retryLog && err.retryLog.length) {
                                diag.retryLog = err.retryLog;
                                console.log("[Gemini OCR] Retry diagnostics:\n" + err.retryLog.map(r => `  Attempt ${r.attempt} (${r.model}): ${r.status}`).join("\n"));
                            }
                            this.renderOcrDiagnostics(diag);

                            if (err.isGeminiBusy) {
                                // High demand, NOT an OCR failure: no Critical Alert,
                                // no auto-switch to Paste Order Text. Image stays
                                // loaded (base64Data is still in memory) and the
                                // user gets an explicit Retry/Cancel choice.
                                console.warn("Order sheet AI OCR: Gemini is temporarily busy after all retries:", err);
                                laser.style.display = "none";
                                if (ocrStatus) ocrStatus.classList.add("hidden");
                                if (visualizerBox) visualizerBox.classList.add("hidden");
                                this.triggerNotification(
                                    "Order Processing", "Gemini Vision temporarily busy",
                                    `🟡 Gemini Vision Temporarily Busy\nFile: ${file ? file.name : "unknown"}\nAll retry attempts hit high demand. Your image is still loaded — you can retry the scan.`,
                                    "Warning", { errorDetails: "Gemini Vision high demand (429/503) after retries + model fallback" }
                                );
                                const anchorEl = ocrStatus || laser;
                                this.showGeminiBusyBanner(anchorEl, () => {
                                    if (ocrStatus) ocrStatus.classList.remove("hidden");
                                    if (ocrStatusText) ocrStatusText.textContent = "Retrying AI OCR scan...";
                                    laser.style.display = "";
                                    attemptOrderScan();
                                }, () => {
                                    this.switchOrderSubTab('text');
                                });
                                return;
                            }

                            // Genuine failure (auth, decode, network, unsupported
                            // file, invalid JSON after repair, etc) -- unchanged
                            // Critical Alert + auto-switch to Paste Order Text.
                            console.error("Order sheet AI OCR failed (single-request pipeline, no local fallback):", err);
                            this.bumpOcrStat("ocrFailed");
                            this.bumpOcrStat("pendingFiles", -1);
                            _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "failed"));
                            laser.style.display = "none";
                            if (ocrStatus) ocrStatus.classList.add("hidden");
                            if (visualizerBox) visualizerBox.classList.add("hidden");
                            this.showToast(`AI scan unavailable (${err.message}). You can retry, or use "Paste Order Text" to enter items manually.`, "warning");
                            this.triggerNotification(
                                "Order Processing", "Order sheet validation failure",
                                `🔴 Order Sheet Validation Failure\nFile: ${file ? file.name : "unknown"}\nError: ${err.message}\nGemini Vision request failed (and its one JSON-repair retry, if triggered). You can retry the scan, or paste the order text manually in the "Paste Order Text" tab.`,
                                "Critical", { errorDetails: err.message, stackTrace: err.stack }
                            );
                            return;
                        }
                        diag.resizeMs = this._lastOcrResizeMs || 0;
                        // This is the number that actually matters for the "why did this
                        // take 5 minutes" question: it isolates the raw Gemini round-trip
                        // (network + model inference) from image decode/resize/parsing, so
                        // a slow scan can be blamed on the right stage instead of guessed at.
                        diag.geminiRequestMs = Math.round(performance.now() - _geminiStart) - diag.resizeMs;
                        diag.ocrTimeMs = Math.round(performance.now() - _geminiStart);
                        console.log(`[Timing] Gemini OCR (order sheet): ${diag.ocrTimeMs}ms`);

                        let itemsList = Array.isArray(parsedData) ? parsedData : (parsedData && parsedData.items);

                        laser.style.display = "none";
                        if (ocrStatus) ocrStatus.classList.add("hidden");
                        if (visualizerBox) visualizerBox.classList.add("hidden");
                        this.hideGeminiBusyBanner();

                        if (itemsList && itemsList.length > 0) {
                            const _matchStart0 = performance.now();
                            this.populateOrderBuilder(parsedData);
                            diag.matchingMs = Math.round(performance.now() - _matchStart0);
                            if (fileHash) this.setOrderOcrCache({ ...this.getOrderOcrCache(), [fileHash]: { items: itemsList, cachedOn: new Date().toISOString() } });
                            diag.matched = itemsList.length;
                            diag.manualReview = 0;
                            diag.totalTimeMs = Math.round(performance.now() - _pipelineStart);
                            this.renderOcrDiagnostics(diag);
                            // Per-stage breakdown so a slow scan can be pinpointed to a
                            // single stage (e.g. "Gemini Request: 4.2s" vs "Image Resize: 280ms")
                            // instead of just seeing one opaque total.
                            console.log(
                                `[OCR]\n` +
                                `  Image Loaded:      ${diag.imageLoadMs}ms\n` +
                                `  Image Resize:       ${diag.resizeMs}ms\n` +
                                `  Gemini Request:      ${(diag.geminiRequestMs / 1000).toFixed(1)}s\n` +
                                `  JSON Repair:         ${diag.jsonRepair === "PASS (retried)" ? "retried" : "0"}ms\n` +
                                `  Medicine Matching:   ${diag.matchingMs}ms\n` +
                                `  TOTAL:               ${(diag.totalTimeMs / 1000).toFixed(1)}s`
                            );
                            this.showToast(`Successfully extracted ${itemsList.length} order items!`, "success");
                            this.bumpOcrStat("ocrSuccess");
                            this.bumpOcrStat("pendingFiles", -1);
                            this.bumpOcrStat("medicinesExtracted", itemsList.length);
                            this.recordOcrTiming(diag.totalTimeMs);
                            _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "success"));
                            return;
                        }

                        // Gemini succeeded but returned zero items -- no local fallback
                        // chain anymore; route straight to Paste Order Text.
                        this.bumpOcrStat("ocrFailed");
                        this.bumpOcrStat("pendingFiles", -1);
                        _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "failed"));
                        diag.matched = 0;
                        diag.manualReview = 0;
                        diag.totalTimeMs = Math.round(performance.now() - _pipelineStart);
                        this.renderOcrDiagnostics(diag);
                        this.showToast("No order items could be parsed from the image. You can retry, or use \"Paste Order Text\" to enter items manually.", "warning");
                        this.triggerNotification(
                            "Order Processing", "Order sheet validation failure",
                            `🟠 Order Sheet Validation Failure\nFile: ${file ? file.name : "unknown"}\nGemini Vision returned zero medicine rows for this image. Please try pasting the order text manually.`,
                            "Warning", { errorDetails: "Zero items returned from Gemini for image order-sheet parse" }
                        );
                    };

                    await attemptOrderScan();
                };
                img.onerror = () => {
                    laser.style.display = "none";
                    if (ocrStatus) ocrStatus.classList.add("hidden");
                    this.showToast("Failed to load order sheet image file.", "error");
                    this.triggerNotification(
                        "Order Processing", "Order sheet validation failure",
                        `🔴 Order Sheet Validation Failure\nFile: ${file ? file.name : "unknown"}\nThe image file could not be loaded/decoded. It may be corrupted or in an unsupported format.`,
                        "Critical", { errorDetails: "Image failed to load (img.onerror)" }
                    );
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        }

        async parseOrderSheet(base64Data, mimeType, onProgress) {
            const basePrompt = `Read ONLY the medicine order table in this image (rotate/tilt mentally as needed). Ignore GST, address, totals, footer, doctor, patient signatures, bank details, QR codes, page numbers, and any advertisements.

Also capture the Dispensary/Employee/Pensioner ID and Name if shown in the header (e.g. "49864M", "VEP-S1", "KARUNANITHI S P").

Medicine names may be printed as a BRAND name (e.g. "THYRONORM 75MCG TAB") OR as a generic/combination drug name (e.g. "N-ACETYL CYSTEINE 150+TAURINE 500 TABLET", "DIOSMIN 300MG TAB") -- extract exactly what is printed either way, do not assume it must be a brand.

CRITICAL -- extract EVERY row in the table, even ones you are unsure about. Never silently omit a row because you're not confident about it: extract it with your best reading and a LOW confidence score instead. A row with a low-confidence guess is far more useful than a missing row, since the user reviews every row before it's submitted.

CRITICAL -- Strength (the MG/MCG/ML/etc. number) is part of the medicine's identity, not an optional detail. Many brands are sold in multiple strengths of the exact same name (e.g. "ROSEDAY 10MG" vs "ROSEDAY 20MG" are different products) -- if you extract the name without its strength, the wrong product can be matched. So: read every digit of the strength carefully, even if it's in a smaller font or adjoining the name with no space (e.g. "ROSEDAY20MG"). Only leave strength empty if the row genuinely has no strength printed anywhere (rare -- true for some consumables/devices only).

For each medicine row return: medicine_name (WITHOUT the strength -- strength is returned separately below, so do not duplicate it inside medicine_name), strength (number only, e.g. "20" not "20mg"), unit (MG/MCG/G/ML/IU/%, default MG), dosage_form (TABLET/CAPSULE/ROTACAP/SYRUP/SUSPENSION/INJECTION/DROPS/GEL/CREAM/OINTMENT/LOTION/OIL/POWDER/TUBE/SPRAY/INHALER; default TABLET), pack (pack-size number only if printed, e.g. the "120" in "TAB 120'S" -- or null), quantity_tablets, and confidence: {"brand":0-100,"strength":0-100,"pack":0-100}. Confidence values should genuinely vary with how legible/certain each field was -- do not default everything to a high flat number; a blurry or ambiguous strength should score noticeably lower than a clearly printed one.

quantity_tablets is the plain final number printed on the line for that medicine (usually to the right of the row) -- it is ALREADY the total required count in dispensing units (tablets, capsules, vials, ampoules, bottles, whichever the dosage form is). Read that printed number directly. Do NOT calculate, multiply, or convert it -- there is no "X strips" or "X boxes" arithmetic to do here, even if a pack size like "10'S" or "120'S" also appears in the medicine name; that pack size is packaging info only and is NOT part of the quantity. If a row has no separate quantity number printed at all, use the leading count before the medicine name (e.g. "1 DIOSMIN 300MG TAB" -> that leading "1" is a line number, not the quantity -- in that case look for the actual quantity number printed elsewhere on the same line).

Return ONLY this JSON, no markdown, no explanation, no text before or after:
{
  "dispensary_id": "",
  "dispensary_name": "",
  "items": [
    { "medicine_name": "", "strength": "", "unit": "MG", "dosage_form": "TABLET", "pack": "", "quantity_tablets": 0, "confidence": { "brand": 0, "strength": 0, "pack": 0 } }
  ]
}`;

            // Priority 3.11 production integration: preprocess, then run
            // through automatic provider selection (Gemini primary, local
            // Tesseract fallback only on quota/timeout/service-busy/
            // offline). Gemini's own resize -> single call -> strict JSON
            // validation -> one retry on invalid JSON is untouched inside
            // runSharedGeminiVisionOCR; this only wraps it. Output is then
            // normalized via the SAME normalizeOCRResponse used before --
            // downstream business logic never changes.
            const _preStart = performance.now();
            const preprocessed = await this.preprocessImageForOCR(base64Data, mimeType);
            const preprocessingMs = Math.round(performance.now() - _preStart);

            const result = await this.recognizeWithProviderFallback(
                preprocessed.base64, preprocessed.mimeType, basePrompt, onProgress, "order", null, preprocessingMs
            );
            return this.normalizeOCRResponse(result.text, "order");
        }

        async parseOrderTextWithGemini(rawText) {
            const apiKey = localStorage.getItem("ti_ai_key");
            if (!apiKey) {
                throw new Error("Gemini API key is missing. Please configure it in the 'Bill Processing' tab.");
            }

            const prompt = `You are a pharmacy order text validation AI.
Extract:
1. The Dispensary ID or Employee/Pensioner ID if present in the header or lines (e.g., alphanumeric IDs like "49864M", "49512E", "VEP", "VEP-S1").
2. The Dispensary Name or Patient/Pensioner Name if present (e.g. "MALLIGA.S", "KARUNANITHI S P", "Vepary").
3. ALL medicine names and their ordered quantities from the raw text provided.

Return your response in JSON format matching this schema:
{
  "dispensary_id": "EXTRACTED_ID_OR_EMPTY",
  "dispensary_name": "EXTRACTED_NAME_OR_EMPTY",
  "items": [
    {
      "medicine_name": "CAPITALIZED MEDICINE NAME",
      "quantity": 10
    }
  ]
}

RAW ORDER TEXT:
${rawText}`;

            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
            const response = await this.fetchWithTimeout(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: prompt }
                            ]
                        }
                    ],
                    generationConfig: {
                        responseMimeType: "application/json"
                    }
                })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                const errMsg = errData.error?.message || `HTTP ${response.status}`;
                throw new Error(`Gemini Text API error: ${errMsg}`);
            }

            const result = await response.json();
            const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
            return this.parseGeminiJSON(jsonText);
        }

        async processManualTextOrder() {
            const textInput = document.getElementById("order-text-input");
            if (!textInput) return;
            const text = textInput.value.trim();
            if (!text) {
                this.showToast("Please paste or type order text first.", "error");
                return;
            }

            const apiKey = localStorage.getItem("ti_ai_key");
            if (apiKey) {
                this.showToast("AI parsing pasted order text...", "info");
                try {
                    const parsedItems = await this.parseOrderTextWithGemini(text);
                    if (parsedItems && parsedItems.length > 0) {
                        this.populateOrderBuilder(parsedItems);
                        this.showToast("AI parsed order text successfully!", "success");
                    } else {
                        this.showToast("AI could not extract items. Trying local regex parser...", "warning");
                        this.processManualTextOrderLocal(text);
                    }
                } catch (err) {
                    console.error("AI text parsing failed:", err);
                    this.showToast("AI parsing failed. Running local regex parser...", "warning");
                    this.processManualTextOrderLocal(text);
                }
            } else {
                this.showToast("No Gemini key found. Using local regex parser...", "warning");
                this.processManualTextOrderLocal(text);
            }
        }

        // --- FIELD-BASED LOCAL ORDER PARSER ---
        // Replaces the old single-regex line parser. No one pattern decides
        // pass/fail for a row -- Brand, Strength, Unit, Dosage Form, Pack,
        // and Quantity are each extracted independently by their own logic,
        // and a row is only flagged for Manual Review if a REQUIRED field
        // (Brand or Quantity) is missing. A bad row never drops the rest of
        // the sheet.

        // Extracts an ordered quantity from a line using several independent
        // strategies (not one regex): explicit "Qty:"/"X"/"packs" markers,
        // then a bare trailing number, then (if nothing on this line at all)
        // a paired bare-number line that follows immediately after it --
        // covers the "ROSEDAY 10MG\n30" split-line format.
        extractOrderQuantity(line, nextLineIfBare) {
            const explicit = line.match(/\b(?:QTY|QUANTITY)\s*[:\-]?\s*(\d+)\b/i);
            if (explicit) return { qty: parseInt(explicit[1], 10), matchedText: explicit[0], usedNextLine: false };

            const marked = line.match(/(?:^|\s)(?:X|\*|\-)\s*(\d+)\s*(?:PACKS?|TABS?|PCS|NOS|STRIPS?)?\s*$/i);
            if (marked) return { qty: parseInt(marked[1], 10), matchedText: marked[0], usedNextLine: false };

            const trailing = line.match(/\b(\d+)\s*(?:PACKS?|TABS?|PCS|NOS|STRIPS?|S)?\s*$/i);
            if (trailing) return { qty: parseInt(trailing[1], 10), matchedText: trailing[0], usedNextLine: false };

            if (nextLineIfBare !== undefined && nextLineIfBare !== null) {
                const nextTrimmed = nextLineIfBare.trim();
                if (/^\d+$/.test(nextTrimmed)) {
                    return { qty: parseInt(nextTrimmed, 10), matchedText: null, usedNextLine: true };
                }
                const nextExplicit = nextTrimmed.match(/^(?:QTY|QUANTITY)\s*[:\-]?\s*(\d+)$/i);
                if (nextExplicit) {
                    return { qty: parseInt(nextExplicit[1], 10), matchedText: null, usedNextLine: true };
                }
            }

            return null;
        }

        // Parses ONE logical order-sheet row into independently-extracted
        // fields. Returns a structured result with an explicit list of
        // missing/failed fields rather than a boolean pass/fail, so the
        // caller can log exactly why a row needs Manual Review.
        parseOrderLineFields(rawLine, nextLine) {
            const line = rawLine.trim();
            const reasons = [];

            const qtyResult = this.extractOrderQuantity(line, nextLine);
            let medicineNamePart = line;
            if (qtyResult && qtyResult.matchedText) {
                const idx = line.lastIndexOf(qtyResult.matchedText);
                if (idx !== -1) medicineNamePart = line.substring(0, idx);
            }
            // Strip leading list markers (e.g. "1.", "2)", "-") from the name.
            medicineNamePart = medicineNamePart.replace(/^\s*\d+[\.\)]\s*/, "").trim();
            medicineNamePart = medicineNamePart.replace(/[\-\sx\*:\u2013]+$/i, "").trim();

            if (!medicineNamePart || medicineNamePart.length < 2) {
                reasons.push("Brand Missing");
            }

            const normalizedName = medicineNamePart ? this._normalizeOcrText(medicineNamePart) : "";
            const brand = normalizedName ? this.extractProductBrandWord(normalizedName) : "";
            if (!brand && medicineNamePart) reasons.push("Brand Missing");

            const strengthToken = normalizedName ? this.normalizeStrengthToken(normalizedName) : "0";
            const hasStrengthDigits = /\d/.test(normalizedName);
            if (!hasStrengthDigits) reasons.push("Strength Missing");

            const form = normalizedName ? this.detectFormCodeFromName(normalizedName) : "T";
            const pack = normalizedName ? this.extractPackNumber(null, normalizedName) : null;

            if (!qtyResult || !qtyResult.qty || qtyResult.qty <= 0) {
                reasons.push("Quantity Missing");
            }

            return {
                medicine_name: medicineNamePart || rawLine.trim(),
                brand: brand || "",
                strength: strengthToken,
                form,
                pack,
                quantity: qtyResult ? qtyResult.qty : null,
                usedNextLine: !!(qtyResult && qtyResult.usedNextLine),
                status: reasons.length === 0 ? "ok" : "manual_review",
                reasons
            };
        }

        // Full field-based pipeline for a pasted/OCR'd order-sheet text
        // block. Normalizes line breaks, pairs split "name\nqty" lines,
        // parses each row independently, and NEVER lets one bad row drop
        // the rest of the sheet -- rows that are missing a required field
        // are still returned, tagged "manual_review" with the exact reason.
        parseOrderTextFieldBased(text) {
            const t0 = performance.now();
            const rawLines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const items = [];
            let skipNext = false;

            for (let i = 0; i < rawLines.length; i++) {
                if (skipNext) { skipNext = false; continue; }
                const line = rawLines[i];
                const nextLine = rawLines[i + 1];

                const parsed = this.parseOrderLineFields(line, nextLine);
                if (parsed.usedNextLine) skipNext = true;

                items.push(parsed);
                if (parsed.status === "manual_review") {
                    console.warn(`Order line failed field extraction (${parsed.reasons.join(", ")}):`, line);
                } else {
                    console.log(`Order line parsed OK: "${parsed.medicine_name}" | strength=${parsed.strength} form=${parsed.form} pack=${parsed.pack} qty=${parsed.quantity}`);
                }
            }

            const elapsedMs = Math.round(performance.now() - t0);
            console.log(`[Timing] Local field-based parsing: ${elapsedMs}ms for ${rawLines.length} line(s), ${items.filter(i => i.status === "ok").length} OK / ${items.filter(i => i.status === "manual_review").length} Manual Review`);

            return items;
        }

        // Renders a small "where did the time go / where did it fail" panel
        // instead of only a pass/fail toast. Created dynamically next to the
        // order scanner UI the first time it's needed -- no index.html
        // changes required, so this can't disturb existing layout.
        renderOcrDiagnostics(diag, anchorId = "order-scanner-visualizer-box", panelId = "order-ocr-diagnostics") {
            const anchor = document.getElementById(anchorId);
            if (!anchor || !anchor.parentElement) return;

            let panel = document.getElementById(panelId);
            if (!panel) {
                panel = document.createElement("div");
                panel.id = panelId;
                panel.style.cssText = "margin-top:10px; padding:12px; border-radius:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); font-size:0.78rem;";
                anchor.parentElement.insertBefore(panel, anchor.nextSibling);
            }

            const rows = [
                ["OCR Time", diag.ocrTimeMs !== undefined ? `${(diag.ocrTimeMs / 1000).toFixed(1)} sec` : "—"],
                ["Gemini", diag.geminiStatus || "—"],
                ["JSON Repair", diag.jsonRepair || "N/A"],
                ["Matched", diag.matched !== undefined ? diag.matched : "—"],
                ["Manual Review", diag.manualReview !== undefined ? diag.manualReview : "—"],
                ["Total Time", diag.totalTimeMs !== undefined ? `${(diag.totalTimeMs / 1000).toFixed(1)} sec` : "—"]
            ];
            const AMBER_STATUSES = new Set(["Quota Exceeded", "Service Busy"]);
            const statusColor = (v) => {
                if (v === "PASS") return "#4ade80";
                if (v === "FAIL") return "#f87171";
                if (typeof v === "string" && AMBER_STATUSES.has(v)) return "#fbbf24";
                if (typeof v === "string" && v.startsWith("Timeout")) return "#fbbf24";
                if (typeof v === "string" && (
                    v === "Invalid API Key" || v === "Invalid Model" || v === "Invalid Request" ||
                    v === "JSON Parse Failed" || v === "OCR Extraction Failed"
                )) return "#f87171";
                return "#e5e7eb";
            };

            panel.innerHTML = `
                <div style="font-weight:600; color:#fff; margin-bottom:6px;">Scan Diagnostics</div>
                <div style="display:grid; grid-template-columns:1fr auto; row-gap:4px; column-gap:12px;">
                    ${rows.map(([label, value]) => `
                        <div style="color:var(--text-muted);">${label}</div>
                        <div style="text-align:right; color:${statusColor(value)}; font-weight:600;">${value}</div>
                    `).join("")}
                </div>
            `;
        }

        // Runs the field-based parser and returns structured results WITHOUT
        // touching the UI -- used both by the simple "Paste Order Text" flow
        // (processManualTextOrderLocal, below) and by the full pipeline
        // orchestrator (runOrderSheetPipeline), which needs to decide
        // whether to escalate to the AI Structured Text Parser before
        // populating anything.
        runFieldParserAndReport(text) {
            const parsedRows = this.parseOrderTextFieldBased(text);
            const okRows = parsedRows.filter(r => r.status === "ok");
            const reviewRows = parsedRows.filter(r => r.status === "manual_review");
            const parsedItems = parsedRows.map(r => ({
                medicine_name: r.medicine_name,
                quantity: r.quantity || 0,
                parseStatus: r.status,
                parseReasons: r.reasons
            }));
            return { parsedRows, parsedItems, okRows, reviewRows };
        }

        processManualTextOrderLocal(text) {
            const { parsedItems, okRows, reviewRows } = this.runFieldParserAndReport(text);

            if (parsedItems.length > 0) {
                this.populateOrderBuilder(parsedItems);
                if (reviewRows.length > 0) {
                    this.showToast(`Parsed ${okRows.length} item(s) cleanly; ${reviewRows.length} row(s) flagged for Manual Review — check the highlighted rows.`, "warning");
                    this.triggerNotification(
                        "Order Processing", "Order sheet partial parse",
                        `🟠 ${reviewRows.length} row(s) need Manual Review:\n` + reviewRows.map(r => `- "${r.medicine_name}": ${r.reasons.join(", ")}`).join("\n"),
                        "Warning", { errorDetails: "Field-based local parser flagged rows for manual review" }
                    );
                } else {
                    this.showToast(`Parsed ${parsedItems.length} item(s) using the local field-based parser.`, "success");
                }
            } else {
                this.showToast("Unable to identify any order lines locally. Please verify format.", "error");
                this.triggerNotification(
                    "Order Processing", "Order sheet validation failure",
                    `🔴 Order Sheet Validation Failure\nLocal field-based parser found no lines at all to parse (input was empty after trimming).\nPlease verify the order text was pasted/extracted correctly.`,
                    "Critical", { errorDetails: "Local field-based order parser received 0 lines" }
                );
            }
        }

        populateOrderBuilder(parsedData) {
            const container = document.getElementById("builder-items-rows");
            if (!container) return;

            // Clear existing rows
            container.innerHTML = "";

            let dispensaryId = "";
            let dispensaryName = "";
            let items = [];

            if (parsedData && !Array.isArray(parsedData) && parsedData.items) {
                dispensaryId = parsedData.dispensary_id || "";
                dispensaryName = parsedData.dispensary_name || "";
                items = parsedData.items;
            } else if (Array.isArray(parsedData)) {
                items = parsedData;
            }

            const tablets = this.getTablets();
            let matchedCount = 0;
            let unmatchedCount = 0;
            const unmatchedNames = [];

            // Set order reference code up-front so notifications can reference it
            const generatedRefId = "ORD-OCR-" + Math.floor(Math.random() * 90000 + 10000);

            const _matchStart = performance.now();
            items.forEach(item => {
                const match = this.resolveMedicine(item.medicine_name, null, tablets).tablet;
                const parseIssue = item.parseStatus === "manual_review" ? item.parseReasons.join(", ") : null;
                if (match) {
                    this.addOrderBuilderRow(match.name, item.quantity, item.confidence || null, parseIssue, item.pack || null);
                    matchedCount++;
                } else {
                    // Pre-fill with parsed medicine name directly so it is not lost.
                    // Matching is NOT decided here — this is just the pre-fill step.
                    // The real, immediate popup-based matching (Medicine Not Found /
                    // Multiple Matches) happens when the user clicks "Run Inventory
                    // Verification", via verifyStockItems() -> showOcrMatchModal().
                    // No Notification Center entry is raised at this stage.
                    this.addOrderBuilderRow(item.medicine_name, item.quantity, item.confidence || null, parseIssue, item.pack || null);
                    unmatchedCount++;
                    unmatchedNames.push(item.medicine_name);
                }
            });
            console.log(`[Timing] Matching (${items.length} item(s)): ${Math.round(performance.now() - _matchStart)}ms`);

            // Set dispensary fields
            const dispIdInput = document.getElementById("order-dispensary-id");
            if (dispIdInput) {
                dispIdInput.value = dispensaryId || "49864M";
            }
            const dispNameInput = document.getElementById("order-dispensary-name");
            if (dispNameInput) {
                dispNameInput.value = dispensaryName || "MALLIGA.S";
            }

            // Set order reference code
            const refInput = document.getElementById("order-ref-id");
            if (refInput) {
                refInput.value = generatedRefId;
            }
            
            // Set date received to today
            const dateInput = document.getElementById("order-date-input");
            if (dateInput) {
                dateInput.value = new Date().toISOString().split('T')[0];
            }

            // Log upload activity
            this.logHistory(
                "Order Uploaded",
                dispensaryId || "Unknown",
                "N/A",
                items.length,
                `Uploaded order containing ${items.length} items (Dispensary Name: ${dispensaryName || "Unknown"})`
            );

            // Switch to Manual Entry subtab to show builder
            this.switchOrderSubTab('manual');

            // Feedback toast
            if (unmatchedCount > 0) {
                this.showToast(`Matched ${matchedCount} medicines. ${unmatchedCount} items could not be matched. Please select them manually.`, "warning");
                console.log("Unmatched order items:", unmatchedNames);
            } else {
                this.showToast(`Successfully matched all ${matchedCount} medicines!`, "success");
                // Automatically run inventory verification
                this.runOrderVerificationManual();
            }
        }

        // Add a row to manual builder table
        addOrderBuilderRow(nameValue = "", qtyValue = "", confidence = null, parseIssue = null, pack = null) {
            const container = document.getElementById("builder-items-rows");
            if (!container) return;

            const rowId = `row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            
            const row = document.createElement("div");
            row.className = "builder-row";
            row.id = rowId;
            if (confidence && typeof confidence === "object") {
                row.dataset.confidence = JSON.stringify(confidence);
            }
            // OCR-scanned pack size (if the scanner could read it), carried
            // through to Inventory Verification so the Medicine Identity
            // Engine's Pack Size step (the ONLY field allowed to trigger a
            // popup) has real data instead of always seeing "no pack read".
            if (pack !== null && pack !== undefined && pack !== "") {
                row.dataset.pack = String(pack);
            }
            if (parseIssue) {
                row.dataset.parseIssue = parseIssue;
                row.style.borderLeft = "3px solid #f59e0b";
                row.title = `Manual Review needed: ${parseIssue}`;
            }
            // nameValue is OCR-derived (order-sheet scan) and parseIssue can
            // echo OCR-derived text too. Interpolating either into innerHTML/
            // an HTML attribute would let a crafted document break out and
            // inject markup/script (see POST_IMPLEMENTATION_AUDIT.md,
            // "Pre-existing HTML injection surface" -- this is the "sibling
            // row builder" referenced there, alongside addBillManualRow).
            // Fixed the same way: build with empty value/placeholder-only
            // markup, then assign via safe DOM properties (.value/.textContent)
            // after insertion.
            row.innerHTML = `
                <div style="flex: 1; min-width: 220px; position: relative;">
                    <div class="builder-parse-issue" style="font-size:0.68rem; color:#f59e0b; margin-bottom:2px; display:${parseIssue ? "block" : "none"};">⚠ Manual Review: <span class="builder-parse-issue-text"></span></div>
                    <input
                        type="text"
                        class="builder-select-tab"
                        list="manual-bill-tablets-list"
                        placeholder="Type any product name (e.g. OPTIMOIST GEL)..."
                        required
                        autocomplete="off"
                        style="width:100%; padding: 10px 14px; border-radius: 8px; border: 1px solid ${parseIssue ? '#f59e0b' : 'var(--border-color)'}; background: rgba(255,255,255,0.06); color: var(--text-primary); font-size: 0.88rem;"
                    >
                </div>
                <input
                    type="number"
                    class="builder-qty-tab"
                    min="1"
                    placeholder="Qty"
                    required
                    style="width: 90px; padding: 10px 10px; border-radius: 8px; border: 1px solid var(--border-color); background: rgba(255,255,255,0.06); color: var(--text-primary); font-size: 0.88rem;"
                >
                <button type="button" class="btn btn-icon-only danger" title="Remove row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
            row.querySelector(".builder-select-tab").value = nameValue;
            row.querySelector(".builder-qty-tab").value = qtyValue;
            if (parseIssue) {
                row.querySelector(".builder-parse-issue-text").textContent = parseIssue;
            }
            row.querySelector(".btn-icon-only.danger").addEventListener("click", () => {
                const el = document.getElementById(rowId);
                if (el) el.remove();
            });
            container.appendChild(row);
            // Focus the input field if this is a user-triggered add
            if (!nameValue) {
                setTimeout(() => row.querySelector(".builder-select-tab").focus(), 50);
            }
        }

        // Load Sample Order paper list
        loadSampleOrderPaper() {
            const container = document.getElementById("builder-items-rows");
            container.innerHTML = "";

            // Populate sample order items (Mix of in-stock, low-stock, and due stock)
            // ROSEDAY (150 in stock, request 60) -> Available
            this.addOrderBuilderRow("USV L. ROSEDAY 20MG", "60");
            // RENERVE PLUS (65 in stock, request 100) -> Deficit 35 due
            this.addOrderBuilderRow("GRAN RENERVE PLUS", "100");
            // TAZLOC 40MG (200 in stock, request 250) -> Deficit 50 due
            this.addOrderBuilderRow("USV L. TAZLOC 40MG", "250");
            // METFORMIN 500MG (Not in DB, request 50) -> Deficit 50 due (not in inventory)
            
            // Let's set order ref
            const refInput = document.getElementById("order-ref-id");
            if (refInput) refInput.value = "ORD-2026-055";

            // Switch view subtab to manual to show the filled builder
            this.switchOrderSubTab('manual');
            
            // Focus and trigger verify
            this.showToast("Sample order paper loaded. Click 'Run Inventory Verification' to process.");
        }

        // Run Verification logic
        runOrderVerificationManual() {
            const refId = document.getElementById("order-ref-id").value.trim().toUpperCase();
            const orderDate = document.getElementById("order-date-input").value;
            const dispensaryId = (document.getElementById("order-dispensary-id")?.value || "").trim();
            const dispensaryName = (document.getElementById("order-dispensary-name")?.value || "").trim();

            // Extract items from manual inputs
            const rows = document.querySelectorAll(".builder-row");
            const items = [];

            rows.forEach(row => {
                const select = row.querySelector(".builder-select-tab");
                const qtyInput = row.querySelector(".builder-qty-tab");
                if (select.value && qtyInput.value) {
                    let confidence = null;
                    if (row.dataset.confidence) {
                        try { confidence = JSON.parse(row.dataset.confidence); } catch (e) { confidence = null; }
                    }
                    items.push({
                        name: select.value,
                        qty: parseInt(qtyInput.value),
                        pack: row.dataset.pack || null,
                        confidence
                    });
                }
            });

            if (items.length === 0) {
                this.showToast("Please enter at least one order item.", "error");
                return;
            }

            this.verifyStockItems(refId, orderDate, dispensaryId, dispensaryName, items);
        }

        processOrderCSV(file) {
            // Check for image or binary file extensions
            if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|pdf|xlsx|xls|zip)$/i.test(file.name)) {
                this.showToast("Invalid file format. If you want to scan an invoice image, please use the 'Bill Processing' tab.", "error");
                return;
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const text = e.target.result;
                
                // Check if the contents are binary (null characters or high ratio of replacement characters)
                if (text.includes('\u0000') || (text.match(/[\uFFFD]/g) || []).length > 5) {
                    this.showToast("Unable to parse file. The file appears to be a binary document (like an Excel worksheet or image) instead of a CSV text file.", "error");
                    return;
                }

                const rows = text.split('\n');
                const items = [];

                rows.forEach((row, idx) => {
                    if (idx === 0) return; // Skip headers
                    const cols = row.split(',');
                    if (cols.length >= 2) {
                        const name = cols[0].replace(/"/g, '').trim();
                        const qty = parseInt(cols[1].trim());
                        if (name && !isNaN(qty)) {
                            items.push({ name, qty });
                        }
                    }
                });

                if (items.length === 0) {
                    this.showToast("No valid order items found in CSV file.", "error");
                    return;
                }

                const randRef = "CSV-" + Math.floor(Math.random() * 9000 + 1000);
                const curDate = new Date().toISOString().split('T')[0];
                
                this.verifyStockItems(randRef, curDate, "VEP", "Vepary Dispensary", items);
            };
            reader.readAsText(file);
        }

        // Perform stock check against db
        async verifyStockItems(refId, date, dispensaryId, dispensaryName, items) {
            // Workflow Starts Here: Order Sheet -> OCR Scan -> Workflow
            // Created -> Workflow ID Assigned. Every medicine extracted from
            // this order sheet inherits this same id. Guarded so re-entry
            // (e.g. after the Medicine Confirmation popup resumes this same
            // items array) never creates a second workflow for one order sheet.
            //
            // The database is the single source of truth for the id (see
            // createWorkflow) -- this call is awaited, and if it fails there
            // is no local fallback id: verification simply cannot proceed
            // without a database-issued Workflow ID, and the user is told why.
            if (!items.workflowId) {
                try {
                    items.workflowId = await this.createWorkflow(dispensaryId, dispensaryName, refId);
                } catch (err) {
                    console.error("Workflow creation failed:", err);
                    this.showToast(`Could not start this order: ${err.message}`, "error");
                    return;
                }
            }

            const tablets = this.getTablets();
            const pendingQueue = [];

            items.forEach((item, idx) => {
                // If this item was already resolved (e.g. has resolvedTablet property), skip
                if (item.resolvedTablet) return;

                // Per-field OCR confidence (Phase 5 refinement): if the
                // scanner itself was unsure about the Brand text, don't let
                // the matching cascade proceed on a guess -- ask the user to
                // confirm which medicine this actually is, just like a
                // genuine "brand not identifiable" case.
                const fieldConf = item.confidence;
                if (fieldConf && typeof fieldConf === "object" && fieldConf.brand !== undefined && fieldConf.brand < 80) {
                    const matches = this.resolveMedicine(item.name, null, tablets, { includeCandidates: true }).candidates;
                    if (matches.length > 0) {
                        pendingQueue.push({ type: "order", itemIndex: idx, name: item.name, matches: matches });
                        return;
                    }
                    // No candidates to offer even for confirmation -> genuinely new.
                    item.isNewMedicine = true;
                    return;
                }

                const resolution = this.resolveMedicine(item.name, item.pack, tablets);

                if (resolution.status === "exact") {
                    // Low Pack confidence on an otherwise exact match still
                    // gets a Pack Confirmation popup rather than silently
                    // trusting a pack size the scanner itself was unsure about.
                    if (fieldConf && typeof fieldConf === "object" && fieldConf.pack !== undefined && fieldConf.pack < 80) {
                        pendingQueue.push({
                            type: "order-pack-confirm",
                            itemIndex: idx,
                            name: item.name,
                            existingTablet: resolution.tablet,
                            existingPack: this.extractPackNumber(resolution.tablet.pack, resolution.tablet.name),
                            scannedPack: this.extractPackNumber(item.pack, item.name),
                            rawPack: item.pack
                        });
                        return;
                    }
                    item.resolvedTablet = resolution.tablet;
                } else if (resolution.status === "new") {
                    // No Brand/Strength/Dosage Form match. If Generic Name or
                    // fuzzy candidates exist, this may still be an EXISTING
                    // medicine (e.g. OCR read a generic name for a brand-only
                    // Master Data record) -- never silently treat that as new
                    // stock, show the existing Medicine Confirmation popup so
                    // the user picks the correct existing record instead.
                    // Genuinely no candidates at all -> keep the existing
                    // deferred-creation behavior unchanged (tag and continue;
                    // it only becomes a permanent Master Data record later,
                    // once actually purchased via Supplier Bill Processing).
                    if (resolution.candidates.length > 0) {
                        pendingQueue.push({ type: "order", itemIndex: idx, name: item.name, matches: resolution.candidates });
                        return;
                    }
                    item.isNewMedicine = true;
                } else if (resolution.status === "pack_confirm") {
                    // Pack Size is the ONLY comparison allowed to interrupt
                    // the user -- Pack Size Confirmation popup.
                    pendingQueue.push({
                        type: "order-pack-confirm",
                        itemIndex: idx,
                        name: item.name,
                        existingTablet: resolution.tablet,
                        existingPack: resolution.existingPack,
                        scannedPack: resolution.scannedPack,
                        rawPack: item.pack
                    });
                }
            });

            if (pendingQueue.length > 0) {
                this.orderVerificationContext = { refId, date, dispensaryId, dispensaryName, items };
                this.ocrMatchQueue = pendingQueue;
                this.ocrMatchQueueIndex = 0;
                this.updateWorkflowStatus(items.workflowId, "Scanning");
                this.showOcrMatchModal();
                return;
            }

            // No pending matches -> run the actual stock check!
            this.verifyStockItemsResolved(refId, date, dispensaryId, dispensaryName, items);
        }

                verifyStockItemsResolved(refId, date, dispensaryId, dispensaryName, items) {
            // Build the raw (match-resolved) item list and hand off to the
            // editable Inventory Verification Report renderer. Nothing is
            // written to inventory here -- only after the user clicks "Verified".
            const tablets = this.getTablets();

            const resolvedRaw = items.map(item => {
                let dbMatch = item.resolvedTablet || null;
                if (!dbMatch) {
                    dbMatch = tablets.find(t => t.name.toLowerCase() === item.name.toLowerCase() || t.code.toLowerCase() === item.name.toLowerCase()) || null;
                }
                const fieldConf = item.confidence;
                const needsStrengthReview = !!(fieldConf && typeof fieldConf === "object" && fieldConf.strength !== undefined && fieldConf.strength < 80);
                return {
                    ocrName: item.name,
                    qty: item.qty,
                    code: dbMatch ? dbMatch.code : null,
                    matchedName: dbMatch ? dbMatch.name : null,
                    isNewMedicine: !dbMatch && !!item.isNewMedicine,
                    remarks: needsStrengthReview ? "Low OCR confidence on Strength — please double-check this medicine." : ""
                };
            });

            // Merge duplicate rows for the SAME resolved medicine (same
            // Brand + Strength + Dosage Form, i.e. same Master Data code —
            // or, for genuinely unresolved "New Medicine" rows, the same
            // normalized name) into a single row with quantities summed.
            // This prevents the same medicine appearing twice on an order
            // sheet from producing two separate verification rows.
            const mergedMap = new Map();
            const mergedOrder = [];
            resolvedRaw.forEach(raw => {
                const key = raw.code ? `C::${raw.code.toUpperCase().trim()}` : `N::${raw.ocrName.toLowerCase().trim()}`;
                const existing = mergedMap.get(key);
                if (existing) {
                    existing.qty += raw.qty;
                } else {
                    const clone = { ...raw };
                    mergedMap.set(key, clone);
                    mergedOrder.push(clone);
                }
            });

            this.verificationRawItems = mergedOrder.map(({ matchedName, ...rest }) => rest);

            const workflowId = items.workflowId || null;
            this.verificationMeta = { refId, date, dispensaryId: dispensaryId || "VEP", dispensaryName: dispensaryName || "Vepary Dispensary", workflowId };

            if (workflowId) {
                this.updateWorkflowStatus(workflowId, "Verification Pending");
                this.logWorkflowEvent(workflowId, "OCR Completed", "Order Processing", `Extracted ${items.length} item(s) from order sheet ${refId}.`);
            }

            document.getElementById("verification-empty-state").classList.add("hidden");
            document.getElementById("verification-results-container").classList.remove("hidden");

            this.renderVerificationReport();

            this.logHistory(
                "Order Verified",
                refId,
                "N/A",
                items.length,
                `Verified stock availability for ${items.length} items (Order Ref: ${refId}, Dispensary: ${dispensaryId || "VEP"})`,
                { workflowId }
            );
        }

        // Recomputes Available / Partial Stock / No Stock groupings from
        // this.verificationRawItems against LIVE master data, renders the
        // editable Inventory Verification Report, and refreshes
        // this.currentVerifiedOrder (consumed by submitVerifiedOrder when the
        // user clicks "Verified"). This function never mutates inventory --
        // it only reads current stock and re-draws the report.
        renderVerificationReport() {
            if (!this.verificationRawItems || !this.verificationMeta) return;
            const meta = this.verificationMeta;
            const tablets = this.getTablets();

            const availBody = document.getElementById("verification-available-table-body");
            const partialBody = document.getElementById("verification-partial-table-body");
            const noStockBody = document.getElementById("verification-nostock-table-body");
            if (availBody) availBody.innerHTML = "";
            if (partialBody) partialBody.innerHTML = "";
            if (noStockBody) noStockBody.innerHTML = "";

            let availCount = 0, partialCount = 0, noStockCount = 0;
            const computedItems = [];

            const tabletOptionsHtml = (selectedCode) => tablets.map(t =>
                `<option value="${t.code}" ${t.code === selectedCode ? "selected" : ""}>${t.name} (${t.code})</option>`
            ).join("");

            this.verificationRawItems.forEach((raw, idx) => {
                const dbMatch = raw.code ? tablets.find(t => t.code === raw.code) : null;
                const reqQty = raw.qty;
                const dbStock = dbMatch ? dbMatch.stock : 0;
                const category = dbMatch ? dbMatch.category : "Others";
                const tps = dbMatch ? (dbMatch.tabsPerStrip || 10) : 10;
                const displayName = dbMatch ? dbMatch.name : raw.ocrName;

                let status, availQty, dueQty, reservedQty, remainingStock;
                if (!dbMatch && raw.isNewMedicine) {
                    status = "New Medicine";
                    availQty = 0;
                    dueQty = reqQty;
                    reservedQty = 0;
                    remainingStock = 0;
                } else if (!dbMatch || dbStock <= 0) {
                    status = "No Stock";
                    availQty = 0;
                    dueQty = reqQty;
                    reservedQty = 0;
                    remainingStock = dbStock;
                } else if (dbStock < reqQty) {
                    status = "Partial";
                    availQty = dbStock;
                    dueQty = reqQty - dbStock;
                    reservedQty = dbStock;
                    remainingStock = 0;

                    // Strip vs loose-tablet allocation: the ONLY popup in this
                    // workflow. Triggers only when the requested qty can't be
                    // filled with whole strips alone. Two framings depending on
                    // whether the request is less than one strip or spans
                    // multiple strips with a remainder (matches product spec
                    // examples: 12@10/strip, 12@15/strip, 30@14/strip).
                    const isStripCategory = category === "Tablets & Capsules" || category === "Rotacaps";
                    if (isStripCategory && tps > 0 && (dueQty % tps !== 0)) {
                        raw.allocChoice = raw.allocChoice || "A";
                        const wholeStrips = Math.floor(dueQty / tps);
                        const remainderTabs = dueQty % tps;
                        let optionA, optionB, optionAQty, optionBQty;
                        if (wholeStrips === 0) {
                            // Less than one strip: exact loose vs round-up to 1 full strip
                            optionA = `${dueQty} Loose Tablet${dueQty !== 1 ? 's' : ''}`;
                            optionAQty = dueQty;
                            optionB = `1 Full Strip (${tps} Tablets)`;
                            optionBQty = tps;
                        } else {
                            // Multiple strips with a remainder: whole strips only (short) vs exact split
                            optionA = `${wholeStrips} Full Strip${wholeStrips !== 1 ? 's' : ''} (${wholeStrips * tps} Tablets)`;
                            optionAQty = wholeStrips * tps;
                            optionB = `${wholeStrips} Full Strip${wholeStrips !== 1 ? 's' : ''} + ${remainderTabs} Loose Tablet${remainderTabs !== 1 ? 's' : ''} (${dueQty} Tablets)`;
                            optionBQty = dueQty;
                        }
                        raw._packChoice = { optionA, optionB, optionAQty, optionBQty };
                        dueQty = raw.allocChoice === "A" ? optionAQty : optionBQty;
                    } else {
                        raw._packChoice = null;
                    }
                } else {
                    status = "Available";
                    availQty = reqQty;
                    dueQty = 0;
                    reservedQty = reqQty;
                    remainingStock = dbStock - reqQty;
                }

                // ---- Shortage popup data (Required / Available / Shortage / Suggested Purchase) ----
                // Always derived from Master Data (tps = tabs-per-strip from the
                // matched tablet record), never a hardcoded or assumed pack size.
                // Uses the TRUE shortfall (requested - actually available), not the
                // allocation-adjusted dueQty above, so the suggested purchase always
                // covers the customer's full requirement regardless of which partial
                // allocation option (A/B) the user picked for dispensing today.
                const trueShortage = Math.max(0, reqQty - (dbMatch ? Math.max(dbStock, 0) : 0));
                const isStripCategoryForPurchase = category === "Tablets & Capsules" || category === "Rotacaps";
                let suggestedPurchase = null;
                if (trueShortage > 0) {
                    if (dbMatch && isStripCategoryForPurchase && tps > 0) {
                        // Never floor here: rounding down would under-order and
                        // reproduce the exact "incorrect strip calculation" bug
                        // this fix is for. Always round UP to whole strips.
                        const stripsNeeded = Math.ceil(trueShortage / tps);
                        suggestedPurchase = {
                            strips: stripsNeeded,
                            tabsPerStrip: tps,
                            totalTablets: stripsNeeded * tps,
                            label: `${stripsNeeded} Strip${stripsNeeded !== 1 ? 's' : ''} (${stripsNeeded * tps} Tablets)`
                        };
                    } else if (dbMatch) {
                        // Non-strip category (syrup/injection/etc.) -- purchase the
                        // exact shortfall in base units, no strip math applies.
                        suggestedPurchase = {
                            strips: null,
                            tabsPerStrip: null,
                            totalTablets: trueShortage,
                            label: `${trueShortage} Unit${trueShortage !== 1 ? 's' : ''}`
                        };
                    } else {
                        // Not in Master Data at all -- cannot convert to strips
                        // without pack-size data, so never guess.
                        suggestedPurchase = { strips: null, tabsPerStrip: null, totalTablets: trueShortage, label: "Add to Master Data to compute strips" };
                    }
                }
                raw._shortageDetail = trueShortage > 0 ? {
                    name: displayName,
                    required: reqQty,
                    available: dbMatch ? Math.max(dbStock, 0) : 0,
                    shortage: trueShortage,
                    tabsPerStrip: dbMatch ? tps : null,
                    suggestedPurchase
                } : null;

                computedItems.push({
                    name: displayName,
                    code: dbMatch ? dbMatch.code : "N/A",
                    reqQty, availQty, dueQty, status,
                    isNewMedicine: status === "New Medicine",
                    remarks: raw.remarks || "",
                    notAvailable: !!raw.notAvailable
                });

                // displayName falls back to raw.ocrName (unmatched OCR text) when
                // there's no Master Data match -- escape once, reuse everywhere
                // below, since this is written into innerHTML in all three
                // status branches (Available/Partial/New-or-OutOfStock).
                const safeDisplayName = this.escapeHtml(displayName);
                const matchCellHtml = `
                    <select onchange="window.app.changeVerificationMatch(${idx}, this.value)" style="margin-top:4px;font-size:0.72rem;padding:3px 5px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;max-width:180px;display:block;">
                        <option value="">-- Unmatched --</option>
                        ${tabletOptionsHtml(dbMatch ? dbMatch.code : null)}
                    </select>`;
                const qtyCellHtml = `<input type="number" min="0" value="${reqQty}" onchange="window.app.updateVerificationRawItem(${idx}, 'qty', this.value)" style="width:70px;font-size:0.8rem;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;">`;
                const remarksCellHtml = `<input type="text" value="${(raw.remarks || "").replace(/"/g, "&quot;")}" placeholder="Remarks" onchange="window.app.updateVerificationRawItem(${idx}, 'remarks', this.value)" style="width:120px;font-size:0.78rem;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;">`;

                if (status === "Available") {
                    availCount++;
                    const tr = document.createElement("tr");
                    tr.innerHTML = `
                        <td><strong>${safeDisplayName}</strong>${matchCellHtml}</td>
                        <td>${qtyCellHtml}</td>
                        <td><span class="text-success font-weight-700">${this.fmtStock(dbStock, tps, category)}</span></td>
                        <td>${this.fmtStock(reservedQty, tps, category)}</td>
                        <td>${this.fmtStock(remainingStock, tps, category)}</td>
                        <td><span class="status-badge badge-success" style="font-size:0.7rem;padding:2px 6px;">Available</span></td>
                        <td>${remarksCellHtml}</td>
                    `;
                    if (availBody) availBody.appendChild(tr);
                } else if (status === "Partial") {
                    partialCount++;
                    const tr = document.createElement("tr");
                    let packChoiceHtml = "";
                    if (raw._packChoice) {
                        const pc = raw._packChoice;
                        packChoiceHtml = `
                            <div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:rgba(255,193,7,0.1);border:1px solid rgba(255,193,7,0.35);">
                                <div style="font-size:0.68rem;color:var(--color-warning,#ffc107);font-weight:600;margin-bottom:4px;">Choose allocation:</div>
                                <select onchange="window.app.changeVerificationAllocChoice(${idx}, this.value)" style="width:100%;font-size:0.75rem;padding:4px 6px;border-radius:6px;background:rgba(0,0,0,0.4);border:1px solid var(--border-color);color:#fff;">
                                    <option value="A" ${raw.allocChoice === "A" ? "selected" : ""}>${pc.optionA}</option>
                                    <option value="B" ${raw.allocChoice === "B" ? "selected" : ""}>${pc.optionB}</option>
                                </select>
                            </div>`;
                    }
                    tr.innerHTML = `
                        <td><strong>${safeDisplayName}</strong>${matchCellHtml}</td>
                        <td>${qtyCellHtml}</td>
                        <td>${this.fmtStock(dbStock, tps, category)}</td>
                        <td>${this.fmtStock(dueQty, tps, category)}</td>
                        <td>
                            <span class="font-weight-700 text-coral">${this.fmtStock(dueQty, tps, category)}</span>${packChoiceHtml}
                            ${raw._shortageDetail ? `<button type="button" onclick="window.app.showShortageDetail(${idx})" style="margin-top:6px;font-size:0.68rem;padding:3px 8px;border-radius:6px;background:rgba(255,193,7,0.12);border:1px solid rgba(255,193,7,0.4);color:#ffc107;cursor:pointer;">View Shortage</button>` : ""}
                            ${raw.notAvailable ? `<span style="display:block;margin-top:6px;font-size:0.68rem;color:#ff6b6b;">Marked Not Available</span>` : `<button type="button" onclick="window.app.markItemNotAvailable(${idx})" style="display:block;margin-top:6px;font-size:0.68rem;padding:3px 8px;border-radius:6px;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;cursor:pointer;">Not Available</button>`}
                        </td>
                        <td><span class="status-badge badge-warning" style="font-size:0.7rem;padding:2px 6px;">Partial Stock</span></td>
                        <td>${remarksCellHtml}</td>
                    `;
                    if (partialBody) partialBody.appendChild(tr);
                } else {
                    noStockCount++;
                    const tr = document.createElement("tr");
                    const isNewMed = status === "New Medicine";
                    tr.innerHTML = `
                        <td><strong>${safeDisplayName}</strong>${matchCellHtml}</td>
                        <td>${qtyCellHtml}</td>
                        <td>${dbMatch ? this.fmtStock(dbStock, tps, category) : `<span class="text-danger">Not in Master Data</span>`}</td>
                        <td>
                            <span class="status-badge ${isNewMed ? 'badge-info' : 'badge-danger'}" style="font-size:0.7rem;padding:2px 6px;">${isNewMed ? 'New Medicine' : 'Out of Stock'}</span>
                            ${raw._shortageDetail ? `<button type="button" onclick="window.app.showShortageDetail(${idx})" style="display:block;margin-top:6px;font-size:0.68rem;padding:3px 8px;border-radius:6px;background:rgba(255,193,7,0.12);border:1px solid rgba(255,193,7,0.4);color:#ffc107;cursor:pointer;">View Shortage</button>` : ""}
                            ${raw.notAvailable ? `<span style="display:block;margin-top:6px;font-size:0.68rem;color:#ff6b6b;">Marked Not Available</span>` : `<button type="button" onclick="window.app.markItemNotAvailable(${idx})" style="display:block;margin-top:6px;font-size:0.68rem;padding:3px 8px;border-radius:6px;background:rgba(255,107,107,0.1);border:1px solid rgba(255,107,107,0.4);color:#ff6b6b;cursor:pointer;">Not Available</button>`}
                        </td>
                        <td>${remarksCellHtml}</td>
                    `;
                    if (noStockBody) noStockBody.appendChild(tr);
                }
            });

            if (availBody && availBody.children.length === 0) {
                availBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding:15px;">No fully available items.</td></tr>`;
            }
            if (partialBody && partialBody.children.length === 0) {
                partialBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding:15px;">No partial stock items.</td></tr>`;
            }
            if (noStockBody && noStockBody.children.length === 0) {
                noStockBody.innerHTML = `<tr><td colspan="5" class="text-center text-success" style="padding:15px;color:var(--color-success) !important;font-weight:600;">No out-of-stock items.</td></tr>`;
            }

            this.currentVerifiedOrder = {
                refId: meta.refId,
                date: meta.date,
                dispensaryId: meta.dispensaryId,
                dispensaryName: meta.dispensaryName,
                workflowId: meta.workflowId || null,
                items: computedItems
            };

            const refEl = document.getElementById("ver-ref-id"); if (refEl) refEl.textContent = meta.refId;
            const dateEl = document.getElementById("ver-date"); if (dateEl) dateEl.textContent = meta.date;
            const instockEl = document.getElementById("ver-count-instock"); if (instockEl) instockEl.textContent = availCount;
            const dueEl = document.getElementById("ver-count-due"); if (dueEl) dueEl.textContent = (partialCount + noStockCount);

            const checkBadge = document.getElementById("order-check-badge");
            if (checkBadge) {
                if (partialCount + noStockCount > 0) {
                    checkBadge.className = "status-badge badge-warning";
                    checkBadge.textContent = "Deficit Found";
                } else {
                    checkBadge.className = "status-badge badge-success";
                    checkBadge.textContent = "All In Stock";
                }
            }
        }

        // Called from an editable report row when Quantity or Remarks changes.
        // The report is fully recomputed against live stock so the row moves
        // between Available / Partial Stock / No Stock sections as needed.
        updateVerificationRawItem(idx, field, value) {
            if (!this.verificationRawItems || !this.verificationRawItems[idx]) return;
            if (field === "qty") {
                const q = parseInt(value);
                this.verificationRawItems[idx].qty = isNaN(q) || q < 0 ? 0 : q;
            } else {
                this.verificationRawItems[idx][field] = value;
            }
            this.renderVerificationReport();
        }

        // Called when the user picks between the two strip/loose-tablet
        // allocation options for a Partial Stock row (the only popup in this
        // workflow — see renderVerificationReport for when it appears).
        changeVerificationAllocChoice(idx, choice) {
            if (!this.verificationRawItems || !this.verificationRawItems[idx]) return;
            this.verificationRawItems[idx].allocChoice = choice;
            this.renderVerificationReport();
        }

        // Shows the Required / Available / Shortage / Suggested Purchase popup
        // for a Partial or No-Stock row. All numbers are read from the
        // _shortageDetail computed in renderVerificationReport, which always
        // derives strip conversions from Master Data (tabsPerStrip) and always
        // rounds the suggested purchase UP to whole strips -- never floors or
        // guesses -- so the suggestion always covers the real shortfall.
        showShortageDetail(idx) {
            const raw = this.verificationRawItems && this.verificationRawItems[idx];
            const detail = raw && raw._shortageDetail;
            const modal = document.getElementById("shortage-detail-modal");
            if (!detail || !modal) return;

            const setText = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.textContent = val;
            };
            setText("shortage-detail-name", detail.name);
            setText("shortage-detail-required", `${detail.required} Tablet${detail.required !== 1 ? 's' : ''}`);
            setText("shortage-detail-available", `${detail.available} Tablet${detail.available !== 1 ? 's' : ''}`);
            setText("shortage-detail-shortage", `${detail.shortage} Tablet${detail.shortage !== 1 ? 's' : ''}`);
            const sp = detail.suggestedPurchase;
            setText("shortage-detail-suggested", sp ? sp.label : "—");
            setText("shortage-detail-basis", detail.tabsPerStrip
                ? `Based on Master Data: 1 Strip = ${detail.tabsPerStrip} Tablets`
                : "Pack size not set in Master Data for this item.");

            modal.classList.add("active");
        }

        closeShortageDetail() {
            const modal = document.getElementById("shortage-detail-modal");
            if (modal) modal.classList.remove("active");
        }

        // Called when the user changes the "Selected Match" dropdown for a report row.
        changeVerificationMatch(idx, code) {
            if (!this.verificationRawItems || !this.verificationRawItems[idx]) return;
            this.verificationRawItems[idx].code = code || null;
            this.renderVerificationReport();
        }

        resetOrderVerification() {
            this.currentVerifiedOrder = null;
            this.verificationRawItems = null;
            this.verificationMeta = null;
            document.getElementById("verification-results-container").classList.add("hidden");
            document.getElementById("verification-empty-state").classList.remove("hidden");
            document.getElementById("order-check-badge").className = "status-badge";
            document.getElementById("order-check-badge").textContent = "No verification run";
        }

        // Commit Verified Order
        async submitVerifiedOrder() {
            if (!this.currentVerifiedOrder) return;

            try {
                // Begin atomic transaction and check locks
                this.beginTransaction();

                let tablets = this.getTablets();
                let history = this.getHistory();

                const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
                let deductCount = 0;
                let loggedReorderCount = 0;
                const workflowId = this.currentVerifiedOrder.workflowId || null;
                if (workflowId) {
                    this.logWorkflowEvent(workflowId, "Inventory Verified", "Inventory Verification", `User clicked Verified for order ${this.currentVerifiedOrder.refId}.`);
                }

                for (const item of this.currentVerifiedOrder.items) {
                    const dbMatch = tablets.find(t => t.code === item.code) || tablets.find(t => t.name === item.name);
                    
                    // Concurrency verification: verify stock hasn't decreased below the reservation quantity
                    if (item.availQty > 0) {
                        if (!dbMatch) {
                            this.triggerNotification(
                            "Order Processing", "Missing Master Data",
                            `🔴 Product Not Found in Master Inventory\nProduct: "${item.name}"\nOrder: ${this.currentVerifiedOrder.refId}\nThis item cannot be reserved – please add it to Master Data first.`,
                            "Critical", { medicineName: item.name, orderId: this.currentVerifiedOrder.refId }
                        );
                        throw new Error(`ProductMismatchException: Product "${item.name}" not found in Master Inventory.`);
                        }
                        
                        const category = dbMatch.category;
                        const tabsPerStrip = dbMatch.tabsPerStrip || 10;
                        // item.availQty is already a tablet count (see the verification
                        // step above) — do NOT multiply by tabsPerStrip here again.
                        let qtyToDeduct = item.availQty;

                        // ---- Strip Cut Policy (Priority 2, revised) ----
                        // Only meaningful for strip-packaged items, and only when the
                        // requested quantity isn't a whole number of strips (otherwise
                        // no strip ever needs to be opened/cut at all).
                        const isStripBased = (category === "Tablets & Capsules" || category === "Rotacaps");
                        const stripRemainder = isStripBased ? (qtyToDeduct % tabsPerStrip) : 0;
                        if (isStripBased && stripRemainder !== 0) {
                            const policy = dbMatch.stripPolicy || "always_cut";
                            const sealedQty = qtyToDeduct - stripRemainder;
                            const requestedQty = qtyToDeduct;
                            let decisionMade;

                            // Informational only: which batch a cut would actually come
                            // from, for the audit record / the modal's context. The real
                            // dispensing split is still decided later, inside the atomic
                            // FEFO RPC -- this does not change which batch gets deducted.
                            const earliestBatch = (dbMatch.batches && dbMatch.batches.length)
                                ? [...dbMatch.batches].sort((a, b) => this.parseExpiryDate(a.expiryDate) - this.parseExpiryDate(b.expiryDate))[0]
                                : null;

                            if (policy === "always_cut") {
                                decisionMade = "auto_always_cut";
                                // No pause, no change to qtyToDeduct -- proceeds exactly
                                // as production does today for every existing medicine.
                            } else if (policy === "never_cut") {
                                decisionMade = "auto_never_cut_capped";
                                // Never open a strip: dispense only whole sealed strips
                                // now, and let the EXISTING deficit/reorder path (below,
                                // keyed on item.dueQty) pick up the shortfall exactly as
                                // it would for any other Partial/Out-of-Stock item.
                                item.dueQty = (item.dueQty || 0) + stripRemainder;
                                qtyToDeduct = sealedQty;
                            } else {
                                // staff_decision: pause ONLY this line item and ask now,
                                // via the app's own modal (async/Promise-based, mobile
                                // and keyboard friendly, reuses existing modal CSS) --
                                // NOT the browser's synchronous confirm(). Awaiting this
                                // does not block other items: the for..of loop simply
                                // resumes this same iteration once staff responds: every
                                // other item is still processed one at a time, in order,
                                // exactly as before.
                                const userChoice = await this.showStripCutModal({
                                    medicineName: dbMatch.name, qtyRequested: requestedQty,
                                    tabsPerStrip, sealedQty, remainder: stripRemainder
                                });
                                if (userChoice === "cut_strip") {
                                    decisionMade = "cut_strip";
                                } else if (userChoice === "sealed_only") {
                                    decisionMade = "sealed_only";
                                    item.dueQty = (item.dueQty || 0) + stripRemainder;
                                    qtyToDeduct = sealedQty;
                                } else {
                                    // Cancelled/closed without a choice: never silently cut
                                    // without explicit permission -- fall back to the same
                                    // safe behavior as declining (sealed strips only, defer
                                    // the remainder), but record it distinctly in the audit
                                    // trail so it's clear no explicit choice was made.
                                    decisionMade = "cancelled";
                                    item.dueQty = (item.dueQty || 0) + stripRemainder;
                                    qtyToDeduct = sealedQty;
                                }
                            }

                            // Full audit record per the revised field list: Order ID,
                            // Workflow ID, Medicine ID, Medicine Name, Batch Number,
                            // Requested/Dispensed/Deferred Qty, Strip Size, Policy,
                            // Decision, User, Timestamp (decided_at defaults server-side).
                            // Append-only insert -- never updates or overwrites a row.
                            syncStripCutDecision({
                                medicineCode: dbMatch.code, medicineName: dbMatch.name,
                                batchNumber: earliestBatch ? earliestBatch.batchNumber : null,
                                orderRefId: this.currentVerifiedOrder.refId, workflowId,
                                qtyRequested: requestedQty, qtyDispensed: qtyToDeduct, qtyDeferred: requestedQty - qtyToDeduct,
                                tabsPerStrip, policy, decision: decisionMade,
                                decidedBy: this.currentUser ? this.currentUser.name : null
                            });
                            this.logAudit("Order Processing", "Strip Cut Decision",
                                { policy }, { decision: decisionMade, qtyRequested: requestedQty, qtyDispensed: qtyToDeduct, qtyDeferred: requestedQty - qtyToDeduct, batch: earliestBatch ? earliestBatch.batchNumber : null },
                                dbMatch.name, workflowId);
                        }


                        if (qtyToDeduct > 0) {
                        // ---- Real cross-device atomicity check (Priority 3) ----
                        // The checks below (dbMatch.stock < qtyToDeduct, etc.) only
                        // protect against conflicts within THIS browser's local copy
                        // of the data -- they cannot see a deduction made by another
                        // staff member's device a moment ago. deductStockAtomic() runs
                        // a real atomic UPDATE on the shared database row, so if
                        // another device already took this stock, we find out here
                        // and abort cleanly instead of both devices silently
                        // succeeding and taking inventory negative. If Supabase/the
                        // schema isn't set up yet, this is a no-op (success: null)
                        // and the existing local-only checks below still apply.
                        // ---- FEFO-safe atomic path (Priority 1) ----
                        // deduct_stock_fefo_atomic() does the earliest-expiry-first
                        // batch split AND the stock decrement inside one locked
                        // transaction, so unlike the old deductStockAtomic() +
                        // client-side split + separate upsert, there's no window
                        // where two devices can race on the batches array. We try
                        // this first; if the migration hasn't been run yet or
                        // Supabase isn't configured, we fall back to the exact
                        // previous behavior (local split + deductStockAtomic),
                        // completely unchanged, below.
                        const fefoResult = await this.deductStockFEFOAtomic(dbMatch.code, qtyToDeduct);

                        if (fefoResult.success === true) {
                            // Server is authoritative: adopt its post-deduction
                            // batches/stock as-is rather than recomputing locally.
                            dbMatch.batches = fefoResult.updatedBatches || dbMatch.batches;
                            dbMatch.stock = fefoResult.newStock;

                            for (const b of (fefoResult.breakdown || [])) {
                                const loggedQty = (category === "Tablets & Capsules" || category === "Rotacaps")
                                    ? Math.round(b.qtyDeducted / tabsPerStrip)
                                    : Math.round(b.qtyDeducted);
                                history.push({
                                    datetime: nowStr,
                                    type: "STOCK OUT",
                                    tabletName: dbMatch.name,
                                    tabletCode: dbMatch.code,
                                    workflowId: workflowId,
                                    batch: b.batchNumber,
                                    qty: loggedQty,
                                    details: `Fulfilled order ${this.currentVerifiedOrder.refId} (Batch: ${b.batchNumber})`
                                });
                            }
                            deductCount++;
                        } else if (fefoResult.success === false) {
                            this.triggerNotification(
                                "Inventory", "Cross-device inventory conflict",
                                `🔴 Inventory Concurrency Conflict (Cross-Device)\nMedicine: "${dbMatch.name}"\nAnother device already deducted this stock, or shared stock is insufficient. Current shared stock: ${fefoResult.newStock}\nPlease re-verify this order.`,
                                "Critical", { medicineName: dbMatch.name, orderId: this.currentVerifiedOrder.refId }
                            );
                            throw new Error(`ConcurrencyConflictException: Stock for "${dbMatch.name}" was already deducted by another device, or shared stock is insufficient. Shared stock: ${fefoResult.newStock}`);
                        } else {
                            // fefoResult.success === null: migration not run yet, or
                            // Supabase not configured -- exact previous behavior,
                            // untouched.
                            const atomicResult = await this.deductStockAtomic(dbMatch.code, qtyToDeduct);
                            if (atomicResult.success === false) {
                                this.triggerNotification(
                                    "Inventory", "Cross-device inventory conflict",
                                    `🔴 Inventory Concurrency Conflict (Cross-Device)\nMedicine: "${dbMatch.name}"\nAnother device already deducted this stock. Current shared stock: ${atomicResult.newStock}\nPlease re-verify this order.`,
                                    "Critical", { medicineName: dbMatch.name, orderId: this.currentVerifiedOrder.refId }
                                );
                                throw new Error(`ConcurrencyConflictException: Stock for "${dbMatch.name}" was already deducted by another device. Shared stock: ${atomicResult.newStock}`);
                            }

                            if (dbMatch.stock < qtyToDeduct) {
                                this.triggerNotification(
                                "Inventory", "Inventory calculation error",
                                `🔴 Inventory Concurrency Conflict\nMedicine: "${dbMatch.name}"\nAvailable: ${dbMatch.stock} units  Required: ${qtyToDeduct} units\nStock changed between verification and commit. Please re-verify.`,
                                "Critical", { medicineName: dbMatch.name, orderId: this.currentVerifiedOrder.refId }
                            );
                            throw new Error(`ConcurrencyConflictException: Stock for "${dbMatch.name}" changed since verification. Available: ${dbMatch.stock}, Required: ${qtyToDeduct}`);
                            }
                            if (dbMatch.stock - qtyToDeduct < 0) {
                                throw new Error(`ConstraintViolationException: Negative inventory not allowed for "${dbMatch.name}".`);
                            }

                            // Deduct stock using FIFO by expiry date
                            dbMatch.batches = dbMatch.batches || [];

                            const sortedBatches = [...dbMatch.batches].sort((a, b) => {
                                return this.parseExpiryDate(a.expiryDate) - this.parseExpiryDate(b.expiryDate);
                            });

                            let remainingDeduct = qtyToDeduct;
                            for (let b of sortedBatches) {
                                if (remainingDeduct <= 0) break;

                                if (b.quantity > 0) {
                                    const deduct = Math.min(b.quantity, remainingDeduct);
                                    b.quantity -= deduct;
                                    remainingDeduct -= deduct;

                                    const loggedQty = (category === "Tablets & Capsules" || category === "Rotacaps")
                                        ? Math.round(deduct / tabsPerStrip)
                                        : Math.round(deduct);

                                    // Record movement history per batch
                                    history.push({
                                        datetime: nowStr,
                                        type: "STOCK OUT",
                                        tabletName: dbMatch.name,
                                        tabletCode: dbMatch.code,
                                        workflowId: workflowId,
                                        batch: b.batchNumber,
                                        qty: loggedQty,
                                        details: `Fulfilled order ${this.currentVerifiedOrder.refId} (Batch: ${b.batchNumber})`
                                    });
                                }
                            }

                            // Sync total stock
                            dbMatch.stock = dbMatch.batches.reduce((sum, b) => sum + b.quantity, 0);
                            deductCount++;
                        }
                        } // end if (qtyToDeduct > 0) -- Priority 2 strip-cut guard

                        // Log standardized activity: Inventory Reserved
                        if (qtyToDeduct > 0) {
                            history.push({
                                datetime: nowStr,
                                type: "Inventory Reserved",
                                tabletName: dbMatch.name,
                                tabletCode: dbMatch.code,
                                workflowId: workflowId,
                                batch: "N/A",
                                qty: qtyToDeduct,
                                details: `Reserved stock for dispensary ${this.currentVerifiedOrder.dispensaryId} (Order: ${this.currentVerifiedOrder.refId})`
                            });
                        }
                    }

                    // 2. Deficits (Partial Stock or No Stock) go ONLY to Reorder.
                    // Due Orders are never created here -- only unresolved Reorder
                    // items that remain after the Administrator's Day End Approval
                    // are ever moved into Due Orders (see approveReorderDayEnd()).
                    // Items marked Not Available (Priority 6) are a completely
                    // separate workflow -- they must NEVER become a Reorder/Due
                    // entry, since the whole point of "Not Available" is that
                    // staff have already decided not to chase this shortfall.
                    if (item.dueQty > 0 && !item.notAvailable) {
                        // Log standardized activity: Reorder Created
                        history.push({
                            datetime: nowStr,
                            type: "Reorder Created",
                            tabletName: item.name,
                            tabletCode: dbMatch ? dbMatch.code : null,
                            workflowId: workflowId,
                            batch: "N/A",
                            qty: item.dueQty,
                            details: `Logged reorder requirement of ${item.dueQty} tablet(s) for dispensary ${this.currentVerifiedOrder.dispensaryId} (Order: ${this.currentVerifiedOrder.refId})`
                        });

                        loggedReorderCount++;

                        // Auto-add to Reorder Management
                        const reorders = this.getReorders();
                        const existingReorder = reorders.find(r =>
                            r.tabletName === item.name &&
                            r.dispensaryId === this.currentVerifiedOrder.dispensaryId &&
                            r.orderId === this.currentVerifiedOrder.refId &&
                            r.status !== "Completed"
                        );
                        if (existingReorder) {
                            existingReorder.toOrderQty += item.dueQty;
                            existingReorder.lastUpdated = nowStr;
                        } else {
                            // Master Data is the single source of truth: reuse the
                            // already-resolved record from this workflow's earlier
                            // Medicine Identity Engine pass -- never search by name again.
                            const tabObj = dbMatch;
                            const tempId = dbMatch ? null : `NEW-${item.name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40)}`;
                            reorders.push({
                                id: `ro-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                                workflowId: workflowId,
                                dispensaryId: this.currentVerifiedOrder.dispensaryId || "VEP",
                                dispensaryName: this.currentVerifiedOrder.dispensaryName || "",
                                orderId: this.currentVerifiedOrder.refId,
                                date: this.currentVerifiedOrder.date || nowStr.split(" ")[0],
                                tabletName: item.name,
                                tabletCode: dbMatch ? dbMatch.code : tempId,
                                tempId: tempId,
                                genericName: tabObj ? (tabObj.drugName || "N/A") : "N/A",
                                strength: tabObj ? (tabObj.strength || "") : "",
                                category: tabObj ? (tabObj.category || "") : "",
                                reqQty: item.reqQty,
                                availQty: item.availQty || 0,
                                toOrderQty: item.dueQty,
                                priority: "Normal",
                                status: "Pending",
                                isNewMedicine: !!item.isNewMedicine,
                                supplier: tabObj ? (tabObj.manufacturer || tabObj.brand || "") : "",
                                notes: item.isNewMedicine ? "New Medicine — not yet in Master Data. Will be auto-linked to a permanent Master Data Code once purchased via Supplier Bill Processing." : "",
                                lastUpdated: nowStr
                            });
                        }
                        this.setReorders(reorders);
                    }
                }

                // Save Morning Order permanently
                const scannedOrders = this.getScannedOrders();
                const totalReq = this.currentVerifiedOrder.items.reduce((sum, item) => sum + item.reqQty, 0);
                const totalAvail = this.currentVerifiedOrder.items.reduce((sum, item) => sum + item.availQty, 0);
                const totalDue = this.currentVerifiedOrder.items.reduce((sum, item) => sum + item.dueQty, 0);
                
                let orderStatus = "Completed";
                if (totalDue > 0) {
                    orderStatus = totalAvail > 0 ? "Partially Completed" : "Pending";
                }

                const scannedOrderRecord = {
                    id: `ord-sheet-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    workflowId: workflowId,
                    dispensaryId: this.currentVerifiedOrder.dispensaryId || "VEP",
                    dispensaryName: this.currentVerifiedOrder.dispensaryName || "Vepary Dispensary",
                    customer: this.currentVerifiedOrder.dispensaryName || "Vepary Dispensary",
                    refId: this.currentVerifiedOrder.refId,
                    date: this.currentVerifiedOrder.date || nowStr.split(" ")[0],
                    medicines: this.currentVerifiedOrder.items.map(item => ({
                        name: item.name,
                        reqQty: item.reqQty,
                        availQty: item.availQty || 0,
                        dueQty: item.dueQty || 0
                    })),
                    status: orderStatus,
                    timestamp: nowStr
                };
                scannedOrders.push(scannedOrderRecord);

                // Finalize this Workflow's status. Fully available orders go
                // straight to "Inventory Updated" (nothing left pending);
                // orders with any shortfall move to "Reorder Pending" since
                // Reorder entries were just created above. Neither is
                // "Completed" yet -- that only happens once the outstanding
                // Reorder is fulfilled by a Supplier Bill (or, if it survives
                // to Day End, once it becomes a Due Order and is later closed).
                if (workflowId) {
                    if (totalDue > 0) {
                        this.updateWorkflowStatus(workflowId, "Reorder Pending");
                        this.logWorkflowEvent(workflowId, "Reorder Created", "Reorder", `${loggedReorderCount} item(s) moved to Reorder (Order: ${this.currentVerifiedOrder.refId}).`);
                    } else {
                        this.updateWorkflowStatus(workflowId, "Inventory Updated");
                    }
                    this.logWorkflowEvent(workflowId, "Stock Reserved", "Inventory Verification", `Reserved and deducted stock for ${deductCount} item(s) (Order: ${this.currentVerifiedOrder.refId}).`);
                }

                // Save all state updates — await cloud confirmation so a
                // failed sync is surfaced immediately, not assumed.
                const orderBatchResult = await this.commitBatch([
                    { key: "ti_scanned_orders", data: scannedOrders, label: "Scanned Orders" },
                    { key: "ti_tablets", data: tablets, label: "Master Data / Tablets" },
                    { key: "ti_history", data: history, label: "Movement History" }
                ], "Order Processing");
                this.logAudit("Order Processing", "Verify Order", null,
                    { refId: this.currentVerifiedOrder.refId, status: orderStatus, itemsCount: this.currentVerifiedOrder.items.length },
                    this.currentVerifiedOrder.refId, workflowId);

                // Commit transaction and clear locks
                this.commitTransaction();

                if (orderBatchResult.allCloudOk) {
                    this.showToast(`Order processed. Stock reserved & deducted: ${deductCount} item(s). Reorder logged: ${loggedReorderCount} item(s).`);
                } else {
                    this.showToast(`Order processed locally (${deductCount} item(s) deducted). Cloud sync will retry automatically.`, "warning");
                }
                this.resetOrderVerification();
                
                // Clear builder form
                document.getElementById("builder-items-rows").innerHTML = "";
                
                // Re-populate dispensary fields with blank/defaults
                const dispIdInput = document.getElementById("order-dispensary-id");
                if (dispIdInput) dispIdInput.value = "";
                const dispNameInput = document.getElementById("order-dispensary-name");
                if (dispNameInput) dispNameInput.value = "";
                const orderRefIdInput = document.getElementById("order-ref-id");
                if (orderRefIdInput) orderRefIdInput.value = "";
                
                this.addOrderBuilderRow();
                
                this.renderDashboard();
                this.renderReorderPage();
                
                // Switch tab to show Reorder page if a deficit was registered
                // (Due Orders are populated only via Day End Approval, not here).
                if (loggedReorderCount > 0) {
                    this.switchTab("reorder-view");
                } else {
                    this.switchTab("dashboard-view");
                }
            } catch (err) {
                // Rollback any partial database modifications
                this.rollbackTransaction();
                console.error("Reservation transaction rolled back:", err);
                this.triggerNotification(
                    "Order Processing", "System exception",
                    `🔴 Order Verification Exception\nError: ${err.message}\nTransaction rolled back. All partial changes undone.`,
                    "Critical", { stackTrace: err.stack }
                );
                this.showToast(`Verification Failed: ${err.message}`, "error");
            }
        }


        // --- INVENTORY ADJUSTMENTS PAGE ---
        renderInventoryAdjustPage() {
            this.renderHistoryList();
            
            // Populate datalist for manual adjustments text input
            const datalist = document.getElementById("adjust-tablet-datalist");
            if (datalist) {
                datalist.innerHTML = "";
                const tablets = this.getTablets();
                tablets.forEach(tab => {
                    const opt = document.createElement("option");
                    opt.value = tab.name;
                    datalist.appendChild(opt);
                });
            }
        }

        renderHistoryList(searchQuery = "") {
            const tableBody = document.getElementById("batch-history-table-body");
            if (!tableBody) return;

            tableBody.innerHTML = "";
            const history = this.getHistory();
            const q = searchQuery.toLowerCase().trim();

            const filteredHistory = history.filter(h => 
                (h.tabletName || "").toLowerCase().includes(q) || 
                (h.supplierName || "").toLowerCase().includes(q) || 
                (h.invoiceNumber || "").toLowerCase().includes(q) || 
                h.type.toLowerCase().includes(q)
            );

            // Sort by latest datetime first
            const sortedHistory = [...filteredHistory].sort((a, b) => new Date(b.datetime) - new Date(a.datetime));

            if (sortedHistory.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No history logs match filters.</td></tr>`;
                return;
            }

            sortedHistory.forEach(log => {
                let badgeClass = "badge-info";
                if (log.type === "Inventory Reserved" || log.type === "STOCK OUT") badgeClass = "badge-danger";
                else if (log.type === "Purchase Bill Uploaded" || log.type === "STOCK IN") badgeClass = "badge-success";
                else if (log.type.includes("Due") || log.type.includes("DUE")) badgeClass = "badge-warning";
                else if (log.type === "Order Verified" || log.type === "Order Uploaded") badgeClass = "badge-info";
                else if (log.type === "Inventory Updated") badgeClass = "badge-info";

                const tr = document.createElement("tr");
                const qtyLabel = (log.type === "Order Uploaded" || log.type === "Order Verified")
                    ? `${log.qty} item${log.qty === 1 ? "" : "s"}`
                    : `${log.qty} packs`;
                tr.innerHTML = `
                    <td><code>${log.datetime}</code></td>
                    <td><span class="status-badge ${badgeClass}">${log.type}</span></td>
                    <td>${log.supplierName || "—"}</td>
                    <td><code>${log.invoiceNumber || "—"}</code></td>
                    <td>${qtyLabel}</td>
                    <td>${log.details}</td>
                `;
                tableBody.appendChild(tr);
            });
        }

        applyStockAdjustment() {
            const adjustType = document.querySelector('input[name="adjust-type"]:checked').value;
            const tabletName = document.getElementById("adjust-tablet-select").value.trim();
            const qty = parseInt(document.getElementById("adjust-qty").value);
            const batch = document.getElementById("adjust-batch").value.trim().toUpperCase();
            const reason = document.getElementById("adjust-reason").value.trim();

            if (!tabletName || isNaN(qty) || !batch || !reason) {
                this.showToast("All fields are required.", "error");
                return;
            }
            // High-value medicine alert for Inventory Adjustment
            this.checkHighValueMedicineAlert(tabletName, qty + " packs", "Inventory");

            // Resolve the typed name BEFORE touching the database / starting a
            // transaction, using the same Medicine Identity Engine cascade
            // (resolveMedicine: Product Code -> Brand+Strength+Form -> Generic
            // -> Fuzzy >95%) that Bill/Order Processing already relies on.
            // This closes the gap where manual Stock In used to silently
            // auto-create a permanent Master Data record from an exact-string
            // mismatch (e.g. "Roseday-10" vs "ROSEDAY 10") with no review.
            let tablets = this.getTablets();
            let matched = tablets.find(t => t.name.toLowerCase() === tabletName.toLowerCase() || t.code.toLowerCase() === tabletName.toLowerCase());

            if (!matched) {
                const resolution = this.resolveMedicine(tabletName, null, tablets);
                if (resolution.status === "exact" && resolution.tablet) {
                    matched = tablets.find(t => t.code === resolution.tablet.code) || resolution.tablet;
                } else if (adjustType === "OUT") {
                    this.showToast(`Cannot perform Stock Out: Product "${tabletName.toUpperCase()}" not found in inventory.`, "error");
                    return;
                } else {
                    // No confident match -- never auto-create. Ask first, and
                    // route any confirmed creation through the normal Add
                    // Medicine workflow (openAddTabletModal / saveTabletForm),
                    // so it goes through the same duplicate-prevention check
                    // rather than bypassing it here.
                    const candidates = (resolution.candidates || []).slice(0, 5);
                    const candidateList = candidates.map(c => `• ${c.name} (${c.code})`).join("\n");
                    const msg = candidates.length > 0
                        ? `"${tabletName}" doesn't exactly match Master Data, but similar medicine(s) already exist:\n\n${candidateList}\n\nCreate "${tabletName}" as a brand-new medicine anyway?`
                        : `"${tabletName}" was not found in Master Data.\n\nCreate it as a brand-new medicine?`;

                    if (!confirm(msg)) {
                        this.showToast("Stock adjustment cancelled. Adjust the name or use Add New Medicine to create this product deliberately.", "info");
                        return;
                    }

                    // Hand off to the normal Add Medicine workflow, prefilled
                    // with what was typed here. Stock In can be completed
                    // afterwards from the Add Tablet form (or by re-running
                    // this adjustment) once the medicine has been reviewed
                    // and saved -- it is never created inline from this modal.
                    this.openAddTabletModal();
                    this.prefillAddTabletFromOCRName(tabletName);
                    const stockEl = document.getElementById("tab-stock");
                    if (stockEl) stockEl.value = qty;
                    const batchEl = document.getElementById("tab-batch");
                    if (batchEl) batchEl.value = batch;
                    this.showToast("Review the medicine details and click Save Tablet to create it and record this stock.", "info");
                    return;
                }
            }

            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

            try {
                // Begin atomic transaction and check database lock
                this.beginTransaction();
                tablets = this.getTablets();
                matched = tablets.find(t => t.code === matched.code);
                if (!matched) {
                    throw new Error("Matched product no longer exists in Master Data (may have been deleted). Please re-select.");
                }
                {
                    // Apply adjustment to existing product
                    matched.batches = matched.batches || [];
                    
                    if (adjustType === "OUT") {
                        const batchMatch = matched.batches.find(b => b.batchNumber === batch);
                        const batchQty = batchMatch ? batchMatch.quantity : 0;
                        if (batchQty < qty) {
                            throw new Error(`Insufficient stock in Batch "${batch}"! Available: ${batchQty} packs. Requested reduction: ${qty} packs.`);
                        }
                        if (matched.stock - qty < 0) {
                            throw new Error(`ConstraintViolationException: Stock adjustment would result in negative total stock for "${matched.name}".`);
                        }
                        if (batchMatch) {
                            batchMatch.quantity -= qty;
                        }
                        matched.stock = matched.batches.reduce((sum, b) => sum + b.quantity, 0);
                        this.setTablets(tablets);
                        
                        // Log standardized activity: Inventory Updated
                        this.logHistory(
                            "Inventory Updated",
                            matched.name,
                            batch,
                            qty,
                            `Stock-out manual adjustment: ${reason}`
                        );
                        
                        this.showToast("Stock adjustment logged successfully.");
                    } else {
                        // This is Stock In!
                        const remainingQty = this.allocateIncomingStock(matched.name, qty);
                        const batchMatch = matched.batches.find(b => b.batchNumber === batch);
                        if (batchMatch) {
                            batchMatch.quantity += remainingQty;
                        } else {
                            matched.batches.push({
                                batchNumber: batch,
                                expiryDate: "12/28",
                                quantity: remainingQty,
                                mrp: matched.mrp || 0,
                                cost: matched.cost || 0
                            });
                        }
                        matched.stock = matched.batches.reduce((sum, b) => sum + b.quantity, 0);
                        this.setTablets(tablets);
                        
                        // Log standardized activity: Inventory Updated
                        this.logHistory(
                            "Inventory Updated",
                            matched.name,
                            batch,
                            qty,
                            `Stock-in manual adjustment: ${reason} (Allocated ${qty - remainingQty} to dues)`
                        );
                        
                        this.showToast(`Stock adjustment logged successfully (Allocated ${qty - remainingQty} to dues).`);
                    }
                }

                // Commit transaction and clear locks
                this.commitTransaction();

                document.getElementById("stock-adjust-form").reset();
                
                // Refresh ALL inventory lists & select box data sources immediately
                this.renderInventoryAdjustPage();
                this.renderTabletList();
                this.renderDashboard();
                this.renderDueOrdersPage();
            } catch (err) {
                // Rollback database modifications on exception
                this.rollbackTransaction();
                console.error("Manual adjustment transaction rolled back:", err);
                this.triggerNotification(
                    "Inventory", "System exception",
                    "Inventory Adjustment Exception\nError: " + err.message + "\nTransaction rolled back. All partial changes undone.",
                    "Critical", { stackTrace: err.stack }
                );
                this.showToast(`Adjustment Failed: ${err.message}`, "error");
            }
        }

        logHistory(type, tabletName, batch, qty, details, extra = {}) {
            const history = this.getHistory();
            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

            const entry = {
                id: extra.txnId || `txn-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                datetime: nowStr,
                type: type,
                tabletName: tabletName,
                tabletCode: extra.code || null,
                workflowId: extra.workflowId || null,
                orderId: extra.orderId || null,
                batch: batch,
                qty: qty,
                details: details,
                supplierName: extra.supplierName || null,
                invoiceNumber: extra.invoiceNumber || null,
                performedBy: extra.performedBy || (this.currentUser && this.currentUser.name) || null,
                performedByRole: (this.currentUser && this.currentUser.role) || null,
                dispensaryId: extra.dispensaryId || null,
                dispensaryName: extra.dispensaryName || null,
                medicineId: extra.medicineId || null,
                strength: extra.strength || null,
                manufacturer: extra.manufacturer || null,
                company: extra.company || null,
                expiryDate: extra.expiryDate || null,
                purchasePrice: extra.purchasePrice ?? null,
                mrp: extra.mrp ?? null,
                previousStock: extra.previousStock ?? null,
                newStock: extra.newStock ?? null,
                reason: extra.reason || null,
                verificationStatus: extra.verificationStatus || null
            };
            history.push(entry);
            this.setHistory(history);
            // Row-level insert (append-only, unlike the blob above) so
            // Dispensary/Medicine Analytics can query history with real
            // SQL date/dispensary filters instead of the whole array.
            syncHistoryRow(entry);
            // Normalized, enterprise-reporting-grade transaction row.
            // Upserted on transaction_ref (= entry.id), so a retried or
            // duplicate call updates the same row rather than inserting
            // a second one. Fields not passed via `extra` at this call
            // site are stored as null, not fabricated.
            syncInventoryTransactionRow(entry);
        }


        renderDueOrdersPage(searchQuery = "") {
            const tableBody = document.getElementById("due-orders-table-body");
            if (!tableBody) return;

            tableBody.innerHTML = "";
            const dues = this.getDueOrders();
            const tablets = this.getTablets();

            // Calculate KPIs
            const activeDues = dues.filter(d => d.status === "Pending" || d.status === "Partially Completed");
            const partialDues = dues.filter(d => d.status === "Partially Completed");
            
            // Completed today
            const todayStr = new Date().toISOString().split('T')[0];
            const completedToday = dues.filter(d => d.status === "Completed" && d.lastUpdated && d.lastUpdated.startsWith(todayStr));
            
            // Total quantity due
            const totalQtyDue = activeDues.reduce((sum, d) => sum + d.dueQty, 0);

            // Update KPI elements
            const kpiTotalOrders = document.getElementById("due-kpi-total-orders");
            if (kpiTotalOrders) kpiTotalOrders.textContent = activeDues.length;
            const kpiOrdersTrend = document.getElementById("due-kpi-orders-trend");
            if (kpiOrdersTrend) {
                kpiOrdersTrend.textContent = activeDues.length > 0 ? "Needs Stock" : "All Cleared";
                kpiOrdersTrend.className = activeDues.length > 0 ? "kpi-trend negative" : "kpi-trend positive";
            }

            const kpiPartial = document.getElementById("due-kpi-partial-orders");
            if (kpiPartial) kpiPartial.textContent = partialDues.length;

            const kpiCompleted = document.getElementById("due-kpi-completed-today");
            if (kpiCompleted) kpiCompleted.textContent = completedToday.length;

            const kpiTotalQty = document.getElementById("due-kpi-total-qty");
            if (kpiTotalQty) kpiTotalQty.textContent = totalQtyDue;

            // Apply filters
            const statusFilter = this._activeDueStatusFilter || "ALL";
            const q = searchQuery.toLowerCase().trim();

            const filteredDues = dues.filter(d => {
                // Day End carryover items (balance tablets due the next day)
                // are kept out of the main tab so the order team isn't
                // confused into actioning them early -- they only appear
                // under the dedicated "Reorder History" filter.
                if (statusFilter === "HISTORY") {
                    if (!d.isDayEndCarryover) return false;
                } else if (d.isDayEndCarryover) {
                    return false;
                }

                // Status match
                if (statusFilter !== "ALL" && statusFilter !== "HISTORY" && d.status !== statusFilter) return false;

                // Search match
                if (q) {
                    const dispId = (d.dispensaryId || "").toLowerCase();
                    const dispName = (d.dispensaryName || "").toLowerCase();
                    const orderId = (d.orderId || "").toLowerCase();
                    const tabName = (d.tabletName || "").toLowerCase();
                    return dispId.includes(q) || dispName.includes(q) || orderId.includes(q) || tabName.includes(q);
                }

                return true;
            });

            // Reset Select All checkbox
            const selectAllCheckbox = document.getElementById("due-select-all");
            if (selectAllCheckbox) selectAllCheckbox.checked = false;

            if (filteredDues.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="14" class="text-center text-muted" style="padding: 20px;">No due records match the filters.</td></tr>`;
                return;
            }

            // Render matching rows
            [...filteredDues].reverse().forEach(due => {
                const tabObj = (due.tabletCode && due.tabletCode !== "N/A" ? this.getTabletByCode(due.tabletCode) : null) || tablets.find(t => t.name === due.tabletName);
                
                let currentStock = 0;
                let tabsPerStrip = 10;
                if (tabObj) {
                    tabsPerStrip = tabObj.tabsPerStrip || 10;
                    const category = tabObj.category;
                    if (category === "Tablets & Capsules" || category === "Rotacaps") {
                        currentStock = Math.round(tabObj.stock / tabsPerStrip); // strips for fulfill check
                    } else {
                        currentStock = Math.round(tabObj.stock);
                    }
                }
                
                let badgeClass = "badge-danger";
                if (due.status === "Completed") badgeClass = "badge-success";
                else if (due.status === "Partially Completed") badgeClass = "badge-warning";
                else if (due.status === "Cancelled") badgeClass = "badge-info";

                // Priority Badge Class
                const prio = due.priority || "Normal";
                let prioBadge = "badge-info";
                if (prio === "High") prioBadge = "badge-warning";
                else if (prio === "Critical") prioBadge = "badge-danger";

                const canFulfill = (due.status === "Pending" || due.status === "Partially Completed") && currentStock >= due.dueQty;
                const showFulfillBtn = due.status === "Pending" || due.status === "Partially Completed";

                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td style="text-align: center;"><input type="checkbox" class="due-row-select" data-id="${due.id}" onclick="event.stopPropagation()" style="cursor:pointer;"></td>
                    <td><span class="status-badge ${prioBadge}">${prio}</span></td>
                    <td><strong>${due.dispensaryId || "N/A"}</strong></td>
                    <td>${due.dispensaryName || "N/A"}</td>
                    <td><code>${due.orderId || "N/A"}</code></td>
                    <td>${due.tabletName}</td>
                    <td>${this.fmtStock(due.reqQty, tabsPerStrip, tabObj ? tabObj.category : "Tablets & Capsules")}</td>
                    <td>${this.fmtStock((due.allocatedQty || 0), tabsPerStrip, tabObj ? tabObj.category : "Tablets & Capsules")}</td>
                    <td><span class="font-weight-700 text-coral">${this.fmtStock(due.dueQty, tabsPerStrip, tabObj ? tabObj.category : "Tablets & Capsules")}</span></td>
                    <td>${due.date || "—"}</td>
                    <td>${due.dueDate || "—"}</td>
                    <td><span class="status-badge ${badgeClass}">${due.status}</span></td>
                    <td><span style="font-size: 0.8rem; color: var(--text-muted); font-style: italic;">${due.notes || "—"}</span></td>
                    <td>
                        <div style="display: flex; gap: 6px;">
                            ${showFulfillBtn ? `
                                <button class="btn btn-success btn-sm" onclick="window.app.fulfillDue('${due.id}')" ${canFulfill ? '' : 'disabled'} title="Fulfill with stock">
                                    Fulfill
                                </button>
                            ` : ''}
                            <button class="btn btn-secondary btn-sm" onclick="window.app.openEditDueModal('${due.id}')" title="Edit due item">
                                Edit
                            </button>
                            ${due.status !== "Cancelled" && due.status !== "Completed" ? `
                                <button class="btn btn-outline btn-sm" onclick="window.app.cancelDueOrder('${due.id}')" title="Cancel order and return stock">
                                    Cancel
                                </button>
                            ` : ''}
                            <button class="btn btn-outline btn-sm danger" onclick="window.app.deleteDueOrder('${due.id}')" title="Delete due order record">
                                Delete
                            </button>
                        </div>
                    </td>
                `;
                tableBody.appendChild(tr);
            });
        }

        // Multi-select Checkbox Controls
        toggleSelectAllDues(master) {
            document.querySelectorAll(".due-row-select").forEach(cb => {
                cb.checked = master.checked;
            });
        }

        // Merge Selected Due Orders (Same Product & Same Dispensary)
        mergeSelectedDues() {
            const selectedCbs = document.querySelectorAll(".due-row-select:checked");
            if (selectedCbs.length < 2) {
                this.showToast("Please select at least 2 due orders to merge.", "warning");
                return;
            }

            let dues = this.getDueOrders();
            const selectedIds = Array.from(selectedCbs).map(cb => cb.getAttribute("data-id"));
            const itemsToMerge = dues.filter(d => selectedIds.includes(d.id));

            // Validation: Must all have same product and same dispensary ID
            const firstItem = itemsToMerge[0];
            const hasMismatch = itemsToMerge.some(item => 
                item.tabletName.toLowerCase() !== firstItem.tabletName.toLowerCase() ||
                (item.dispensaryId || "").toLowerCase() !== (firstItem.dispensaryId || "").toLowerCase()
            );

            if (hasMismatch) {
                this.showToast("Selected due orders must be for the same product and dispensary to merge.", "error");
                return;
            }

            const activeItems = itemsToMerge.filter(d => d.status === "Pending" || d.status === "Partially Completed");
            if (activeItems.length < 2) {
                this.showToast("You can only merge active (Pending/Partially Completed) due orders.", "error");
                return;
            }

            if (!confirm(`Are you sure you want to merge these ${activeItems.length} due orders into a single consolidated record?`)) {
                return;
            }

            try {
                this.beginTransaction();

                // Sort by date (ascending) so the oldest remains as primary (FIFO priority)
                activeItems.sort((a, b) => new Date(a.date) - new Date(b.date));
                const primary = activeItems[0];
                const secondaryItems = activeItems.slice(1);

                // Consolidated quantities
                let mergedReqQty = primary.reqQty;
                let mergedAllocatedQty = primary.allocatedQty || 0;
                let concatenatedNotes = primary.notes || "";

                secondaryItems.forEach(sec => {
                    mergedReqQty += sec.reqQty;
                    mergedAllocatedQty += sec.allocatedQty || 0;
                    
                    if (sec.notes) {
                        concatenatedNotes = concatenatedNotes 
                            ? `${concatenatedNotes} | ${sec.notes}` 
                            : sec.notes;
                    }
                    
                    // Mark secondary as Cancelled or remove them. We delete them from list.
                    dues = dues.filter(d => d.id !== sec.id);
                });

                // Update primary item
                const primaryIndex = dues.findIndex(d => d.id === primary.id);
                if (primaryIndex !== -1) {
                    dues[primaryIndex].reqQty = mergedReqQty;
                    dues[primaryIndex].allocatedQty = mergedAllocatedQty;
                    dues[primaryIndex].dueQty = mergedReqQty - mergedAllocatedQty;
                    dues[primaryIndex].notes = concatenatedNotes ? `${concatenatedNotes} (Merged)` : "Merged consolidated due";
                    dues[primaryIndex].lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
                    
                    if (dues[primaryIndex].dueQty === 0) {
                        dues[primaryIndex].status = "Completed";
                        dues[primaryIndex].dueDate = new Date().toISOString().split('T')[0];
                    } else if (mergedAllocatedQty > 0) {
                        dues[primaryIndex].status = "Partially Completed";
                    } else {
                        dues[primaryIndex].status = "Pending";
                    }
                }

                this.setDueOrders(dues);

                this.logHistory(
                    "Inventory Updated",
                    primary.tabletName,
                    "N/A",
                    primary.dueQty,
                    `Merged ${activeItems.length} due items for dispensary ${primary.dispensaryId} into a single record.`
                );

                this.commitTransaction();
                this.showToast("Due orders merged successfully!", "success");
                this.renderDueOrdersPage();
                this.renderDashboard();
            } catch (err) {
                this.rollbackTransaction();
                console.error("Merge due orders failed:", err);
                this.showToast(`Merge Failed: ${err.message}`, "error");
            }
        }

        // Split active due item into a new due item
        splitDueOrder() {
            const dueId = document.getElementById("edit-due-id").value;
            const splitQtyVal = document.getElementById("due-split-qty").value.trim();
            
            if (!dueId || !splitQtyVal) {
                this.showToast("Please enter a split quantity.", "warning");
                return;
            }

            const splitQty = parseInt(splitQtyVal);
            if (isNaN(splitQty) || splitQty <= 0) {
                this.showToast("Split quantity must be a positive number.", "error");
                return;
            }

            let dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem) return;

            if (dueItem.dueQty <= splitQty) {
                this.showToast(`Split quantity must be strictly less than the current due quantity (${dueItem.dueQty} packs).`, "error");
                return;
            }

            if (!confirm(`Are you sure you want to split off ${splitQty} packs from this due order into a new record?`)) {
                return;
            }

            try {
                this.beginTransaction();

                const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

                // Create the split-off due item
                const newSplitItem = {
                    id: `due-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    dispensaryId: dueItem.dispensaryId,
                    dispensaryName: dueItem.dispensaryName,
                    orderId: `${dueItem.orderId}-SPLIT`,
                    date: dueItem.date || nowStr.split(" ")[0],
                    dueDate: "",
                    tabletCode: dueItem.tabletCode || "N/A",
                    tabletName: dueItem.tabletName,
                    reqQty: splitQty,
                    allocatedQty: 0,
                    dueQty: splitQty,
                    status: "Pending",
                    priority: dueItem.priority || "Normal",
                    notes: `Split from order ${dueItem.orderId} (Original qty: ${dueItem.reqQty})`,
                    lastUpdated: nowStr
                };

                // Adjust the original due item
                dueItem.reqQty -= splitQty;
                dueItem.dueQty -= splitQty;
                dueItem.notes = dueItem.notes 
                    ? `${dueItem.notes} (Split off ${splitQty} packs)` 
                    : `Split off ${splitQty} packs`;
                dueItem.lastUpdated = nowStr;

                dues.push(newSplitItem);
                this.setDueOrders(dues);

                this.logHistory(
                    "Inventory Updated",
                    dueItem.tabletName,
                    "N/A",
                    splitQty,
                    `Split due order ${dueItem.orderId} (Split off ${splitQty} packs to a new record).`
                );

                this.commitTransaction();
                
                document.getElementById("due-split-qty").value = "";
                this.showToast(`Split completed! Created a new due order for ${splitQty} packs.`, "success");
                this.closeDueModal();
                this.renderDueOrdersPage();
                this.renderDashboard();
            } catch (err) {
                this.rollbackTransaction();
                console.error("Split due order failed:", err);
                this.showToast(`Split Failed: ${err.message}`, "error");
            }
        }

        openEditDueModal(dueId) {
            const dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem) return;

            document.getElementById("edit-due-id").value = dueItem.id;
            document.getElementById("due-dispensary-id").value = dueItem.dispensaryId || "";
            document.getElementById("due-dispensary-name").value = dueItem.dispensaryName || "";
            document.getElementById("due-order-id").value = dueItem.orderId || "";
            document.getElementById("due-tablet-name").value = dueItem.tabletName || "";
            document.getElementById("due-req-qty").value = dueItem.reqQty || "";
            document.getElementById("due-status").value = dueItem.status || "Pending";
            document.getElementById("due-priority").value = dueItem.priority || "Normal";
            document.getElementById("due-notes").value = dueItem.notes || "";
            document.getElementById("due-split-qty").value = "";

            // Check Master Inventory for available stock notice
            const tablets = this.getTablets();
            const tabObj = (dueItem.tabletCode && dueItem.tabletCode !== "N/A" ? this.getTabletByCode(dueItem.tabletCode) : null) || tablets.find(t => t.name === dueItem.tabletName);
            const noticeDiv = document.getElementById("due-inventory-notice");
            if (noticeDiv) {
                if (tabObj && tabObj.stock > 0) {
                    const currentStockUnits = tabObj.stock;
                    
                    if (currentStockUnits > 0) {
                        noticeDiv.innerHTML = `
                            <div style="font-weight: 700; margin-bottom: 6px; color: #10b981;">Stock is already available in Master Inventory.</div>
                            <div style="font-size: 0.8rem; margin-bottom: 8px;">Available Stock: <strong style="color: #fff;">${currentStockUnits} tablet(s)</strong></div>
                            <div style="display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap;">
                                <span>Allocate Quantity (tablets):</span>
                                <input type="number" id="due-allocate-input" value="${Math.min(currentStockUnits, dueItem.dueQty)}" min="1" max="${Math.min(currentStockUnits, dueItem.dueQty)}" style="width: 70px; padding: 4px 8px; font-size: 0.8rem; background: rgba(0,0,0,0.5); border: 1px solid var(--border-color); color: #fff; border-radius: 6px;">
                                <button type="button" class="btn btn-sm btn-success" onclick="window.app.allocateDueStockManual('${dueItem.id}')" style="padding: 4px 10px; font-size: 0.8rem; font-weight: 600; border: none; border-radius: 6px; cursor: pointer;">Allocate Stock</button>
                            </div>
                        `;
                        noticeDiv.classList.remove("hidden");
                    } else {
                        noticeDiv.classList.add("hidden");
                    }
                } else {
                    noticeDiv.classList.add("hidden");
                }
            }

            const modal = document.getElementById("due-modal");
            if (modal) modal.classList.add("active");
        }

        // ============================================================
        // ENTERPRISE AUTH: profile, roles, activity log, session timeout
        // ============================================================

        async loadUserProfile() {
            try {
                const sb = supabaseClient;
                if (!sb) return null;
                const { data: sessionData } = await sb.auth.getSession();
                const uid = sessionData && sessionData.session ? sessionData.session.user.id : null;
                if (!uid) return null;

                const { data: profile, error } = await sb.from("profiles").select("*").eq("id", uid).single();
                if (error || !profile) {
                    this.showToast("Signed in, but no staff profile was found for this account. Ask your Administrator to set one up.", "error");
                    return null;
                }

                this.userProfile = profile;
                this.currentUser = { name: profile.full_name, role: profile.role };

                // Update sidebar identity display
                const nameEl = document.getElementById("user-name-display");
                const roleEl = document.getElementById("user-role-display");
                const empIdEl = document.getElementById("user-employee-id-display");
                const avatarEl = document.getElementById("user-avatar-initials");
                if (nameEl) nameEl.textContent = profile.full_name;
                if (roleEl) roleEl.textContent = profile.role;
                if (empIdEl) empIdEl.textContent = profile.employee_id;
                if (avatarEl) {
                    const initials = (profile.full_name || "?").split(" ").filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
                    avatarEl.textContent = initials || "?";
                }

                // Best-effort last_login_at update (not security-critical, ignore failures)
                sb.from("profiles").update({ last_login_at: new Date().toISOString() }).eq("id", uid).then(() => {}).catch(() => {});

                return profile;
            } catch (err) {
                console.error("loadUserProfile failed:", err);
                return null;
            }
        }

        // Hide/disable UI based on the signed-in user's role, per the Enterprise
        // Auth spec. This is a UX convenience layer — the real enforcement lives
        // in Supabase RLS policies and the Edge Functions, since anything done
        // only in the browser can be bypassed by an attacker.
        applyRolePermissions() {
            const role = this.currentUser ? this.currentUser.role : "Staff";

            // Nav items tagged data-role-restrict="RoleA,RoleB" are hidden for everyone else
            document.querySelectorAll("[data-role-restrict]").forEach(el => {
                const allowed = el.getAttribute("data-role-restrict").split(",").map(s => s.trim());
                el.style.display = allowed.includes(role) ? "" : "none";
            });

            // Staff cannot Add/Edit Medicines in Master Data
            const addTabletBtn = document.querySelector('#master-view .btn-primary[onclick*="openAddTabletModal"]');
            if (addTabletBtn) addTabletBtn.style.display = (role === "Staff") ? "none" : "";
            document.querySelectorAll(".btn-icon-only[onclick*='openEditTabletModal'], .btn-icon-only.danger[onclick*='deleteTablet']").forEach(btn => {
                btn.style.display = (role === "Staff") ? "none" : "";
            });

            // Staff cannot edit OCR-extracted fields (Bill Processing) --
            // Review/Verify/Import only. Real enforcement is the guard
            // inside toggleExtractedEditMode() itself; this just hides the
            // button so Staff doesn't see an action they can't perform.
            const editOcrBtn = document.getElementById("btn-toggle-edit");
            if (editOcrBtn) editOcrBtn.style.display = (role === "Staff") ? "none" : "";
        }

        // Records an audit event for the CURRENTLY signed-in user. Best-effort:
        // failures here should never block the actual UI action that triggered them.
        async logActivityEvent(eventType, details) {
            try {
                const sb = supabaseClient;
                if (!sb || !this.userProfile) return;
                const { browser, device } = getBrowserAndDevice();
                await sb.from("activity_logs").insert({
                    employee_id: this.userProfile.employee_id,
                    full_name: this.userProfile.full_name,
                    role: this.userProfile.role,
                    event_type: eventType,
                    details: details || {},
                    browser, device,
                });
            } catch (err) {
                console.error("logActivityEvent failed:", err);
            }
        }

        // ---------- Session timeout: 30 min inactivity, 60s warning ----------
        initSessionTimeoutWatcher() {
            const INACTIVITY_MS = 30 * 60 * 1000;
            const WARNING_MS = 60 * 1000;

            const resetTimer = () => {
                if (this._sessionTimeoutTimer) clearTimeout(this._sessionTimeoutTimer);
                const warningModal = document.getElementById("session-timeout-modal");
                if (warningModal && warningModal.style.display !== "none") return; // don't reset while warning is showing
                this._sessionTimeoutTimer = setTimeout(() => this.showSessionTimeoutWarning(), INACTIVITY_MS - WARNING_MS);
            };

            // Only attach the activity listeners once per page load. Without this
            // guard, every call to initSessionTimeoutWatcher() (it's called again
            // each time extendSession() runs) added a fresh set of 5 document
            // listeners on top of the old ones, leaking listeners for the life of
            // the tab.
            if (!this._sessionActivityListenersAttached) {
                ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach(evt => {
                    document.addEventListener(evt, () => {
                        const warningModal = document.getElementById("session-timeout-modal");
                        if (warningModal && warningModal.style.display !== "none") return;
                        resetTimer();
                    }, { passive: true });
                });
                this._sessionActivityListenersAttached = true;
            }

            resetTimer();
        }

        showSessionTimeoutWarning() {
            const modal = document.getElementById("session-timeout-modal");
            const countdownEl = document.getElementById("session-timeout-countdown");
            if (!modal) return;
            modal.style.display = "flex";
            let secondsLeft = 60;
            countdownEl.textContent = secondsLeft;
            this._sessionCountdownInterval = setInterval(() => {
                secondsLeft -= 1;
                countdownEl.textContent = Math.max(secondsLeft, 0);
                if (secondsLeft <= 0) {
                    clearInterval(this._sessionCountdownInterval);
                    this.logActivityEvent("Session Timeout", {}).finally(async () => {
                        // Must actually end the Supabase session here — otherwise the
                        // persisted session in localStorage is still valid, and the
                        // reload below just silently logs the user back in, making
                        // the timeout appear to do nothing.
                        try {
                            if (typeof window.__supabaseSignOut === "function") {
                                await window.__supabaseSignOut();
                            }
                        } catch (err) {
                            console.error("Sign out on session timeout failed:", err);
                        }
                        window.location.reload();
                    });
                }
            }, 1000);
        }

        extendSession() {
            const modal = document.getElementById("session-timeout-modal");
            if (modal) modal.style.display = "none";
            if (this._sessionCountdownInterval) clearInterval(this._sessionCountdownInterval);
            this.initSessionTimeoutWatcher();
        }

        // ---------- User Management (Administrator only) ----------
        async renderUserManagementTable() {
            const tbody = document.getElementById("user-mgmt-table-body");
            if (!tbody) return;
            try {
                const sb = supabaseClient;
                const { data: users, error } = await sb.from("profiles").select("*").order("created_at", { ascending: true });
                if (error) throw error;

                if (!users || users.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted" style="padding:30px;">No users found.</td></tr>`;
                    return;
                }

                tbody.innerHTML = users.map(u => `
                    <tr>
                        <td><strong>${u.employee_id}</strong></td>
                        <td>${u.full_name}</td>
                        <td>${u.email}</td>
                        <td>${u.department || "-"}</td>
                        <td><span class="status-badge ${u.role === "Administrator" ? "badge-error" : u.role === "Senior Officer" ? "badge-warning" : "badge-success"}">${u.role}</span></td>
                        <td><span class="status-badge ${u.status === "Active" ? "badge-success" : "badge-error"}">${u.status}</span></td>
                        <td>${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}</td>
                        <td>
                            <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                <button class="btn-icon-only" title="Edit role/department" onclick="window.app.openEditUserModal('${u.id}')">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                </button>
                                <button class="btn-icon-only" title="Reset password" onclick="window.app.resetUserPassword('${u.id}')">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                                </button>
                                <button class="btn-icon-only" title="${u.status === "Active" ? "Disable account" : "Unlock / Enable account"}" onclick="window.app.toggleUserStatus('${u.id}', '${u.status === "Active" ? "Disabled" : "Active"}')">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${u.status === "Active" ? '<circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>' : '<polyline points="20 6 9 17 4 12"></polyline>'}</svg>
                                </button>
                                <button class="btn-icon-only danger" title="Delete user" onclick="window.app.deleteUserAccount('${u.id}', '${u.employee_id}')">
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                </button>
                            </div>
                        </td>
                    </tr>
                `).join("");
            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted" style="padding:30px; color:#ff6b6b;">Failed to load users: ${err.message}</td></tr>`;
            }
        }

        openCreateUserModal() {
            document.getElementById("user-form-modal-title").textContent = "Create New User";
            document.getElementById("user-form-save-btn").textContent = "Create User";
            document.getElementById("user-form-target-id").value = "";
            document.getElementById("user-form-employee-id").value = "";
            document.getElementById("user-form-employee-id").disabled = false;
            document.getElementById("user-form-full-name").value = "";
            document.getElementById("user-form-email").value = "";
            document.getElementById("user-form-email").disabled = false;
            document.getElementById("user-form-mobile").value = "";
            document.getElementById("user-form-department").value = "";
            document.getElementById("user-form-role").value = "Staff";
            document.getElementById("user-form-temp-password").value = "";
            document.getElementById("user-form-password-group").style.display = "";
            document.getElementById("user-form-error").classList.add("hidden");
            document.getElementById("user-form-modal").classList.add("active");
        }

        async openEditUserModal(userId) {
            try {
                const sb = supabaseClient;
                const { data: u, error } = await sb.from("profiles").select("*").eq("id", userId).single();
                if (error || !u) throw error || new Error("User not found.");

                document.getElementById("user-form-modal-title").textContent = `Edit ${u.full_name}`;
                document.getElementById("user-form-save-btn").textContent = "Save Changes";
                document.getElementById("user-form-target-id").value = u.id;
                document.getElementById("user-form-employee-id").value = u.employee_id;
                document.getElementById("user-form-employee-id").disabled = true; // identity fields locked once created
                document.getElementById("user-form-full-name").value = u.full_name;
                document.getElementById("user-form-email").value = u.email;
                document.getElementById("user-form-email").disabled = true;
                document.getElementById("user-form-mobile").value = u.mobile || "";
                document.getElementById("user-form-department").value = u.department || "";
                document.getElementById("user-form-role").value = u.role;
                document.getElementById("user-form-temp-password").value = "";
                document.getElementById("user-form-password-group").style.display = "none"; // use Reset Password action instead
                document.getElementById("user-form-error").classList.add("hidden");
                document.getElementById("user-form-modal").classList.add("active");
            } catch (err) {
                this.showToast(`Could not load user: ${err.message}`, "error");
            }
        }

        closeUserFormModal() {
            document.getElementById("user-form-modal").classList.remove("active");
        }

        async saveUserForm() {
            const targetId = document.getElementById("user-form-target-id").value;
            const errEl = document.getElementById("user-form-error");
            errEl.classList.add("hidden");
            const saveBtn = document.getElementById("user-form-save-btn");

            const employeeId = document.getElementById("user-form-employee-id").value.trim().toUpperCase();
            const fullName = document.getElementById("user-form-full-name").value.trim();
            const email = document.getElementById("user-form-email").value.trim();
            const mobile = document.getElementById("user-form-mobile").value.trim();
            const department = document.getElementById("user-form-department").value.trim();
            const role = document.getElementById("user-form-role").value;
            const tempPassword = document.getElementById("user-form-temp-password").value;

            if (!employeeId || !fullName || !email || !role) {
                errEl.textContent = "Please fill in Employee ID, Full Name, Email, and Role.";
                errEl.classList.remove("hidden");
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = targetId ? "Saving..." : "Creating...";

            try {
                const sb = supabaseClient;
                if (!targetId) {
                    // CREATE — must go through the Edge Function (needs service_role)
                    if (!tempPassword || tempPassword.length < 6) {
                        throw new Error("Temporary password must be at least 6 characters.");
                    }
                    await callEdgeFunction("create-user", {
                        employeeId, fullName, email, mobile, department, role, tempPassword,
                    });
                    await this.logActivityEvent("User Created", { employeeId, role });
                    this.showToast(`User ${employeeId} created successfully.`, "success");
                } else {
                    // EDIT — role/department/mobile can be updated directly (Admin RLS policy allows it)
                    const { data: before } = await sb.from("profiles").select("role").eq("id", targetId).single();
                    const { error: updErr } = await sb.from("profiles").update({
                        mobile: mobile || null, department: department || null, role,
                    }).eq("id", targetId);
                    if (updErr) throw updErr;
                    if (before && before.role !== role) {
                        await this.logActivityEvent("Role Change", { employeeId, from: before.role, to: role });
                    }
                    this.showToast(`User ${employeeId} updated.`, "success");
                }
                this.closeUserFormModal();
                this.renderUserManagementTable();
            } catch (err) {
                errEl.textContent = err.message || "Something went wrong.";
                errEl.classList.remove("hidden");
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = targetId ? "Save Changes" : "Create User";
            }
        }

        async resetUserPassword(userId) {
            const newPassword = prompt("Enter a new temporary password for this user (min 6 characters):");
            if (!newPassword) return;
            if (newPassword.length < 6) { this.showToast("Password must be at least 6 characters.", "error"); return; }
            try {
                await callEdgeFunction("reset-password", { targetUserId: userId, newPassword });
                await this.logActivityEvent("Password Reset", { targetUserId: userId });
                this.showToast("Password reset. Share the new temporary password with the employee securely.", "success");
            } catch (err) {
                this.showToast(`Failed to reset password: ${err.message}`, "error");
            }
        }

        async toggleUserStatus(userId, newStatus) {
            const label = newStatus === "Disabled" ? "disable" : "re-enable";
            if (!confirm(`Are you sure you want to ${label} this account?`)) return;
            try {
                const sb = supabaseClient;
                const { error } = await sb.from("profiles").update({ status: newStatus }).eq("id", userId);
                if (error) throw error;
                if (newStatus === "Disabled") {
                    await this.logActivityEvent("User Disabled", { targetUserId: userId });
                }
                this.showToast(`Account ${newStatus === "Disabled" ? "disabled" : "re-enabled"}.`, "success");
                this.renderUserManagementTable();
            } catch (err) {
                this.showToast(`Failed: ${err.message}`, "error");
            }
        }

        async deleteUserAccount(userId, employeeId) {
            if (!confirm(`Permanently delete user ${employeeId}? This cannot be undone.`)) return;
            try {
                await callEdgeFunction("delete-user", { targetUserId: userId });
                this.showToast(`User ${employeeId} deleted.`, "success");
                this.renderUserManagementTable();
            } catch (err) {
                this.showToast(`Failed to delete user: ${err.message}`, "error");
            }
        }

        // ---------- Activity Log (Administrator only) ----------
        async renderActivityLogPage() {
            const tbody = document.getElementById("activity-log-table-body");
            if (!tbody) return;
            const filter = document.getElementById("activity-log-filter") ? document.getElementById("activity-log-filter").value : "ALL";
            try {
                const sb = supabaseClient;
                let query = sb.from("activity_logs").select("*").order("created_at", { ascending: false }).limit(300);
                if (filter !== "ALL") query = query.eq("event_type", filter);
                const { data: rows, error } = await query;
                if (error) throw error;

                if (!rows || rows.length === 0) {
                    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted" style="padding:30px;">No activity recorded yet.</td></tr>`;
                    return;
                }

                tbody.innerHTML = rows.map(r => {
                    const dt = new Date(r.created_at);
                    const sevClass = r.event_type === "Failed Login" || r.event_type === "User Disabled" ? "badge-error"
                        : r.event_type === "Session Timeout" || r.event_type === "Role Change" ? "badge-warning"
                        : "badge-success";
                    return `
                        <tr>
                            <td>${dt.toLocaleDateString()}</td>
                            <td>${dt.toLocaleTimeString()}</td>
                            <td>${r.employee_id || "-"}</td>
                            <td>${r.full_name || "-"}</td>
                            <td>${r.role || "-"}</td>
                            <td><span class="status-badge ${sevClass}">${r.event_type}</span></td>
                            <td>${r.browser || "-"}</td>
                            <td>${r.device || "-"}</td>
                            <td style="font-size:0.75rem; color:var(--text-muted);">${r.details ? JSON.stringify(r.details) : "-"}</td>
                        </tr>
                    `;
                }).join("");
            } catch (err) {
                tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted" style="padding:30px; color:#ff6b6b;">Failed to load activity log: ${err.message}</td></tr>`;
            }
        }

        async signOutApp() {
            if (!confirm("Sign out of Got It Solutions Provider?")) return;
            try {
                await this.logActivityEvent("Logout", {});
            } catch (err) { /* best-effort */ }
            if (this._sessionTimeoutTimer) clearTimeout(this._sessionTimeoutTimer);
            if (this._sessionCountdownInterval) clearInterval(this._sessionCountdownInterval);
            try {
                if (typeof window.__supabaseSignOut === "function") {
                    await window.__supabaseSignOut();
                }
            } catch (err) {
                console.error("Sign out error:", err);
            }
            window.location.reload();
        }

        allocateDueStockManual(dueId) {
            const inputVal = parseInt(document.getElementById("due-allocate-input").value);
            if (isNaN(inputVal) || inputVal <= 0) {
                this.showToast("Please enter a valid quantity to allocate.", "error");
                return;
            }

            let dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem) return;

            let tablets = this.getTablets();
            const tabObj = (dueItem.tabletCode && dueItem.tabletCode !== "N/A" ? this.getTabletByCode(dueItem.tabletCode) : null) || tablets.find(t => t.name === dueItem.tabletName);
            if (!tabObj) {
                this.showToast("Product not found in Master Inventory.", "error");
                return;
            }

            const tabsPerStrip = tabObj.tabsPerStrip || 10;
            const isTab = tabObj.category === "Tablets & Capsules" || tabObj.category === "Rotacaps";
            // Work in tablets throughout — dueItem.dueQty is a tablet count, and the
            // input the Administrator types here must match that same unit.
            const currentStockUnits = tabObj.stock;

            if (inputVal > currentStockUnits) {
                this.showToast("Cannot allocate more than available stock.", "error");
                return;
            }
            if (inputVal > dueItem.dueQty) {
                this.showToast("Cannot allocate more than the remaining due quantity.", "error");
                return;
            }

            // Confirm allocation
            const confirmMsg = `Stock Available: ${currentStockUnits} tablet(s)\n\nAllocate ${inputVal} tablet(s) to this Due Order?`;
            if (!confirm(confirmMsg)) return;

            try {
                this.beginTransaction();

                let qtyToDeduct = inputVal;

                // Deduct from batches using FIFO
                tabObj.batches = tabObj.batches || [];
                const sortedBatches = [...tabObj.batches].sort((a, b) => {
                    return this.parseExpiryDate(a.expiryDate) - this.parseExpiryDate(b.expiryDate);
                });

                let remainingDeduct = qtyToDeduct;
                let history = this.getHistory();
                const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
                let runningStock = tabObj.stock; // tracked per-batch so each row's previous/new stock is accurate

                for (let b of sortedBatches) {
                    if (remainingDeduct <= 0) break;
                    if (b.quantity > 0) {
                        const deduct = Math.min(b.quantity, remainingDeduct);
                        b.quantity -= deduct;
                        remainingDeduct -= deduct;

                        const loggedQty = isTab ? Math.round(deduct / tabsPerStrip) : Math.round(deduct);
                        const prevStock = runningStock;
                        runningStock -= deduct;
                        // Record movement
                        const stockOutEntry = {
                            id: `txn-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                            datetime: nowStr,
                            type: "STOCK OUT",
                            tabletName: tabObj.name,
                            tabletCode: tabObj.code || null,
                            orderId: dueItem.orderId || null,
                            batch: b.batchNumber,
                            expiryDate: b.expiryDate || null,
                            qty: loggedQty,
                            dispensaryId: dueItem.dispensaryId || null,
                            dispensaryName: dueItem.dispensaryName || null,
                            manufacturer: tabObj.manufacturer || tabObj.brand || null,
                            company: tabObj.brand || null,
                            mrp: tabObj.mrp ?? null,
                            previousStock: prevStock,
                            newStock: runningStock,
                            performedBy: (this.currentUser && this.currentUser.name) || null,
                            performedByRole: (this.currentUser && this.currentUser.role) || null,
                            details: `Allocated to due order ${dueItem.orderId} (Dispensary: ${dueItem.dispensaryId})`
                        };
                        history.push(stockOutEntry);
                        syncHistoryRow(stockOutEntry);
                        syncInventoryTransactionRow(stockOutEntry);
                    }
                }
                this.setHistory(history);

                // Sync stock
                tabObj.stock = tabObj.batches.reduce((sum, b) => sum + b.quantity, 0);

                dueItem.allocatedQty = (dueItem.allocatedQty || 0) + inputVal;
                dueItem.dueQty = Math.max(0, dueItem.dueQty - inputVal);
                dueItem.lastUpdated = nowStr;

                if (dueItem.dueQty === 0) {
                    dueItem.status = "Completed";
                    dueItem.dueDate = nowStr.split(" ")[0];
                } else {
                    dueItem.status = "Partially Completed";
                }

                this.setTablets(tablets);
                this.setDueOrders(dues);
                // Log audit/movement (logHistory both appends to the local
                // blob and upserts the row-level medicine_history table)
                this.logHistory(
                    dueItem.status === "Completed" ? "Due Order Completed" : "Inventory Updated",
                    dueItem.tabletName, "N/A", inputVal,
                    dueItem.status === "Completed"
                        ? `Due order ${dueItem.orderId} fully fulfilled and completed (Allocated ${inputVal} tablets)`
                        : `Allocated ${inputVal} tablets to due order ${dueItem.orderId} (Remaining: ${dueItem.dueQty})`,
                    {
                        code: tabObj.code || null,
                        orderId: dueItem.orderId || null,
                        dispensaryId: dueItem.dispensaryId || null,
                        dispensaryName: dueItem.dispensaryName || null,
                        manufacturer: tabObj.manufacturer || tabObj.brand || null,
                        company: tabObj.brand || null,
                        mrp: tabObj.mrp ?? null,
                        newStock: tabObj.stock
                    }
                );

                this.commitTransaction();

                this.showToast(`Successfully allocated ${inputVal} tablets to Due Order ${dueItem.orderId}!`, "success");
                
                this.closeDueModal();
                this.renderDueOrdersPage();
                this.renderDashboard();
            } catch (err) {
                this.rollbackTransaction();
                console.error("Allocation transaction rolled back:", err);
                this.showToast(`Allocation Failed: ${err.message}`, "error");
            }
        }

        closeDueModal() {
            const modal = document.getElementById("due-modal");
            if (modal) modal.classList.remove("active");
        }

        saveDueForm() {
            const dueId = document.getElementById("edit-due-id").value;
            let dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem) return;

            const newDispId = document.getElementById("due-dispensary-id").value.trim();
            const newDispName = document.getElementById("due-dispensary-name").value.trim();
            const newOrderId = document.getElementById("due-order-id").value.trim();
            const newTabletName = document.getElementById("due-tablet-name").value.trim();
            const newReqQty = parseInt(document.getElementById("due-req-qty").value);
            const newStatus = document.getElementById("due-status").value;
            const newPriority = document.getElementById("due-priority").value;
            const newNotes = document.getElementById("due-notes").value.trim();

            if (!newDispId || !newDispName || !newOrderId || !newTabletName || isNaN(newReqQty)) {
                this.showToast("All fields are required.", "error");
                return;
            }

            const oldStatus = dueItem.status;

            dueItem.dispensaryId = newDispId;
            dueItem.dispensaryName = newDispName;
            dueItem.orderId = newOrderId;
            dueItem.tabletName = newTabletName;
            dueItem.reqQty = newReqQty;
            dueItem.notes = newNotes;
            dueItem.status = newStatus;
            dueItem.priority = newPriority;
            
            if (newStatus === "Completed" && oldStatus !== "Completed") {
                dueItem.dueQty = 0;
                dueItem.dueDate = new Date().toISOString().split('T')[0];
            } else if (newStatus === "Pending") {
                dueItem.dueQty = newReqQty - (dueItem.allocatedQty || 0);
                dueItem.dueDate = "";
            } else if (newStatus === "Partially Completed") {
                dueItem.dueQty = newReqQty - (dueItem.allocatedQty || 0);
            } else if (newStatus === "Cancelled") {
                dueItem.dueQty = 0;
            }

            dueItem.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);

            this.setDueOrders(dues);
            this.showToast("Due order updated successfully.");
            this.closeDueModal();
            this.renderDueOrdersPage();
            this.renderDashboard();
        }

        cancelDueOrder(dueId) {
            let dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem || dueItem.status === "Cancelled" || dueItem.status === "Completed") return;

            if (confirm(`Are you sure you want to cancel due order ${dueItem.orderId} for ${dueItem.dispensaryId}? This will return any allocated stock (${dueItem.allocatedQty || 0} packs) back to inventory.`)) {
                try {
                    this.beginTransaction();

                    let tablets = this.getTablets();
                    const tabObj = (dueItem.tabletCode && dueItem.tabletCode !== "N/A" ? this.getTabletByCode(dueItem.tabletCode) : null) || tablets.find(t => t.name === dueItem.tabletName);

                    if (tabObj && (dueItem.allocatedQty || 0) > 0) {
                        tabObj.batches = tabObj.batches || [];
                        if (tabObj.batches.length > 0) {
                            tabObj.batches[0].quantity += dueItem.allocatedQty;
                        } else {
                            tabObj.batches.push({
                                batchNumber: "RESTORED",
                                expiryDate: "12/28",
                                quantity: dueItem.allocatedQty,
                                mrp: tabObj.mrp || 0,
                                cost: tabObj.cost || 0
                            });
                        }
                        tabObj.stock = tabObj.batches.reduce((sum, b) => sum + b.quantity, 0);
                        this.setTablets(tablets);

                        // Log standardized activity: Inventory Updated
                        this.logHistory(
                            "Inventory Updated",
                            dueItem.tabletName,
                            "RESTORED",
                            dueItem.allocatedQty,
                            `Returned allocated stock from cancelled due order ${dueItem.orderId}`
                        );
                    }

                    dueItem.status = "Cancelled";
                    dueItem.lastUpdated = new Date().toISOString().replace('T', ' ').substring(0, 19);
                    this.setDueOrders(dues);

                    this.commitTransaction();

                    this.showToast(`Due order ${dueItem.orderId} cancelled successfully.`);
                    this.renderDueOrdersPage();
                    this.renderDashboard();
                } catch (err) {
                    this.rollbackTransaction();
                    console.error("Cancel due order transaction rolled back:", err);
                    this.showToast(`Cancel Failed: ${err.message}`, "error");
                }
            }
        }

        deleteDueOrder(dueId) {
            let dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem) return;

            if (confirm(`Are you sure you want to permanently delete due order record ${dueItem.orderId} for ${dueItem.dispensaryId}? This cannot be undone.`)) {
                try {
                    this.beginTransaction();
                    const updatedDues = dues.filter(d => d.id !== dueId);
                    this.setDueOrders(updatedDues);
                    this.commitTransaction();

                    this.showToast(`Due order record deleted.`);
                    this.renderDueOrdersPage();
                    this.renderDashboard();
                } catch (err) {
                    this.rollbackTransaction();
                    console.error("Delete due order transaction rolled back:", err);
                    this.showToast(`Delete Failed: ${err.message}`, "error");
                }
            }
        }

        // Fulfill a due order item when stock is back
        fulfillDue(dueId) {
            let dues = this.getDueOrders();
            const dueItem = dues.find(d => d.id === dueId);
            if (!dueItem || dueItem.status === "Completed" || dueItem.status === "Cancelled") return;

            try {
                this.beginTransaction();

                let tablets = this.getTablets();
                const tabObj = (dueItem.tabletCode && dueItem.tabletCode !== "N/A" ? this.getTabletByCode(dueItem.tabletCode) : null) || tablets.find(t => t.name === dueItem.tabletName);
                
                if (!tabObj) {
                    throw new Error(`ProductMismatchException: Product "${dueItem.tabletName}" no longer exists in DB!`);
                }

                const category = tabObj.category;
                const tabsPerStrip = tabObj.tabsPerStrip || 10;
                const clearedQty = dueItem.dueQty;
                
                // dueItem.dueQty is already a tablet count — no conversion needed.
                let qtyToDeduct = clearedQty;

                if (tabObj.stock < qtyToDeduct) {
                    throw new Error(`InsufficientStockException: Available stock (${tabObj.stock} tablets) is less than due qty (${clearedQty} tablets).`);
                }

                const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

                // Deduct from batches using FIFO
                tabObj.batches = tabObj.batches || [];
                const sortedBatches = [...tabObj.batches].sort((a, b) => {
                    return this.parseExpiryDate(a.expiryDate) - this.parseExpiryDate(b.expiryDate);
                });

                let remainingDeduct = qtyToDeduct;
                for (let b of sortedBatches) {
                    if (remainingDeduct <= 0) break;
                    if (b.quantity > 0) {
                        const deduct = Math.min(b.quantity, remainingDeduct);
                        b.quantity -= deduct;
                        remainingDeduct -= deduct;
                    }
                }

                // Sync total stock
                tabObj.stock = tabObj.batches.reduce((sum, b) => sum + b.quantity, 0);

                dueItem.allocatedQty = (dueItem.allocatedQty || 0) + clearedQty;
                dueItem.dueQty = 0;
                dueItem.status = "Completed";
                dueItem.dueDate = nowStr.split(" ")[0]; // Arrival date
                dueItem.lastUpdated = nowStr;

                this.setTablets(tablets);
                this.setDueOrders(dues);

                // Log standardized activity: Due Order Completed
                this.logHistory(
                    "Due Order Completed",
                    dueItem.tabletName,
                    "N/A",
                    clearedQty,
                    `Manually completed due order ${dueItem.orderId} (Dispensary: ${dueItem.dispensaryId})`
                );

                this.commitTransaction();

                this.showToast(`Order item ${dueItem.orderId} fulfilled successfully!`);
                this.renderDueOrdersPage();
                this.renderDashboard();
            } catch (err) {
                this.rollbackTransaction();
                console.error("Fulfill due transaction rolled back:", err);
                this.showToast(`Fulfillment Failed: ${err.message}`, "error");
            }
        }

        quickFulfillDue(dueId) {
            this.fulfillDue(dueId);
        }

        // Allocate incoming supplier-bill stock to pending Reorder items first
        // (FIFO). When a Reorder's "to order" quantity is fully satisfied, that
        // medicine is REMOVED completely from Reorder (per workflow spec) rather
        // than merely marked Completed.
        allocateStockToReorders(tabletName, incomingQty) {
            let reorders = this.getReorders();
            let matchingReorders = reorders.filter(r =>
                r.tabletName.toLowerCase() === tabletName.toLowerCase() &&
                r.status !== "Completed"
            );

            if (matchingReorders.length === 0) return incomingQty;

            // FIFO: oldest reorder request first
            matchingReorders.sort((a, b) => new Date(a.date) - new Date(b.date));

            let autoAllocatedCount = 0;
            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
            const idsToRemove = [];

            for (let ro of matchingReorders) {
                if (incomingQty <= 0) break;

                const needed = ro.toOrderQty;
                const allocated = Math.min(incomingQty, needed);

                ro.toOrderQty -= allocated;
                incomingQty -= allocated;
                ro.lastUpdated = nowStr;
                autoAllocatedCount++;

                if (ro.workflowId) {
                    if (!this._pendingBillWorkflowIds) this._pendingBillWorkflowIds = [];
                    if (!this._pendingBillWorkflowIds.includes(ro.workflowId)) this._pendingBillWorkflowIds.push(ro.workflowId);
                }

                if (ro.toOrderQty <= 0) {
                    // Fully satisfied -> remove the medicine completely from Reorder.
                    idsToRemove.push(ro.id);
                    this.logHistory(
                        "Reorder Allocation",
                        ro.tabletName,
                        "N/A",
                        allocated,
                        `Reorder fully satisfied by incoming purchase (Allocated ${allocated} tablet(s)); removed from Reorder Management.`,
                        { workflowId: ro.workflowId }
                    );
                    if (ro.workflowId) {
                        this.updateWorkflowStatus(ro.workflowId, "Completed");
                        this.logWorkflowEvent(ro.workflowId, "Reorder Completed", "Supplier Bill Processing", `Reorder for "${ro.tabletName}" fully satisfied by supplier bill (${allocated} unit(s)).`);
                    }
                } else {
                    ro.status = "Partially Ordered";
                    this.logHistory(
                        "Reorder Allocation",
                        ro.tabletName,
                        "N/A",
                        allocated,
                        `Auto-allocated ${allocated} tablet(s) from incoming purchase to reorder (Remaining: ${ro.toOrderQty})`,
                        { workflowId: ro.workflowId }
                    );
                    if (ro.workflowId) {
                        this.logWorkflowEvent(ro.workflowId, "Inventory Updated", "Supplier Bill Processing", `Partially allocated ${allocated} unit(s) from supplier bill to "${ro.tabletName}" (Remaining: ${ro.toOrderQty}).`);
                    }
                }
            }

            if (idsToRemove.length > 0) {
                reorders = reorders.filter(r => !idsToRemove.includes(r.id));
            }

            if (autoAllocatedCount > 0) {
                this.setReorders(reorders);
                this.showToast(`Auto-allocated incoming stock to ${autoAllocatedCount} pending reorder item(s)!`, "info");
            }

            return incomingQty;
        }

        // Combined incoming-stock allocation used by every stock-in path (supplier
        // bill import, manual stock adjustments): first satisfy any pending
        // Reorder requirement, then any already-existing Due Order (e.g. one that
        // was created via a prior Day End Approval), and only the remainder is
        // added to general Master Data inventory.
        allocateIncomingStock(tabletName, incomingQty) {
            let remaining = this.allocateStockToReorders(tabletName, incomingQty);
            remaining = this.allocateStockToDueOrders(tabletName, remaining);
            return remaining;
        }

        // Allocate incoming stock to pending/partial dues using FIFO priority
        allocateStockToDueOrders(tabletName, incomingQty) {
            let dues = this.getDueOrders();
            // Find dues for this tablet name (case insensitive) that are Pending or Partially Completed
            let matchingDues = dues.filter(d => 
                d.tabletName.toLowerCase() === tabletName.toLowerCase() && 
                (d.status === "Pending" || d.status === "Partially Completed")
            );

            if (matchingDues.length === 0) return incomingQty;

            // FIFO: Sort by date logged (ascending)
            matchingDues.sort((a, b) => new Date(a.date) - new Date(b.date));

            let autoAllocatedCount = 0;
            const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

            for (let due of matchingDues) {
                if (incomingQty <= 0) break;

                const needed = due.dueQty;
                const allocated = Math.min(incomingQty, needed);

                // Partial-fill quantity difference is applied silently below —
                // no Notification Center entry (normal workflow event, per spec
                // section 5, not a system alert).

                due.allocatedQty = (due.allocatedQty || 0) + allocated;
                due.dueQty -= allocated;
                incomingQty -= allocated;
                due.lastUpdated = nowStr;

                if (due.dueQty === 0) {
                    due.status = "Completed";
                    due.dueDate = nowStr.split(" ")[0]; // Arrival date
                } else {
                    due.status = "Partially Completed";
                }

                autoAllocatedCount++;

                // Log standardized activity: Due Order Completed (or Inventory Updated if partial)
                this.logHistory(
                    due.status === "Completed" ? "Due Order Completed" : "Inventory Updated",
                    due.tabletName,
                    "N/A",
                    allocated,
                    due.status === "Completed"
                        ? `Due order ${due.orderId} fully fulfilled and completed (Allocated ${allocated} tablets)`
                        : `Auto-allocated ${allocated} tablets to due order ${due.orderId} (Remaining: ${due.dueQty})`
                );
            }

            if (autoAllocatedCount > 0) {
                // Save updated dues
                this.setDueOrders(dues);
                this.showToast(`Auto-allocated stock to ${autoAllocatedCount} pending due order(s)!`, "info");
            }

            return incomingQty;
        }



        showOcrMatchModal() {
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            if (!currentMatch) return;

            // Zero matches -> the medicine genuinely was not found (e.g. brand
            // matched but strength/dosage form did not). Never auto-continue;
            // hand off to the Medicine Not Found modal instead.
            if (currentMatch.type !== "bill-pack-confirm" && currentMatch.type !== "order-pack-confirm" &&
                (!currentMatch.matches || currentMatch.matches.length === 0)) {
                this.showMedicineNotFoundModal();
                return;
            }

            // Multiple strength/variant matches — resolved immediately via this
            // popup, not via the Notification Center (per spec: medicine
            // matching must never generate "Review Required" notifications).
            // A Pack Size / Strength / Brand mismatch uses the same popup with
            // a tailored message instead of a separate dialog.
            // currentMatch.name (and other OCR-derived fields interpolated below)
            // originate from Gemini/local OCR extraction, not from a trusted
            // internal source -- escape before writing into innerHTML so a
            // maliciously-crafted scanned document can't inject markup/script
            // into the pharmacy staff's session (see POST_IMPLEMENTATION_AUDIT.md,
            // "Pre-existing HTML injection surface").
            const safeMatchName = this.escapeHtml(currentMatch.name);
            if (currentMatch.type === "bill-mismatch") {
                const reasonsHtml = (currentMatch.mismatchReasons || []).map(r => `• ${this.escapeHtml(r)}`).join("<br>");
                document.getElementById("ocr-match-message").innerHTML = `<strong style="color:#f59e0b;">Confirm before continuing</strong> — the supplier bill entry for <strong style="color:#00f2fe;">"${safeMatchName}"</strong> doesn't fully match its Master Data record:<br>${reasonsHtml}<br><br>Confirm this is still the correct medicine, or edit the OCR text / cancel below.`;
            } else if (currentMatch.type === "bill-pack-confirm" || currentMatch.type === "order-pack-confirm") {
                document.getElementById("ocr-match-message").innerHTML = `<strong style="color:#f59e0b;">Pack Size Confirmation</strong> — the requested quantity for <strong style="color:#00f2fe;">"${safeMatchName}"</strong> uses a different Pack Size than Master Data:<br>Existing Pack: <strong>${this.escapeHtml(currentMatch.existingPack)}</strong> &nbsp;|&nbsp; Scanned Pack: <strong>${this.escapeHtml(currentMatch.scannedPack)}</strong><br><br>Should the system create a new Pack Size variant, or reuse the existing record?`;
            } else {
                document.getElementById("ocr-match-message").innerHTML = `Multiple medicines match the OCR result for <strong style="color:#00f2fe;">"${safeMatchName}"</strong>. Please confirm the correct medicine.`;
            }
            
            const optionsDiv = document.getElementById("ocr-match-options");
            optionsDiv.innerHTML = "";

            if (currentMatch.type === "bill-pack-confirm" || currentMatch.type === "order-pack-confirm") {
                const et = currentMatch.existingTablet;
                const choices = [
                    { label: `Reuse Existing (Pack ${currentMatch.existingPack})`, sub: `${et.name} (${et.code})`, isNew: false },
                    { label: `Accept New Pack (Pack ${currentMatch.scannedPack})`, sub: `Create a new Pack Size variant of ${et.name}`, isNew: true }
                ];
                choices.forEach((c, idx) => {
                    const div = document.createElement("div");
                    div.style.display = "flex";
                    div.style.alignItems = "center";
                    div.style.gap = "10px";
                    div.style.padding = "10px";
                    div.style.borderRadius = "8px";
                    div.style.background = "rgba(255,255,255,0.02)";
                    div.style.border = "1px solid rgba(255,255,255,0.05)";
                    div.innerHTML = `
                        <input type="radio" name="ocr-match-option" id="ocr-opt-${idx}" value="${idx}" data-is-new-pack="${c.isNew}" ${idx === 0 ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
                        <label for="ocr-opt-${idx}" style="cursor:pointer; font-size: 0.88rem; color: #fff; flex: 1;">
                            <strong style="color: #00f2fe;">${c.label}</strong><br>
                            <span style="font-size: 0.75rem; color: var(--text-muted);">${c.sub}</span>
                        </label>
                    `;
                    optionsDiv.appendChild(div);
                });

                document.getElementById("ocr-match-edit-group").style.display = "none";
                document.getElementById("ocr-match-edit-text").value = currentMatch.name;

                const modal = document.getElementById("ocr-match-modal");
                if (modal) modal.classList.add("active");
                return;
            }

            currentMatch.matches.forEach((m, idx) => {
                const div = document.createElement("div");
                div.style.display = "flex";
                div.style.alignItems = "center";
                div.style.gap = "10px";
                div.style.padding = "10px";
                div.style.borderRadius = "8px";
                div.style.background = "rgba(255,255,255,0.02)";
                div.style.border = "1px solid rgba(255,255,255,0.05)";
                div.innerHTML = `
                    <input type="radio" name="ocr-match-option" id="ocr-opt-${idx}" value="${idx}" ${idx === 0 ? 'checked' : ''} style="cursor:pointer; width:18px; height:18px;">
                    <label for="ocr-opt-${idx}" style="cursor:pointer; font-size: 0.88rem; color: #fff; flex: 1;">
                        <strong style="color: #00f2fe;">${m.name}</strong> (${m.code})<br>
                        <span style="font-size: 0.75rem; color: var(--text-muted);">
                            Strength: ${m.strength || "—"} | Dosage Form: ${m.category || "—"} | Pack Size: ${m.pack || "—"} | Brand: ${m.brand} | Stock: \${m.category === "Tablets & Capsules" || m.category === "Rotacaps" ? Math.round(m.stock / (m.tabsPerStrip || 10)) : Math.round(m.stock)} packs
                        </span>
                    </label>
                `;
                optionsDiv.appendChild(div);
            });

            // Reset edit field
            document.getElementById("ocr-match-edit-group").style.display = "none";
            document.getElementById("ocr-match-edit-text").value = currentMatch.name;

            const modal = document.getElementById("ocr-match-modal");
            if (modal) modal.classList.add("active");
        }

        closeOcrMatchModal() {
            const modal = document.getElementById("ocr-match-modal");
            if (modal) modal.classList.remove("active");
        }

        confirmOcrMatch() {
            const selectedOpt = document.querySelector('input[name="ocr-match-option"]:checked');
            if (!selectedOpt) {
                this.showToast("Please select a medicine option.", "error");
                return;
            }

            const selectedIndex = parseInt(selectedOpt.value);
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];

            if (currentMatch.type === "bill-pack-confirm" || currentMatch.type === "order-pack-confirm") {
                const wantsNewPack = selectedOpt.dataset.isNewPack === "true";
                let resolvedCode;
                if (wantsNewPack) {
                    const variant = this.createPackSizeVariant(currentMatch.existingTablet, currentMatch.rawPack);
                    this.persistNewMedicine(variant);
                    resolvedCode = variant.code;
                } else {
                    resolvedCode = currentMatch.existingTablet.code;
                }

                if (currentMatch.type === "bill-pack-confirm") {
                    const row = currentMatch.rowElement;
                    const codeSelect = row.querySelector(".edit-item-code");
                    if (codeSelect) {
                        let opt = codeSelect.querySelector(`option[value="${resolvedCode}"]`);
                        if (!opt) {
                            opt = document.createElement("option");
                            opt.value = resolvedCode;
                            opt.textContent = resolvedCode;
                            codeSelect.appendChild(opt);
                        }
                        codeSelect.value = resolvedCode;
                    }
                } else {
                    const context = this.orderVerificationContext;
                    const resolvedTablet = this.getTablets().find(t => t.code === resolvedCode);
                    context.items[currentMatch.itemIndex].resolvedTablet = resolvedTablet;
                }

                this.ocrMatchQueueIndex++;
                if (this.ocrMatchQueueIndex < this.ocrMatchQueue.length) {
                    this.showOcrMatchModal();
                } else {
                    this.closeOcrMatchModal();
                    if (currentMatch.type === "bill-pack-confirm") {
                        this.importExtractedBillResolved();
                    } else {
                        const ctx = this.orderVerificationContext;
                        this.verifyStockItemsResolved(ctx.refId, ctx.date, ctx.dispensaryId, ctx.dispensaryName, ctx.items.filter(it => !it.skipped));
                    }
                }
                return;
            }

            const selectedTablet = currentMatch.matches[selectedIndex];

            // Resolve
            if (currentMatch.type === "bill" || currentMatch.type === "bill-mismatch") {
                const row = currentMatch.rowElement;
                const codeVal = selectedTablet.code;
                const codeSelect = row.querySelector(".edit-item-code");
                if (codeSelect) {
                    let opt = codeSelect.querySelector(`option[value="${codeVal}"]`);
                    if (!opt) {
                        opt = document.createElement("option");
                        opt.value = codeVal;
                        opt.textContent = `${selectedTablet.name} (${codeVal})`;
                        codeSelect.appendChild(opt);
                    }
                    codeSelect.value = codeVal;
                }
                if (currentMatch.type === "bill-mismatch") {
                    // User explicitly confirmed this mismatch — don't ask again
                    // when the import gate re-runs.
                    row.dataset.mismatchConfirmed = "1";
                }
            } else if (currentMatch.type === "order") {
                const context = this.orderVerificationContext;
                context.items[currentMatch.itemIndex].resolvedTablet = selectedTablet;
            }

            // Move to next
            this.ocrMatchQueueIndex++;
            if (this.ocrMatchQueueIndex < this.ocrMatchQueue.length) {
                this.showOcrMatchModal();
            } else {
                this.closeOcrMatchModal();
                // Complete processing
                if (currentMatch.type === "bill" || currentMatch.type === "bill-mismatch") {
                    this.importExtractedBillResolved();
                } else if (currentMatch.type === "order") {
                    const ctx = this.orderVerificationContext;
                    this.verifyStockItemsResolved(ctx.refId, ctx.date, ctx.dispensaryId, ctx.dispensaryName, ctx.items.filter(it => !it.skipped));
                }
            }
        }

        // Cancel now only removes THIS medicine and continues processing the
        // rest of the order/bill (Priority 5) -- it used to wipe the entire
        // ocrMatchQueue, which silently discarded every other medicine in
        // the same order/bill just because one couldn't be confirmed. The
        // skipped medicine is logged to a review queue so nothing is lost,
        // just deferred.
        cancelOcrMatch() {
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            if (!currentMatch) { this.closeOcrMatchModal(); return; }

            this.logSkippedOcrMatch(currentMatch, "User cancelled the medicine confirmation popup");

            if (currentMatch.type === "order") {
                const context = this.orderVerificationContext;
                if (context && context.items[currentMatch.itemIndex]) {
                    context.items[currentMatch.itemIndex].skipped = true;
                }
            } else if (currentMatch.type === "bill" || currentMatch.type === "bill-mismatch") {
                // importExtractedBillResolved() re-reads rows directly from the
                // DOM table, so removing the row here is enough to exclude it.
                if (currentMatch.rowElement) currentMatch.rowElement.remove();
            } else if (currentMatch.type === "bill-pack-confirm" || currentMatch.type === "order-pack-confirm") {
                if (currentMatch.type === "bill-pack-confirm" && currentMatch.rowElement) {
                    currentMatch.rowElement.remove();
                } else if (currentMatch.type === "order-pack-confirm") {
                    const context = this.orderVerificationContext;
                    if (context && context.items[currentMatch.itemIndex]) {
                        context.items[currentMatch.itemIndex].skipped = true;
                    }
                }
            }

            this.showToast(`Skipped "${currentMatch.name}" — continuing with the rest of the order. Logged for later review.`, "warning");

            // Advance to the next queued medicine, same as a normal confirm,
            // instead of tearing down the whole queue.
            this.ocrMatchQueueIndex++;
            if (this.ocrMatchQueueIndex < this.ocrMatchQueue.length) {
                this.showOcrMatchModal();
                return;
            }

            this.closeOcrMatchModal();
            if (currentMatch.type === "bill" || currentMatch.type === "bill-mismatch" || currentMatch.type === "bill-pack-confirm") {
                this.importExtractedBillResolved();
            } else if (currentMatch.type === "order" || currentMatch.type === "order-pack-confirm") {
                const ctx = this.orderVerificationContext;
                if (ctx) {
                    // Drop any items the user skipped along the way before
                    // continuing verification with the rest.
                    const remaining = ctx.items.filter(it => !it.skipped);
                    this.verifyStockItemsResolved(ctx.refId, ctx.date, ctx.dispensaryId, ctx.dispensaryName, remaining);
                }
            }
            this.ocrMatchQueue = [];
            this.ocrMatchQueueIndex = 0;
            this.orderVerificationContext = null;
        }

        // Persists a skipped/cancelled medicine match to a review queue so
        // staff/admins can revisit it later instead of it silently vanishing
        // (Priority 5's "log that medicine for later review").
        logSkippedOcrMatch(currentMatch, reason) {
            try {
                const queue = JSON.parse(localStorage.getItem("ti_ocr_skipped") || "[]");
                queue.push({
                    name: currentMatch.name,
                    type: currentMatch.type,
                    reason: reason,
                    skippedBy: this.currentUser ? this.currentUser.name : "Unknown",
                    skippedAt: new Date().toISOString(),
                    orderRefId: this.orderVerificationContext ? this.orderVerificationContext.refId : null
                });
                this._safeSetItem("ti_ocr_skipped", JSON.stringify(queue), "OCR Review", "Skipped Medicine Queue");
            } catch (e) {
                console.warn("Failed to log skipped OCR match:", e.message);
            }
        }

        toggleOcrMatchEditText() {
            const group = document.getElementById("ocr-match-edit-group");
            if (group.style.display === "none") {
                group.style.display = "block";
                document.getElementById("ocr-match-edit-text").focus();
            } else {
                group.style.display = "none";
            }
        }

        searchOcrMatchEdit() {
            const text = document.getElementById("ocr-match-edit-text").value.trim();
            if (!text) return;

            const tablets = this.getTablets();
            const matches = this.resolveMedicine(text, null, tablets, { includeCandidates: true }).candidates;

            if (matches.length === 0) {
                this.showToast(`No matches found for "${text}".`, "warning");
                return;
            }

            // Update matches for current queue item
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            currentMatch.name = text;
            currentMatch.matches = matches;

            // Refresh modal options
            this.showOcrMatchModal();
        }

        // --- MEDICINE NOT FOUND MODAL (strict Name + Strength + Dosage Form match failed) ---
        showMedicineNotFoundModal() {
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            if (!currentMatch) return;

            // Per spec: an unmatched Brand+Strength+Dosage Form combination
            // (e.g. "DIOSMIN 300 MG TAB" when only 200/100 MG exist) must NOT
            // raise a notification and must NOT auto-select the closest
            // strength. Processing simply stops here until the user picks
            // Add New Medicine, Edit OCR Text, or Cancel below.
            const msgEl = document.getElementById("medicine-not-found-message");
            if (msgEl) {
                // currentMatch.name is OCR-derived; escape before innerHTML (see
                // POST_IMPLEMENTATION_AUDIT.md, "Pre-existing HTML injection surface").
                msgEl.innerHTML = `Medicine <strong style="color:#ff6b6b;">"${this.escapeHtml(currentMatch.name)}"</strong> could not be matched in Master Data by Brand Name, Strength and Dosage Form.<br>Choose how you'd like to proceed.`;
            }
            const editGroup = document.getElementById("medicine-not-found-edit-group");
            if (editGroup) editGroup.style.display = "none";
            const editText = document.getElementById("medicine-not-found-edit-text");
            if (editText) editText.value = currentMatch.name;

            const modal = document.getElementById("medicine-not-found-modal");
            if (modal) modal.classList.add("active");
        }

        closeMedicineNotFoundModal() {
            const modal = document.getElementById("medicine-not-found-modal");
            if (modal) modal.classList.remove("active");
        }

        // --- WORKFLOW ID LOOKUP (accessible from any module) ---
        openWorkflowLookupModal() {
            const modal = document.getElementById("workflow-lookup-modal");
            if (modal) modal.classList.add("active");
            const input = document.getElementById("workflow-lookup-input");
            if (input) { input.value = ""; input.focus(); }
            const results = document.getElementById("workflow-lookup-results");
            if (results) results.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">Enter a Workflow ID (e.g. WF-20260714-000125) to see its complete timeline: Order Sheet, Verification Report, Reorder, Purchase Bills, Inventory History, Due Orders, and Audit Log.</p>`;
        }

        closeWorkflowLookupModal() {
            const modal = document.getElementById("workflow-lookup-modal");
            if (modal) modal.classList.remove("active");
        }

        // Priority 2 revision: async, Promise-based, mobile/touch/keyboard
        // friendly replacement for the previous confirm() dialog. Reuses the
        // same modal-backdrop/glassmorphism markup and CSS as every other
        // modal in the app (see #strip-cut-modal in index.html), so it
        // inherits the existing mobile scrolling/sizing/touch handling
        // without any new CSS. Resolves to "cut_strip", "sealed_only", or
        // null (cancel/closed) -- it does NOT block the event loop, so other
        // items in the order continue to be processed strictly one at a
        // time, in order, same as before; only THIS awaited call pauses.
        showStripCutModal(details) {
            const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
            setText("strip-cut-medicine-name", details.medicineName);
            setText("strip-cut-requested", `${details.qtyRequested} tablet(s)`);
            setText("strip-cut-strip-size", `${details.tabsPerStrip} tablet(s)/strip`);
            setText("strip-cut-sealed-qty", `${details.sealedQty} tablet(s)`);
            setText("strip-cut-remainder", `${details.remainder} tablet(s)`);
            setText("strip-cut-policy", "Staff Decision Required");

            const modal = document.getElementById("strip-cut-modal");
            if (modal) { modal.classList.remove("hidden"); modal.classList.add("active"); }

            return new Promise((resolve) => {
                this._stripCutModalResolve = resolve;
            });
        }

        resolveStripCutModal(decision) {
            const modal = document.getElementById("strip-cut-modal");
            if (modal) modal.classList.remove("active");
            if (this._stripCutModalResolve) {
                const resolve = this._stripCutModalResolve;
                this._stripCutModalResolve = null;
                resolve(decision); // "cut_strip" | "sealed_only" | null
            }
        }

        runWorkflowLookup() {
            const input = document.getElementById("workflow-lookup-input");
            const results = document.getElementById("workflow-lookup-results");
            if (!input || !results) return;

            const id = input.value.trim().toUpperCase();
            if (!id) return;

            const data = this.searchWorkflow(id);
            if (!data || !data.workflow) {
                results.innerHTML = `<p style="color:var(--color-danger, #ff6b6b); font-size:0.85rem;">No workflow found for "${id}".</p>`;
                return;
            }

            const wf = data.workflow;
            const esc = (s) => (s === null || s === undefined) ? "" : String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

            // Unified Timeline: merges Audit Log + History Log + Workflow
            // Log for this workflow into one chronological view. Nothing is
            // merged in the database -- this is a read-only report view.
            const unified = this.getUnifiedTimeline(id);
            const sourceColor = { Audit: "#f59e0b", History: "#00f2fe", Workflow: "#a78bfa" };
            const timelineHtml = unified.length
                ? unified.map(l => `
                    <div style="padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);">
                        <div style="font-size:0.85rem; color:#fff;">
                            <span style="display:inline-block; font-size:0.65rem; font-weight:700; letter-spacing:0.03em; color:${sourceColor[l.source] || '#fff'}; border:1px solid ${sourceColor[l.source] || '#fff'}; border-radius:4px; padding:1px 5px; margin-right:6px;">${esc(l.source)}</span>
                            <strong>${esc(l.action)}</strong> <span style="color:var(--text-muted); font-size:0.75rem;">— ${esc(l.module)}</span>
                        </div>
                        <div style="font-size:0.75rem; color:var(--text-muted);">${esc(l.description)}</div>
                        <div style="font-size:0.7rem; color:var(--text-muted);">${l.user ? esc(l.user) + (l.role ? ` (${esc(l.role)})` : "") + " — " : ""}${esc(l.datetime)}</div>
                    </div>`).join("")
                : `<p style="color:var(--text-muted); font-size:0.8rem;">No log entries yet.</p>`;

            results.innerHTML = `
                <div style="background:rgba(255,255,255,0.04); border-radius:8px; padding:12px; margin-bottom:12px;">
                    <div style="font-size:1rem; font-weight:700; color:#00f2fe;">${esc(wf.id)}</div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">
                        Status: <strong style="color:#fff;">${esc(wf.currentStatus)}</strong> &nbsp;|&nbsp;
                        Dispensary: ${esc(wf.dispensary)} &nbsp;|&nbsp;
                        Order Ref: ${esc(wf.orderSheetRef)}
                    </div>
                    <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">
                        Created: ${esc(wf.createdDate)} ${esc(wf.createdTime)} by ${esc(wf.createdBy)}<br>
                        Last Updated: ${esc(wf.lastUpdated)} by ${esc(wf.lastUpdatedBy)}
                        ${wf.completionDate ? `<br>Completed: ${esc(wf.completionDate)} ${esc(wf.completionTime)}` : ""}
                    </div>
                </div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:6px;">
                    Reorder: ${data.reorders.length} &nbsp;|&nbsp; Due Orders: ${data.dueOrders.length} &nbsp;|&nbsp;
                    Movements: ${data.history.length} &nbsp;|&nbsp; Purchase Bills: ${data.bills.length}
                </div>
                <div style="font-weight:600; color:#fff; font-size:0.85rem; margin:10px 0 4px;">Unified Timeline <span style="font-weight:400; color:var(--text-muted); font-size:0.7rem;">(Audit + History + Workflow)</span></div>
                ${timelineHtml}
            `;
        }

        notFoundToggleEdit() {
            const group = document.getElementById("medicine-not-found-edit-group");
            if (!group) return;
            if (group.style.display === "none") {
                group.style.display = "block";
                const el = document.getElementById("medicine-not-found-edit-text");
                if (el) el.focus();
            } else {
                group.style.display = "none";
            }
        }

        // Re-run matching after the user edits the OCR text from the Not Found modal.
        notFoundSearchAgain() {
            const textEl = document.getElementById("medicine-not-found-edit-text");
            const text = textEl ? textEl.value.trim() : "";
            if (!text) return;

            const tablets = this.getTablets();
            const matches = this.resolveMedicine(text, null, tablets, { includeCandidates: true }).candidates;
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            if (!currentMatch) return;

            currentMatch.name = text;
            currentMatch.matches = matches;

            if (currentMatch.type === "bill" && currentMatch.rowElement) {
                const nameInput = currentMatch.rowElement.querySelector(".edit-item-name");
                if (nameInput) nameInput.value = text;
            } else if (currentMatch.type === "order" && this.orderVerificationContext) {
                this.orderVerificationContext.items[currentMatch.itemIndex].name = text;
            }

            this.closeMedicineNotFoundModal();

            if (matches.length === 0) {
                this.showToast(`Still no match found for "${text}". Add it as a new medicine or edit the text again.`, "warning");
                this.showMedicineNotFoundModal();
            } else {
                // One or more matches now exist -> Medicine Confirmation modal.
                this.showOcrMatchModal();
            }
        }

        // "Add New Medicine" -> open the existing Add Tablet modal, prefilled.
        // Resolution of the pending match queue item happens after Save (see saveTabletForm).
        notFoundAddNewMedicine() {
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            if (!currentMatch) return;

            this.closeMedicineNotFoundModal();
            this._notFoundResolveContext = currentMatch;

            this.openAddTabletModal();
            this.prefillAddTabletFromOCRName(currentMatch.name);

            this.showToast("Enter the medicine details and click Save Tablet to continue.", "info");
        }

        // Shared prefill: populate the Add Tablet form from an OCR-extracted
        // medicine name for both the "Medicine Not Found" and "Medicine
        // Confirmation" (multiple matches) -> Add New Medicine paths.
        prefillAddTabletFromOCRName(rawName) {
            const nameInput = document.getElementById("tab-name");
            if (nameInput) nameInput.value = rawName;

            const catSel = document.getElementById("tab-category");
            if (catSel) catSel.value = this.detectCategoryFromName(rawName);

            const codeInput = document.getElementById("tab-code");
            if (codeInput) codeInput.value = this.generateProductCode(rawName, null, catSel ? catSel.value : null);

            // Best-effort extraction of brand (first word) and generic/drug
            // name from the OCR text — user reviews/completes the rest.
            const brandInput = document.getElementById("tab-brand");
            if (brandInput && !brandInput.value) {
                const firstWord = rawName.trim().split(/\s+/)[0];
                if (firstWord) brandInput.value = firstWord;
            }

            const drugInput = document.getElementById("tab-drug");
            if (drugInput && !drugInput.value) {
                // Strip known dosage-form words and strength tokens to leave
                // a rough generic name guess.
                const DOSAGE_FORMS = /\b(tablet|tablets|capsule|capsules|syrup|syp|injection|inj|drop|drops|cream|gel|ointment|spray|suspension|susp|solution|powder|respule|respules|rotacap|rotacaps)\b/ig;
                const guess = rawName.replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|%)\b/ig, "").replace(DOSAGE_FORMS, "").replace(/\s+/g, " ").trim();
                if (guess) drugInput.value = guess;
            }

            // Pack size, e.g. "10'S" / "15's"
            const packInput = document.getElementById("tab-pack");
            if (packInput && !packInput.value) {
                const packMatch = rawName.match(/\b(\d+)\s*'?s\b/i);
                if (packMatch) packInput.value = `${packMatch[1]}'s`;
            }
        }

        // "Add New Medicine" from the Medicine Confirmation (multiple matches)
        // popup — same resume-after-save mechanism as the Medicine Not Found
        // modal, but triggered when the user rejects all offered matches.
        matchModalAddNewMedicine() {
            const currentMatch = this.ocrMatchQueue[this.ocrMatchQueueIndex];
            if (!currentMatch) return;

            this.closeOcrMatchModal();
            this._notFoundResolveContext = currentMatch;

            this.openAddTabletModal();
            this.prefillAddTabletFromOCRName(currentMatch.name);

            this.showToast("Enter the medicine details and click Save Tablet to continue.", "info");
        }

        notFoundCancel() {
            this.closeMedicineNotFoundModal();
            this.cancelOcrMatch();
        }

        // --- REPORTS VIEW & EXPORTS ---
        // ============================================================
        // REPORT CENTER (Admin Only) -- unifies History, Bills, and OCR
        // stats into one searchable/exportable record set. Never mutates
        // any of those underlying stores; purely reads + re-shapes them.
        // ============================================================
        _buildReportCenterRecords() {
            const records = [];

            // History entries (Order Verified/Uploaded, Inventory Updated,
            // Due Order events, etc.) already cover Medicine/Inventory/Stock
            // Movement/Purchase/Sales history across the app.
            this.getHistory().forEach(h => {
                let type = "Medicine History";
                if (h.type === "Order Uploaded" || h.type === "Order Verified") type = "Purchase History";
                else if (h.type && h.type.toLowerCase().includes("due")) type = "Sales History";
                else if (h.type === "Inventory Updated") type = "Stock Movement";
                records.push({
                    date: h.datetime || "",
                    type,
                    medicine: h.tabletName || "",
                    manufacturer: "",
                    supplier: h.supplierName || "",
                    invoice: h.invoiceNumber || "",
                    batch: h.batch || "",
                    qty: h.qty != null ? h.qty : "",
                    details: h.details || h.type || "",
                    user: this.currentUser?.name || "System"
                });
            });

            // Supplier Bills -> Supplier History / OCR Upload History
            this.getBills().forEach(b => {
                const tabObj = this.getTablets().find(t => t.code === b.code) || null;
                records.push({
                    date: b.date || b.invoiceDate || "",
                    type: "Supplier History",
                    medicine: b.name || b.medicineName || "",
                    manufacturer: tabObj ? (tabObj.brand || "") : (b.manufacturer || ""),
                    supplier: b.supplier || b.supplierName || "",
                    invoice: b.invoiceNo || b.invoiceNumber || "",
                    batch: b.batch || b.batchNumber || "",
                    qty: b.qty != null ? b.qty : "",
                    details: `Supplier bill line item${b.workflowId ? " (Workflow " + b.workflowId + ")" : ""}`,
                    user: b.uploadedBy || this.currentUser?.name || "System"
                });
                records.push({
                    date: b.date || b.invoiceDate || "",
                    type: "OCR Upload History",
                    medicine: b.name || b.medicineName || "",
                    manufacturer: tabObj ? (tabObj.brand || "") : (b.manufacturer || ""),
                    supplier: b.supplier || b.supplierName || "",
                    invoice: b.invoiceNo || b.invoiceNumber || "",
                    batch: b.batch || b.batchNumber || "",
                    qty: b.confidence_score != null ? `Confidence ${b.confidence_score}%` : "",
                    details: "OCR-extracted supplier bill line",
                    user: b.uploadedBy || this.currentUser?.name || "System"
                });
            });

            // Expiry History -- from live Master Data batches
            this.getTablets().forEach(t => {
                (t.batches || []).forEach(b => {
                    if (!b.expiryDate) return;
                    records.push({
                        date: b.expiryDate,
                        type: "Expiry History",
                        medicine: t.name,
                        manufacturer: t.brand || "",
                        supplier: "",
                        invoice: "",
                        batch: b.batchNumber || "",
                        qty: b.quantity != null ? b.quantity : "",
                        details: `Batch expiry (${b.expiryDate})`,
                        user: "System"
                    });
                });
            });

            // User Activity -- from Audit Log if present
            if (typeof this.getAuditLog === "function") {
                this.getAuditLog().forEach(a => {
                    records.push({
                        date: a.date || "",
                        type: "User Activity",
                        medicine: a.record || "",
                        manufacturer: "",
                        supplier: "",
                        invoice: "",
                        batch: "",
                        qty: "",
                        details: `${a.action || "Action"} on ${a.module || "system"}`,
                        user: a.user || a.role || "Unknown"
                    });
                });
            }

            return records;
        }

        _getReportCenterFilters() {
            const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim().toLowerCase() : ""; };
            return {
                type: (document.getElementById("rc-report-type") || {}).value || "ALL",
                medicine: val("rc-search-medicine"),
                manufacturer: val("rc-search-manufacturer"),
                supplier: val("rc-search-supplier"),
                invoice: val("rc-search-invoice"),
                batch: val("rc-search-batch"),
                user: val("rc-search-user"),
                dateFrom: (document.getElementById("rc-date-from") || {}).value || "",
                dateTo: (document.getElementById("rc-date-to") || {}).value || ""
            };
        }

        getReportCenterFilteredRecords() {
            const f = this._getReportCenterFilters();
            let records = this._buildReportCenterRecords();

            if (f.type !== "ALL") records = records.filter(r => r.type === f.type);
            if (f.medicine) records = records.filter(r => (r.medicine || "").toLowerCase().includes(f.medicine));
            if (f.manufacturer) records = records.filter(r => (r.manufacturer || "").toLowerCase().includes(f.manufacturer));
            if (f.supplier) records = records.filter(r => (r.supplier || "").toLowerCase().includes(f.supplier));
            if (f.invoice) records = records.filter(r => (r.invoice || "").toLowerCase().includes(f.invoice));
            if (f.batch) records = records.filter(r => (r.batch || "").toLowerCase().includes(f.batch));
            if (f.user) records = records.filter(r => (r.user || "").toLowerCase().includes(f.user));
            if (f.dateFrom) records = records.filter(r => r.date && new Date(r.date) >= new Date(f.dateFrom));
            if (f.dateTo) records = records.filter(r => r.date && new Date(r.date) <= new Date(f.dateTo + "T23:59:59"));

            records.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
            return records;
        }

        resetReportCenterFilters() {
            ["rc-search-medicine", "rc-search-manufacturer", "rc-search-supplier", "rc-search-invoice", "rc-search-batch", "rc-search-user", "rc-date-from", "rc-date-to"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = "";
            });
            const typeSel = document.getElementById("rc-report-type");
            if (typeSel) typeSel.value = "ALL";
            this.renderReportCenter();
        }

        renderReportCenter() {
            const body = document.getElementById("rc-results-table-body");
            const countEl = document.getElementById("rc-result-count");
            if (!body) return; // Report Center markup not on this view

            const records = this.getReportCenterFilteredRecords();
            body.innerHTML = "";

            if (records.length === 0) {
                body.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding:16px;">No records match the current filters.</td></tr>`;
            } else {
                // Cap on-screen rendering for performance; exports always use the full filtered set.
                records.slice(0, 300).forEach(r => {
                    const tr = document.createElement("tr");
                    tr.innerHTML = `
                        <td>${r.date ? new Date(r.date).toLocaleDateString("en-IN") : "—"}</td>
                        <td><span class="status-badge badge-info" style="font-size:0.68rem;padding:2px 6px;">${r.type}</span></td>
                        <td><strong>${r.medicine || "—"}</strong>${r.manufacturer ? `<div style="font-size:0.7rem;color:var(--text-muted);">${r.manufacturer}</div>` : ""}</td>
                        <td>${r.invoice || r.batch || "—"}</td>
                        <td>${r.qty !== "" ? r.qty : "—"}</td>
                        <td style="font-size:0.8rem;color:var(--text-secondary);">${r.details || ""}</td>
                        <td>${r.user || "—"}</td>
                    `;
                    body.appendChild(tr);
                });
            }
            if (countEl) countEl.textContent = `${records.length.toLocaleString()} record${records.length !== 1 ? "s" : ""}${records.length > 300 ? " (showing first 300 — export for full set)" : ""}`;
        }

        // Admin-only export gate: mirrors the sidebar's data-role-restrict
        // check so exports can never be triggered by a non-Admin even via
        // direct console/API calls, not just a hidden button.
        _assertAdminForReportCenter() {
            const role = this.currentUser ? this.currentUser.role : null;
            if (role !== "Administrator") {
                this.showToast("Only Admin can access the Report Center exports.", "error");
                return false;
            }
            return true;
        }

        exportReportCenter(format) {
            if (!this._assertAdminForReportCenter()) return;
            const records = this.getReportCenterFilteredRecords();
            if (records.length === 0) {
                this.showToast("No records to export for the current filters.", "warning");
                return;
            }

            const rows = records.map(r => ({
                Date: r.date ? new Date(r.date).toLocaleDateString("en-IN") : "",
                Type: r.type,
                Medicine: r.medicine,
                Manufacturer: r.manufacturer,
                Supplier: r.supplier,
                Invoice: r.invoice,
                Batch: r.batch,
                Qty: r.qty,
                Details: r.details,
                User: r.user
            }));

            const stamp = new Date().toISOString().slice(0, 10);

            if (format === "csv") {
                const headers = Object.keys(rows[0]);
                let csv = headers.join(",") + "\n";
                rows.forEach(row => {
                    csv += headers.map(h => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(",") + "\n";
                });
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = `report-center-${stamp}.csv`;
                link.click();
                this.showToast(`Exported ${rows.length} records to CSV.`, "success");

            } else if (format === "excel") {
                if (!window.XLSX) {
                    this.showToast("Excel export library did not load — check your internet connection and try again.", "error");
                    return;
                }
                const ws = window.XLSX.utils.json_to_sheet(rows);
                const wb = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(wb, ws, "Report Center");
                window.XLSX.writeFile(wb, `report-center-${stamp}.xlsx`);
                this.showToast(`Exported ${rows.length} records to Excel.`, "success");

            } else if (format === "pdf") {
                if (!window.jspdf || !window.jspdf.jsPDF) {
                    this.showToast("PDF export library did not load — check your internet connection and try again.", "error");
                    return;
                }
                const { jsPDF } = window.jspdf;
                const doc = new jsPDF({ orientation: "landscape" });
                doc.setFontSize(14);
                doc.text("Kastoori Medicals — Report Center Export", 14, 14);
                doc.setFontSize(9);
                doc.text(`Generated: ${new Date().toLocaleString("en-IN")}`, 14, 20);
                const headers = [Object.keys(rows[0])];
                const body = rows.map(row => Object.values(row).map(v => String(v ?? "")));
                if (typeof doc.autoTable === "function") {
                    doc.autoTable({ head: headers, body, startY: 26, styles: { fontSize: 7 } });
                } else {
                    this.showToast("PDF table plugin did not load — check your internet connection and try again.", "error");
                    return;
                }
                doc.save(`report-center-${stamp}.pdf`);
                this.showToast(`Exported ${rows.length} records to PDF.`, "success");

            } else if (format === "print") {
                const headers = Object.keys(rows[0]);
                const htmlRows = rows.map(row => `<tr>${headers.map(h => `<td style="border:1px solid #ccc;padding:4px 8px;font-size:12px;">${row[h] ?? ""}</td>`).join("")}</tr>`).join("");
                const printWindow = window.open("", "_blank");
                printWindow.document.write(`
                    <html><head><title>Report Center - ${stamp}</title></head>
                    <body style="font-family:Arial, sans-serif;">
                        <h2>Kastoori Medicals — Report Center</h2>
                        <p style="font-size:12px;color:#555;">Generated: ${new Date().toLocaleString("en-IN")} • ${rows.length} records</p>
                        <table style="border-collapse:collapse;width:100%;">
                            <thead><tr>${headers.map(h => `<th style="border:1px solid #ccc;padding:4px 8px;font-size:12px;text-align:left;background:#f0f0f0;">${h}</th>`).join("")}</tr></thead>
                            <tbody>${htmlRows}</tbody>
                        </table>
                        <script>window.onload = () => window.print();</script>
                    </body></html>
                `);
                printWindow.document.close();
            }
        }

        renderReports() {
            const tablets = this.getTablets();
            this.renderReportCenter();
            
            const labels = tablets.map(t => t.name.replace(/USV L\.|PHAR|LUPIN/g, '').trim());
            const stocks = tablets.map(t => t.stock);
            const valuations = tablets.map(t => t.stock * t.cost);

            // Chart 1: Stock levels bar chart
            const ctx1 = document.getElementById("reportsStockLevelChart");
            if (ctx1) {
                if (this.charts["reportStock"]) this.charts["reportStock"].destroy();

                if (window.Chart) {
                    this.charts["reportStock"] = new Chart(ctx1, {
                        type: 'bar',
                        data: {
                            labels: labels,
                            datasets: [{
                                label: 'Stock (Packs)',
                                data: stocks,
                                backgroundColor: 'rgba(0, 242, 254, 0.4)',
                                borderColor: '#00f2fe',
                                borderWidth: 1.5,
                                borderRadius: 6
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false }
                            },
                            scales: {
                                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                                x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 9 } } }
                            }
                        }
                    });
                } else {
                    this.renderHtmlBarChart(ctx1.parentElement, labels, stocks, "Packs");
                }
            }

            // Chart 2: Inventory Financial Valuations
            const ctx2 = document.getElementById("reportsValuationChart");
            if (ctx2) {
                if (this.charts["reportVal"]) this.charts["reportVal"].destroy();

                if (window.Chart) {
                    this.charts["reportVal"] = new Chart(ctx2, {
                        type: 'line',
                        data: {
                            labels: labels,
                            datasets: [{
                                label: 'Valuation (₹)',
                                data: valuations,
                                backgroundColor: 'rgba(139, 92, 246, 0.1)',
                                borderColor: '#8b5cf6',
                                borderWidth: 2,
                                fill: true,
                                tension: 0.3,
                                pointBackgroundColor: '#a855f7'
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false }
                            },
                            scales: {
                                y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                                x: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 9 } } }
                            }
                        }
                    });
                } else {
                    this.renderHtmlBarChart(ctx2.parentElement, labels, valuations, "₹");
                }
            }
        }

        renderHtmlBarChart(parentElement, labels, data, unit) {
            let barsHTML = "";
            const maxVal = Math.max(...data, 1);

            data.forEach((val, i) => {
                const pct = (val / maxVal) * 80;
                barsHTML += `
                    <div style="display:flex; align-items:center; gap:10px; font-size:0.75rem;">
                        <span style="width:120px; text-overflow:ellipsis; overflow:hidden; white-space:nowrap;">${labels[i]}</span>
                        <div style="flex:1; background:rgba(255,255,255,0.05); height:12px; border-radius:6px; overflow:hidden;">
                            <div style="width:${pct}%; background:#00f2fe; height:100%;"></div>
                        </div>
                        <span style="width:60px; font-weight:700;">${val} ${unit}</span>
                    </div>
                `;
            });

            parentElement.innerHTML = `
                <div style="display:flex; flex-direction:column; gap:12px; padding:10px; height:100%; overflow-y:auto; color:#94a3b8;">
                    ${barsHTML}
                </div>
            `;
        }

        // CSV Exports
        exportInventoryToCSV() {
            const tablets = this.getTablets();
            let csv = "Model No,Tablet Name,Brand,Pack Details,Stock (Packs),Cost Price (INR),MRP (INR),Inventory Value (INR)\n";
            
            tablets.forEach(t => {
                const valuation = t.stock * t.cost;
                csv += `"${t.code}","${t.name}","${t.brand}","${t.pack}",${t.stock},${t.cost},${t.mrp},${valuation}\n`;
            });

            this.downloadCSV(csv, "Inventory_Report.csv");
            this.showToast("Inventory report CSV downloaded.");
        }

        exportDueOrdersToCSV() {
            const dues = this.getDueOrders();
            let csv = "Order Reference ID,Date Flagged,Tablet Name,Required Qty,Available Stock at Time,Deficit Due Qty,Status\n";

            dues.forEach(d => {
                csv += `"${d.orderId}","${d.date}","${d.tabletName}",${d.reqQty},${d.availQty},${d.dueQty},"${d.status}"\n`;
            });

            this.downloadCSV(csv, "Due_Orders_Report.csv");
            this.showToast("Due orders report CSV downloaded.");
        }

        downloadCSV(csvContent, filename) {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const link = document.createElement("a");
            const url = URL.createObjectURL(blob);
            link.setAttribute("href", url);
            link.setAttribute("download", filename);
            link.style.visibility = 'hidden';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }

        // --- UTILS ---
        formatTimeAgo(datetimeStr) {
            const date = new Date(datetimeStr);
            const seconds = Math.floor((new Date() - date) / 1000);
            
            let interval = Math.floor(seconds / 31536000);
            if (interval > 1) return interval + " years ago";
            interval = Math.floor(seconds / 2592000);
            if (interval > 1) return interval + " months ago";
            interval = Math.floor(seconds / 86400);
            if (interval >= 1) return interval === 1 ? "1 day ago" : interval + " days ago";
            interval = Math.floor(seconds / 3600);
            if (interval >= 1) return interval === 1 ? "1 hour ago" : interval + " hours ago";
            interval = Math.floor(seconds / 60);
            if (interval >= 1) return interval === 1 ? "1 min ago" : interval + " mins ago";
            return "just now";
        }



        // --- MANUAL TEXT BILL BACKUP ENGINE ---
        switchBillSubTab(type) {
            document.querySelectorAll("#bill-view .sub-tab-btn").forEach(btn => {
                btn.classList.remove("active");
            });
            const btn = document.getElementById(`bill-subtab-btn-${type}`);
            if (btn) btn.classList.add("active");

            document.querySelectorAll("#bill-view .subtab-content").forEach(content => {
                content.classList.remove("active");
            });
            const content = document.getElementById(`bill-subtab-${type}`);
            if (content) content.classList.add("active");
        }

        processManualTextBill(text) {
            const lines = text.split("\n");
            const parsedItems = [];
            const tablets = this.getTablets();

            lines.forEach(line => {
                let item = this.parseOcrLine(line);
                if (!item) {
                    item = this.parseOcrLineLenient(line, tablets);
                }
                if (item) {
                    parsedItems.push(item);
                }
            });

            if (parsedItems.length === 0) {
                // Fallback to fuzzy block parser if line-by-line regex fails (e.g. for messy OCR outputs)
                const fuzzyItems = this.parseOcrBlockFuzzy(text, tablets);
                if (fuzzyItems.length > 0) {
                    parsedItems.push(...fuzzyItems);
                    this.showToast("Structured parsing failed. Used fuzzy medicine matcher to extract items.", "warning");
                } else {
                    this.showToast("No valid medicine lines could be parsed from the text. Check formatting.", "error");
                    return;
                }
            }

            // Assign local confidence scores dynamically
            parsedItems.forEach(item => {
                item.confidence_score = this.calculateLocalConfidence(item);
            });

            // Try to find a date in the text block (e.g. Date: 09/04/26 or 2026-04-09 or 09-04-2026)
            const dateRegex = /\b(\d{4}|\d{2})[\/\-.](\d{2})[\/\-.](\d{4}|\d{2})\b/;
            const dateMatch = text.match(dateRegex);
            let invoiceDate = new Date().toISOString().split('T')[0];
            if (dateMatch) {
                const rawDateStr = dateMatch[0].replace(/[\-.]/g, '/');
                const parts = rawDateStr.split('/');
                if (parts.length === 3) {
                    if (parts[0].length === 4) {
                        invoiceDate = `${parts[0]}-${parts[1]}-${parts[2]}`;
                    } else if (parts[2].length === 4) {
                        invoiceDate = `${parts[2]}-${parts[1]}-${parts[0]}`;
                    } else {
                        invoiceDate = `20${parts[2]}-${parts[1]}-${parts[0]}`;
                    }
                }
            }

            const supplier = "Manual Text Bill";
            const invoiceNo = "MAN-" + Math.floor(Math.random() * 90000 + 10000);

            this.renderExtractedItems(parsedItems, supplier, invoiceNo, invoiceDate);
            
            document.getElementById("extracted-invoice-details").classList.remove("hidden");
            
            const statusBadge = document.getElementById("ocr-badge-status");
            statusBadge.className = "status-badge badge-success";
            statusBadge.textContent = "Text Extracted";

            this.showToast("Manual text bill parsed successfully! Verify details below.");
        }

        // --- MANUAL FORM TAB METHODS ---
        updateManualBillDatalist() {
            const datalist = document.getElementById("manual-bill-tablets-list");
            if (datalist) {
                const tablets = this.getTablets();
                datalist.innerHTML = "";
                tablets.forEach(tab => {
                    const opt = document.createElement("option");
                    opt.value = tab.name;
                    datalist.appendChild(opt);
                });
            }

            const codesDatalist = document.getElementById("inventory-codes-list");
            if (codesDatalist) {
                const tablets = this.getTablets();
                codesDatalist.innerHTML = "";
                tablets.forEach(tab => {
                    if (tab.code) {
                        const opt = document.createElement("option");
                        opt.value = tab.code;
                        codesDatalist.appendChild(opt);
                    }
                });
            }
        }

        renderExtractedItems(items, supplier, invoiceNo, invoiceDate) {
            // Set input values in UI
            document.getElementById("ext-supplier").value = supplier;
            document.getElementById("ext-invoice-no").value = invoiceNo;
            document.getElementById("ext-invoice-date").value = invoiceDate;

            const tablets = this.getTablets();
            const normalizedItems = items.map(item => {
                let gstVal = item.gst || "5%";
                if (item.name.includes("EYEVITAL LX")) {
                    gstVal = "18%";
                }
                const mrpVal = item.mrp !== undefined && item.mrp !== null ? item.mrp : null;
                const costVal = item.cost !== undefined && item.cost !== null ? item.cost : (mrpVal !== null ? mrpVal / 1.4 : null);
                
                return {
                    name: item.name.toUpperCase(),
                    supplier_name: item.supplier_name || supplier,
                    brand_name: item.brand_name || "",
                    drug_name: item.drug_name || "",
                    discount_percent: item.discount_percent || "0%",
                    batch: item.batch !== undefined && item.batch !== null ? item.batch : null,
                    exp: item.exp !== undefined && item.exp !== null ? item.exp : null,
                    pack: item.pack || null,
                    qty: item.qty !== undefined && item.qty !== null ? item.qty : null,
                    free_qty: item.free_qty !== undefined && item.free_qty !== null ? item.free_qty : 0,
                    cost: costVal,
                    mrp: mrpVal,
                    gst: gstVal,
                    purchaseDate: invoiceDate,
                    status: item.status || "valid",
                    confidence_score: item.confidence_score !== undefined && item.confidence_score !== null ? item.confidence_score : null
                };
            });

            this.currentExtractedBill = {
                supplier: supplier,
                invoiceNo: invoiceNo,
                date: invoiceDate,
                items: normalizedItems
            };

            const tableBody = document.getElementById("extracted-items-table-body");
            tableBody.innerHTML = "";

            let matchedCount = 0;
            let notFoundCount = 0;
            let confSum = 0;
            let confCount = 0;

            // Summary dashboard counts
            let totalMedsCount = normalizedItems.length;
            let totalTabletsCount = 0;
            let totalCapsulesCount = 0;
            let totalSyrupsCount = 0;
            let totalInjectionsCount = 0;
            let totalRespulesCount = 0;
            let totalDropsCount = 0;
            let totalCreamsCount = 0;
            let totalOthersCount = 0;

            const categoriesList = [
                "Tablets & Capsules",
                "Rotacaps",
                "Inhalers",
                "Syrups & Oral Solutions",
                "Respules",
                "Injections",
                "Drops",
                "Sprays",
                "Creams / Gels / Ointments",
                "Powders",
                "Others"
            ];

            // Group items by category
            const groupedItems = {};
            categoriesList.forEach(cat => { groupedItems[cat] = []; });

            normalizedItems.forEach(billItem => {
                const match = this.resolveMedicine(billItem.name, null, tablets).tablet;
                const cat = this.detectCategoryFromName(billItem.name, billItem.pack);
                const targetCat = categoriesList.includes(cat) ? cat : "Others";
                groupedItems[targetCat].push({ billItem, match });

                if (match) {
                    matchedCount++;
                } else {
                    notFoundCount++;
                }

                const displayConf = billItem.confidence_score !== null && billItem.confidence_score !== undefined ? billItem.confidence_score : 0;
                confSum += displayConf;
                confCount++;

                // Quantity calculation for dashboard
                const parsedQty = this.parseQtyAndUnit(billItem.qty, billItem.name, match);
                const qtyUnitsObj = this.calculateTotalUnits(billItem.name, parsedQty.qty, billItem.pack, parsedQty.unit, match);
                const totalUnits = qtyUnitsObj.totalUnits;
                // New medicine (no Master Data match) AND the pack size was a
                // regex guess, not a confirmed read -- do not silently accept
                // whatever tabsPerStrip default was used. Route to Manual
                // Review instead of letting an unconfirmed guess become
                // permanent inventory/Master Data.
                if (qtyUnitsObj.needsReview && !billItem.needsPackReview) {
                    billItem.needsPackReview = true;
                    billItem.status = "manual_review";
                }

                if (targetCat === "Tablets & Capsules") {
                    const uName = billItem.name.toUpperCase();
                    if (uName.includes("CAP")) {
                        totalCapsulesCount += totalUnits;
                    } else {
                        totalTabletsCount += totalUnits;
                    }
                } else if (targetCat === "Syrups & Oral Solutions") {
                    totalSyrupsCount += totalUnits;
                } else if (targetCat === "Injections") {
                    totalInjectionsCount += totalUnits;
                } else if (targetCat === "Respules") {
                    totalRespulesCount += totalUnits;
                } else if (targetCat === "Drops") {
                    totalDropsCount += totalUnits;
                } else if (targetCat === "Creams / Gels / Ointments") {
                    totalCreamsCount += totalUnits;
                } else {
                    totalOthersCount += totalUnits;
                }
            });

            // Render category-wise tables inside table body
            categoriesList.forEach(categoryName => {
                const itemsInCategory = groupedItems[categoryName];
                if (itemsInCategory.length === 0) return;

                // Add category subheader row
                const headerTr = document.createElement("tr");
                headerTr.className = "category-header-row";
                headerTr.innerHTML = `
                    <td colspan="14" style="background: rgba(99, 102, 241, 0.12); font-weight: 700; color: var(--color-purple); font-size: 0.82rem; padding: 10px 14px; border-bottom: 2px solid rgba(99, 102, 241, 0.2); text-transform: uppercase; letter-spacing: 0.5px;">
                        ${categoryName} (${itemsInCategory.length} item${itemsInCategory.length !== 1 ? 's' : ''})
                    </td>
                `;
                tableBody.appendChild(headerTr);

                itemsInCategory.forEach(({ billItem, match }) => {
                    const displayConf = billItem.confidence_score !== null && billItem.confidence_score !== undefined ? billItem.confidence_score : 0;
                    let validationStatus = this.validateExtractedItem(billItem);
                    if (billItem.status === "manual_review") {
                        validationStatus = "manual_review";
                    }

                    let rowGlowClass = "";
                    const isUnmatched = !match;
                    const isLowConf = displayConf < 90;

                    if (validationStatus === "rejected") {
                        rowGlowClass = "expired-red-glow";
                    } else if (validationStatus === "manual_review") {
                        rowGlowClass = "expiring-orange-glow";
                    } else if (isUnmatched) {
                        rowGlowClass = "expiring-yellow-glow";
                    } else if (validationStatus === "warning" || isLowConf) {
                        rowGlowClass = "expiring-yellow-glow";
                    }

                    const tr = document.createElement("tr");
                    if (rowGlowClass) {
                        tr.className = rowGlowClass;
                    }
                    tr.dataset.confidence = displayConf;

                    const batchVal = billItem.batch !== null && billItem.batch !== undefined ? billItem.batch : "";
                    const expVal = billItem.exp !== null && billItem.exp !== undefined ? billItem.exp : "";
                    const freeVal = billItem.free_qty !== null && billItem.free_qty !== undefined ? billItem.free_qty : 0;
                    const costVal = billItem.cost !== null && billItem.cost !== undefined ? billItem.cost.toFixed(2) : "";
                    const mrpVal = billItem.mrp !== null && billItem.mrp !== undefined ? billItem.mrp.toFixed(2) : "";

                    const defaultCode = match ? match.code : (billItem.code || this.generateProductCode(billItem.name, this.extractPackNumber(billItem.pack, billItem.name)));

                    // Use detected unit and qty for display
                    const detectedUnit = billItem.purchase_unit || (match ? match.purchaseUnit : null);
                    let qtyVal = billItem.qty !== null && billItem.qty !== undefined ? billItem.qty : "";
                    if (qtyVal !== "" && detectedUnit) {
                        qtyVal = `${qtyVal} ${detectedUnit}${qtyVal > 1 ? 's' : ''}`;
                    }

                    tr.innerHTML = `
                        <td>
                            <input type="text" class="edit-item-supplier" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 100px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-billdate" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 90px; font-size: 0.8rem; font-family: monospace;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-name" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 220px; min-width: 220px; font-size: 0.8rem; font-weight: 600;">
                            <input type="hidden" class="edit-item-code" list="inventory-codes-list">
                        </td>
                        <td>
                            <input type="text" class="edit-item-brand" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-drug" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 160px; min-width: 160px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-batch" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem; font-family: monospace;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-exp" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 70px; font-size: 0.8rem; font-family: monospace;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-pack" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-qty" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="number" class="edit-item-free" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-discount" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="number" step="0.01" class="edit-item-mrp" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem;">
                        </td>
                        <td>
                            <input type="text" class="edit-item-gst" readonly style="background: transparent; border: 1px solid transparent; color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;">
                        </td>
                        <td class="ext-row-delete-cell hidden">
                            <button class="btn-row-delete" title="Delete row" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; border-radius: 6px; cursor: pointer; padding: 3px 7px; font-size: 0.85rem; line-height: 1;">✕</button>
                        </td>
                    `;
                    // All values below are OCR-derived (Gemini bill extraction) --
                    // assigned via the .value DOM property rather than baked into
                    // the HTML string above, so a maliciously-crafted supplier
                    // bill image can never break out of an attribute and inject
                    // markup/script here (see POST_IMPLEMENTATION_AUDIT.md,
                    // "Pre-existing HTML injection surface" -- this is the
                    // highest-traffic OCR render path, hit on every bill scan).
                    tr.querySelector(".edit-item-supplier").value = billItem.supplier_name;
                    tr.querySelector(".edit-item-billdate").value = billItem.purchaseDate;
                    tr.querySelector(".edit-item-name").value = billItem.name;
                    tr.querySelector(".edit-item-code").value = defaultCode;
                    tr.querySelector(".edit-item-brand").value = billItem.brand_name;
                    tr.querySelector(".edit-item-drug").value = billItem.drug_name;
                    tr.querySelector(".edit-item-batch").value = batchVal;
                    tr.querySelector(".edit-item-exp").value = expVal;
                    tr.querySelector(".edit-item-pack").value = billItem.pack;
                    tr.querySelector(".edit-item-qty").value = qtyVal;
                    tr.querySelector(".edit-item-free").value = freeVal;
                    tr.querySelector(".edit-item-discount").value = billItem.discount_percent;
                    tr.querySelector(".edit-item-mrp").value = mrpVal;
                    tr.querySelector(".edit-item-gst").value = billItem.gst;
                    tr.querySelector(".btn-row-delete").addEventListener("click", () => {
                        tr.remove();
                        this.updateExtractedItemCount();
                    });
                    tableBody.appendChild(tr);
                    this.bindExtractedRowEvents(tr);
                });
            });

            // Update preview dashboard details
            const avgConf = confCount > 0 ? Math.round(confSum / confCount) : 0;
            const summaryCard = document.getElementById("ocr-summary-card");
            if (summaryCard) {
                summaryCard.classList.remove("hidden");
                
                // Populate Dashboard Cards
                document.getElementById("ocr-stat-total").textContent = totalMedsCount;
                document.getElementById("ocr-stat-tablets").textContent = totalTabletsCount;
                document.getElementById("ocr-stat-capsules").textContent = totalCapsulesCount;
                document.getElementById("ocr-stat-syrups").textContent = totalSyrupsCount;
                document.getElementById("ocr-stat-injections").textContent = totalInjectionsCount;
                document.getElementById("ocr-stat-respules").textContent = totalRespulesCount;
                document.getElementById("ocr-stat-drops").textContent = totalDropsCount;
                document.getElementById("ocr-stat-creams").textContent = totalCreamsCount;
                document.getElementById("ocr-stat-others").textContent = totalOthersCount;
                
                // Populate bottom status bar
                document.getElementById("ocr-card-confidence").textContent = `${avgConf}%`;
                document.getElementById("ocr-card-matched").textContent = `${matchedCount} / ${normalizedItems.length}`;
                document.getElementById("ocr-card-invoice").textContent = invoiceNo ? `Invoice: ${invoiceNo}` : "";
            }

            // Update item count
            this.updateExtractedItemCount();

            // Reset edit mode to locked
            this._extractedEditMode = false;

            // Enable import button
            const btnImportBill = document.getElementById("btn-import-bill");
            if (btnImportBill) {
                btnImportBill.removeAttribute("disabled");
            }
        }

        updateExtractedItemCount() {
            const tbody = document.getElementById("extracted-items-table-body");
            const count = tbody ? tbody.querySelectorAll("tr").length : 0;
            const countEl = document.getElementById("ext-item-count");
            if (countEl) countEl.textContent = `(${count} items)`;
        }

        toggleExtractedEditMode() {
            // RBAC: Staff may Review/Verify/Import OCR results but never edit
            // them -- only Senior Officer and Administrator can. Guarded here
            // (not just by hiding the button) so this can't be bypassed by
            // calling the function directly.
            if (this.currentUser && this.currentUser.role === "Staff") {
                this.showToast("Editing OCR results requires Senior Officer or Administrator access.", "error");
                return;
            }

            this._extractedEditMode = !this._extractedEditMode;
            const isEdit = this._extractedEditMode;
            const btn = document.getElementById("btn-toggle-edit");
            const addBtn = document.getElementById("btn-add-extracted-row");
            const tbody = document.getElementById("extracted-items-table-body");
            const headerInputs = document.querySelectorAll("#ext-supplier, #ext-invoice-no, #ext-invoice-date");

            // Toggle header fields
            headerInputs.forEach(inp => {
                if (isEdit) {
                    inp.removeAttribute("readonly");
                    inp.style.background = "rgba(0,0,0,0.2)";
                    inp.style.border = "1px solid var(--border-color)";
                } else {
                    inp.setAttribute("readonly", true);
                    inp.style.background = "";
                    inp.style.border = "";
                }
            });

            // Toggle all table inputs
            if (tbody) {
                tbody.querySelectorAll("input").forEach(inp => {
                    if (isEdit) {
                        inp.removeAttribute("readonly");
                        inp.style.background = "rgba(0,0,0,0.2)";
                        inp.style.border = "1px solid var(--border-color)";
                    } else {
                        inp.setAttribute("readonly", true);
                        inp.style.background = "transparent";
                        inp.style.border = "1px solid transparent";
                    }
                });

                // Toggle delete buttons visibility
                tbody.querySelectorAll(".ext-row-delete-cell").forEach(td => {
                    td.classList.toggle("hidden", !isEdit);
                });
            }

            // Toggle actions column header
            document.querySelectorAll(".ext-actions-col").forEach(el => el.classList.toggle("hidden", !isEdit));

            // Toggle Add Row button
            if (addBtn) addBtn.classList.toggle("hidden", !isEdit);

            // Update button appearance
            if (btn) {
                if (isEdit) {
                    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Lock`;
                    btn.style.background = "linear-gradient(135deg, #3b82f6, #2563eb)";
                } else {
                    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg> Edit`;
                    btn.style.background = "linear-gradient(135deg, #f59e0b, #d97706)";
                }
            }

            this.showToast(isEdit ? "Edit mode enabled — modify any field, add or remove rows" : "Edit mode locked — fields are now read-only", isEdit ? "warning" : "info");
        }

        addExtractedRow() {
            const tbody = document.getElementById("extracted-items-table-body");
            if (!tbody) return;

            const supplier = document.getElementById("ext-supplier")?.value || "";
            const date = document.getElementById("ext-invoice-date")?.value || new Date().toISOString().split('T')[0];

            const tr = document.createElement("tr");
            tr.style.animation = "fadeIn 0.3s ease";
            // supplier/date can carry OCR-derived text (pre-filled from the
            // last scan into #ext-supplier/#ext-invoice-date) -- assign via
            // .value rather than baking into the HTML string, same reasoning
            // as renderExtractedItems above.
            tr.innerHTML = `
                <td><input type="text" class="edit-item-supplier" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 100px; font-size: 0.8rem;"></td>
                <td><input type="text" class="edit-item-billdate" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 90px; font-size: 0.8rem; font-family: monospace;"></td>
                <td><input type="text" class="edit-item-name" value="" placeholder="Medicine Name" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 220px; min-width: 220px; font-size: 0.8rem; font-weight: 600;"><input type="hidden" class="edit-item-code" list="inventory-codes-list" value=""></td>
                <td><input type="text" class="edit-item-brand" value="" placeholder="Brand" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem;"></td>
                <td><input type="text" class="edit-item-drug" value="" placeholder="Drug" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 160px; min-width: 160px; font-size: 0.8rem;"></td>
                <td><input type="text" class="edit-item-batch" value="" placeholder="Batch" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem; font-family: monospace;"></td>
                <td><input type="text" class="edit-item-exp" value="" placeholder="MM/YY" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 70px; font-size: 0.8rem; font-family: monospace;"></td>
                <td><input type="text" class="edit-item-pack" value="10's" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;"></td>
                <td>
                    <input type="number" class="edit-item-qty" value="" placeholder="Qty" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 70px; font-size: 0.8rem;">
                    <div class="edit-item-due-toggle" style="margin-top:3px;">
                        <button type="button" class="btn-mark-due" title="Mark part of this quantity as Supplier Due (short-supplied)" style="background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); color: #f59e0b; border-radius: 5px; cursor: pointer; padding: 2px 6px; font-size: 0.68rem; white-space: nowrap;">+ Due</button>
                        <input type="number" class="edit-item-due-qty hidden" placeholder="Due qty" min="0" style="display:none; margin-top:3px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.35); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 70px; font-size: 0.8rem;">
                    </div>
                </td>
                <td><input type="number" class="edit-item-free" value="0" placeholder="Free" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;"></td>
                <td><input type="text" class="edit-item-discount" value="0%" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;"></td>
                <td><input type="number" step="0.01" class="edit-item-mrp" value="" placeholder="MRP" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 80px; font-size: 0.8rem;"></td>
                <td><input type="text" class="edit-item-gst" value="5%" style="background: rgba(0,0,0,0.2); border: 1px solid var(--border-color); color: var(--text-primary); padding: 4px 8px; border-radius: 6px; width: 60px; font-size: 0.8rem;"></td>
                <td class="ext-row-delete-cell">
                    <button class="btn-row-delete" title="Delete row" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; border-radius: 6px; cursor: pointer; padding: 3px 7px; font-size: 0.85rem; line-height: 1;">✕</button>
                </td>
            `;
            tr.querySelector(".edit-item-supplier").value = supplier;
            tr.querySelector(".edit-item-billdate").value = date;
            tr.querySelector(".btn-mark-due").addEventListener("click", function () { window.app.toggleRowDueInput(this); });
            tr.querySelector(".btn-row-delete").addEventListener("click", () => {
                tr.remove();
                this.updateExtractedItemCount();
            });
            tbody.appendChild(tr);
            this.bindExtractedRowEvents(tr);
            this.updateExtractedItemCount();

            // Scroll to the new row
            tr.scrollIntoView({ behavior: "smooth", block: "nearest" });
            // Focus the medicine name field
            const nameInput = tr.querySelector(".edit-item-name");
            if (nameInput) nameInput.focus();

            this.showToast("New empty row added", "info");
        }

        addBillManualRow(nameValue = "", expValue = "", qtyValue = "", mrpValue = "", gstValue = "5%", costValue = "") {
            const container = document.getElementById("bill-manual-items-rows");
            if (!container) return;

            const rowId = `bill-row-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
            let costVal = costValue;
            if (!costVal && mrpValue) {
                const parsedMrp = parseFloat(mrpValue);
                if (!isNaN(parsedMrp)) {
                    costVal = (parsedMrp / 1.4).toFixed(2);
                }
            }
            
            const row = document.createElement("div");
            row.className = "bill-builder-row";
            row.id = rowId;
            // nameValue (and, less commonly, the other pre-filled values below)
            // can originate from OCR extraction (Gemini/local). Building them
            // into the `value="..."` attribute via string interpolation would
            // let a crafted document break out of the attribute and inject
            // markup/script (see POST_IMPLEMENTATION_AUDIT.md, "Pre-existing
            // HTML injection surface"). Instead, the inputs are created with
            // empty value attributes and populated via the `.value` DOM
            // property immediately after insertion, which never parses its
            // content as HTML regardless of what characters it contains.
            row.innerHTML = `
                <input type="text" class="bill-manual-name" list="manual-bill-tablets-list" placeholder="Medicine Name" required style="padding: 6px 10px; font-size: 0.8rem; border-radius: 8px;">
                <input type="text" class="bill-manual-exp" placeholder="MM/YY" required style="padding: 6px 10px; font-size: 0.8rem; border-radius: 8px;">
                <input type="number" class="bill-manual-qty" min="1" placeholder="Qty" required style="padding: 6px 10px; font-size: 0.8rem; border-radius: 8px;">
                <input type="number" step="0.01" class="bill-manual-cost" min="0" placeholder="Cost Price" required style="padding: 6px 10px; font-size: 0.8rem; border-radius: 8px;">
                <input type="number" step="0.01" class="bill-manual-mrp" min="0" placeholder="MRP" required style="padding: 6px 10px; font-size: 0.8rem; border-radius: 8px;">
                <input type="text" class="bill-manual-gst" placeholder="GST %" required style="padding: 6px 10px; font-size: 0.8rem; border-radius: 8px;">
                <button type="button" class="btn btn-icon-only danger" title="Remove row" style="padding: 4px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                </button>
            `;
            row.querySelector(".bill-manual-name").value = nameValue;
            row.querySelector(".bill-manual-exp").value = expValue;
            row.querySelector(".bill-manual-qty").value = qtyValue;
            row.querySelector(".bill-manual-cost").value = costVal;
            row.querySelector(".bill-manual-mrp").value = mrpValue;
            row.querySelector(".bill-manual-gst").value = gstValue;
            row.querySelector(".btn-icon-only.danger").addEventListener("click", () => {
                const el = document.getElementById(rowId);
                if (el) el.remove();
            });
            container.appendChild(row);

            const mrpInput = row.querySelector(".bill-manual-mrp");
            const costInput = row.querySelector(".bill-manual-cost");
            mrpInput.addEventListener("input", () => {
                if (!costInput.value) {
                    const parsedMrp = parseFloat(mrpInput.value);
                    if (!isNaN(parsedMrp)) {
                        costInput.value = (parsedMrp / 1.4).toFixed(2);
                    }
                }
            });
        }

        compileManualBillForm() {
            const supplier = document.getElementById("bill-manual-supplier").value.trim() || "Manual Entry";
            const invoiceNo = document.getElementById("bill-manual-invoice-no").value.trim() || "MAN-" + Math.floor(Math.random() * 90000 + 10000);
            
            let invoiceDate = document.getElementById("bill-manual-date").value;
            if (!invoiceDate) {
                invoiceDate = new Date().toISOString().split('T')[0];
            }

            const rows = document.querySelectorAll("#bill-manual-items-rows .bill-builder-row");
            const parsedItems = [];
            const tablets = this.getTablets();

            let hasError = false;

            rows.forEach((row, index) => {
                if (hasError) return;

                const nameInput = row.querySelector(".bill-manual-name");
                const expInput = row.querySelector(".bill-manual-exp");
                const qtyInput = row.querySelector(".bill-manual-qty");
                const costInput = row.querySelector(".bill-manual-cost");
                const mrpInput = row.querySelector(".bill-manual-mrp");
                const gstInput = row.querySelector(".bill-manual-gst");

                const name = nameInput.value.trim();
                const exp = expInput.value.trim();
                const qty = parseInt(qtyInput.value);
                const cost = parseFloat(costInput.value);
                const mrp = parseFloat(mrpInput.value);
                let gst = gstInput ? gstInput.value.trim() : "5%";

                if (!name) {
                    this.showToast(`Row ${index + 1}: Medicine name is required.`, "error");
                    nameInput.focus();
                    hasError = true;
                    return;
                }

                const expRegex = /^(0[1-9]|1[0-2])[\/\-.](\d{2}|\d{4})$/;
                if (!expRegex.test(exp)) {
                    this.showToast(`Row ${index + 1}: Expiry must be MM/YY (e.g. 08/27).`, "error");
                    expInput.focus();
                    hasError = true;
                    return;
                }

                if (isNaN(qty) || qty <= 0) {
                    this.showToast(`Row ${index + 1}: Quantity must be a positive integer.`, "error");
                    qtyInput.focus();
                    hasError = true;
                    return;
                }

                if (isNaN(cost) || cost < 0) {
                    this.showToast(`Row ${index + 1}: Cost Price must be positive or 0.`, "error");
                    costInput.focus();
                    hasError = true;
                    return;
                }

                if (isNaN(mrp) || mrp < 0) {
                    this.showToast(`Row ${index + 1}: MRP must be positive or 0.`, "error");
                    mrpInput.focus();
                    hasError = true;
                    return;
                }

                if (!gst) {
                    gst = "5%";
                } else if (!gst.endsWith("%")) {
                    gst = gst + "%";
                }

                const normalizedExp = exp.replace(/[\-.]/g, '/');

                parsedItems.push({
                    name: name,
                    batch: "BAT-999",
                    exp: normalizedExp,
                    pack: "10's",
                    qty: qty,
                    cost: cost,
                    mrp: mrp,
                    gst: gst,
                    confidence_score: 100
                });
            });

            if (hasError) return;

            if (parsedItems.length === 0) {
                this.showToast("Please add at least one item row.", "error");
                return;
            }

            this.renderExtractedItems(parsedItems, supplier, invoiceNo, invoiceDate);

            document.getElementById("extracted-invoice-details").classList.remove("hidden");
            document.getElementById("scanner-canvas").classList.add("hidden");
            document.getElementById("scanner-empty-state").classList.remove("hidden");

            const statusBadge = document.getElementById("ocr-badge-status");
            statusBadge.className = "status-badge badge-success";
            statusBadge.textContent = "Form Compiled";

            this.showToast("Manual form compiled successfully! Verify details on the right.");
        }

        parseOcrBlockFuzzy(text, tablets) {
            const parsedItems = [];
            const upperText = text.toUpperCase();

            tablets.forEach(tab => {
                const nameWords = tab.name.split(/\s+/).filter(w => 
                    w.length > 2 && 
                    w !== "USV" && 
                    w !== "L." && 
                    w !== "PHAR" && 
                    w !== "LUPIN" && 
                    w !== "GRAN" && 
                    w !== "REDD" && 
                    w !== "TABS" && 
                    w !== "TAB" && 
                    w !== "MG" && 
                    w !== "ML"
                );

                let isMatch = false;
                if (nameWords.length > 0) {
                    const mainKey = nameWords[0];
                    if (upperText.includes(mainKey)) {
                        isMatch = true;
                    }
                }

                if (isMatch) {
                    const idx = upperText.indexOf(nameWords[0]);
                    const start = Math.max(0, idx - 30);
                    const end = Math.min(text.length, idx + tab.name.length + 90);
                    const context = text.substring(start, end).replace(/\n/g, ' ');

                    // Expiry Search
                    const expRegex = /\b(0[1-9]|1[0-2])[\/\-.\s](2[6-9]|3[0-5]|202[6-9]|203[0-5])\b/;
                    const expMatch = context.match(expRegex);
                    const expiry = expMatch ? expMatch[0].replace(/[\-\.\s]/g, '/') : "12/28";

                    let cleanContext = context;
                    if (expMatch) {
                        cleanContext = cleanContext.replace(expMatch[0], '');
                    }

                    // Extract numbers
                    const integers = cleanContext.match(/\b\d+\b/g) || [];
                    const filteredInts = integers.filter(n => {
                        const val = parseInt(n);
                        return val < 2025 || val > 2035;
                    });

                    let qty = 10;
                    let batch = "BAT-999";

                    if (filteredInts.length > 0) {
                        const typicalQuantities = [90, 180, 20, 30, 10, 50, 100, 150, 60, 120, 80, 140, 95, 65, 200, 15];
                        const matchTypical = filteredInts.find(n => typicalQuantities.includes(parseInt(n)));
                        if (matchTypical) {
                            qty = parseInt(matchTypical);
                        } else {
                            // Avoid picking small single digit indexes if larger quantity numbers are present
                            const candidates = filteredInts.map(n => parseInt(n)).filter(val => val > 0);
                            if (candidates.length > 1) {
                                // Prefer double/triple digits for quantity
                                const doubleDigit = candidates.find(val => val >= 10 && val <= 500);
                                qty = doubleDigit || candidates[0];
                            } else if (candidates.length > 0) {
                                qty = candidates[0];
                            }
                        }
                    }

                    // Batch code detection (alphanumeric, length 3-10)
                    const words = cleanContext.split(/\s+/);
                    const potentialBatches = words.filter(w => {
                        const cleanW = w.replace(/[^a-z0-9]/gi, '');
                        return cleanW.length >= 3 && cleanW.length <= 10 && 
                               !cleanW.match(/^\d+$/) && 
                               !tab.name.includes(cleanW.toUpperCase()) &&
                               !["BATCH", "EXP", "QTY", "MRP", "TAB", "PACKS", "PACK"].includes(cleanW.toUpperCase());
                    });

                    if (potentialBatches.length > 0) {
                        batch = potentialBatches[0].replace(/[^a-z0-9]/gi, '').toUpperCase();
                    } else {
                        const numBatch = filteredInts.find(n => n.length === 4);
                        if (numBatch) batch = numBatch;
                    }

                    const decimalRegex = /\b\d+\.\d{2}\b/;
                    const decMatch = cleanContext.match(decimalRegex);
                    const cost = decMatch ? parseFloat(decMatch[0]) : tab.cost;

                    parsedItems.push({
                        name: tab.name,
                        brand: tab.brand,
                        batch: batch,
                        exp: expiry,
                        pack: tab.pack,
                        qty: qty,
                        cost: cost,
                        mrp: tab.mrp
                    });
                }
            });

            return parsedItems;
        }

        // Performance fix (Supplier Bill OCR / Order Sheet OCR): full-resolution
        // phone-camera photos (often 3000-4000px wide, several MB) were being
        // base64-encoded and sent to Gemini as-is. Encoding, uploading and having
        // the model process an image that large is far slower than necessary --
        // printed invoice/order-sheet text is fully legible at a much smaller
        // resolution. Downscaling to a max dimension (and re-encoding as JPEG)
        // shrinks the payload dramatically with no meaningful accuracy loss,
        // which speeds up every stage of the pipeline (network transfer,
        // model processing) without changing the OCR workflow itself.
        // No-op for anything that isn't a raster image (e.g. PDFs) or if
        // resizing fails for any reason -- callers always get back a usable
        // base64 string, worst case unchanged from the input.
        async resizeBase64ImageForOCR(base64Data, mimeType, maxDim = 1600, quality = 0.75) {
            const _resizeStart = performance.now();
            const _finish = (result) => {
                this._lastOcrResizeMs = Math.round(performance.now() - _resizeStart);
                return result;
            };
            if (!mimeType || !mimeType.startsWith("image/")) return _finish({ base64: base64Data, mimeType });
            try {
                const dataUrl = `data:${mimeType};base64,${base64Data}`;
                const img = await new Promise((resolve, reject) => {
                    const i = new Image();
                    i.onload = () => resolve(i);
                    i.onerror = reject;
                    i.src = dataUrl;
                });
                if (!img.width || !img.height) return _finish({ base64: base64Data, mimeType });
                if (img.width <= maxDim && img.height <= maxDim) {
                    // Already small enough -- resizing would only waste time re-encoding.
                    return _finish({ base64: base64Data, mimeType });
                }
                const scale = maxDim / Math.max(img.width, img.height);
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const resizedDataUrl = canvas.toDataURL("image/jpeg", quality);
                return _finish({ base64: resizedDataUrl.split(",")[1], mimeType: "image/jpeg" });
            } catch (e) {
                console.warn("OCR image resize skipped (falling back to original image):", e);
                return _finish({ base64: base64Data, mimeType });
            }
        }

        // ============================================================
        // PRIORITY 3 -- OCR PROVIDER ABSTRACTION / LOCAL FALLBACK / QUEUE
        // ------------------------------------------------------------
        // Additive layer built on top of the existing Gemini engine
        // below. None of the existing methods in this class (resizeBase64
        // ImageForOCR, runSharedGeminiVisionOCR, _classifyGeminiError,
        // parseOrderSheet, parseSupplierBill, normalizeOCRResponse,
        // validateOCRFields, the whole import workflow) are modified.
        // These new entry points are opt-in: nothing existing calls them
        // yet, so today's scan flows behave exactly as before. They exist
        // so batch/local-OCR/preprocessing features can be wired into the
        // UI incrementally without any risk to the already-shipped path.
        // ============================================================

        // Lazily builds (once) the provider instances this app can use.
        // Kept lazy so app.js has zero hard dependency on ocr/*.js having
        // loaded yet -- if those scripts are missing for any reason, every
        // method below degrades to "Gemini only", which is exactly
        // today's existing behavior.
        _getOCRProviders() {
            if (this._ocrProviders) return this._ocrProviders;
            const providers = {};
            try {
                if (window.OCRProviders && window.OCRProviders.GeminiProvider) {
                    providers.gemini = new window.OCRProviders.GeminiProvider(this);
                }
            } catch (e) { console.warn("[OCR] Gemini provider unavailable:", e); }
            try {
                if (window.OCRProviders && window.OCRProviders.TesseractProvider) {
                    providers.tesseract = new window.OCRProviders.TesseractProvider();
                }
            } catch (e) { console.warn("[OCR] Tesseract provider unavailable:", e); }
            this._ocrProviders = providers;
            return providers;
        }

        // Phase 3.1 entry point: run the new preprocessing module ahead of
        // the existing resize step. Never called by the existing scan
        // flows today (see note above) -- available for new batch/local
        // OCR call sites, and safe to opt individual flows into later
        // since a preprocessing failure always degrades to the original
        // image, identical to what happens today.
        async preprocessImageForOCR(base64Data, mimeType, options) {
            if (!window.OCRPreprocessor) return { base64: base64Data, mimeType, steps: [], skipped: ["module-not-loaded"] };
            try {
                return await window.OCRPreprocessor.process(base64Data, mimeType, options);
            } catch (e) {
                console.warn("[OCR] Preprocessing failed, using original image:", e);
                return { base64: base64Data, mimeType, steps: [], skipped: ["exception: " + e.message] };
            }
        }

        // Priority 3.11, Requirement 6 -- OCR Telemetry.
        // Stored in the EXISTING audit log (this.logAudit / ti_audit_log /
        // audit_logs cloud table) -- no second logging system. Failures to
        // write telemetry never throw; telemetry is diagnostic, not
        // business-critical, and must not be able to break a scan.
        _recordOCRTelemetry(fields) {
            try {
                const entry = {
                    provider: fields.provider,
                    fallbackUsed: !!fields.fallbackUsed,
                    fallbackReason: fields.fallbackReason || null,
                    preprocessingMs: fields.preprocessingMs != null ? fields.preprocessingMs : null,
                    ocrMs: fields.ocrMs != null ? fields.ocrMs : null,
                    retryCount: fields.retryCount || 0,
                    averageConfidence: fields.confidence != null ? fields.confidence : null,
                    queueWaitMs: fields.queueWaitMs != null ? fields.queueWaitMs : null,
                    processingDurationMs: fields.processingDurationMs != null ? fields.processingDurationMs : null,
                    scanType: fields.type || null,
                    failed: !!fields.failed
                };
                this.logAudit("OCR", fields.failed ? "ocr_scan_failed" : "ocr_scan", null, entry,
                    `${entry.provider || "unknown"} ${entry.scanType || ""} scan`.trim());
            } catch (e) {
                console.warn("[OCR] Telemetry recording failed (non-fatal):", e);
            }
        }

        // Phase A migration -- Provider Selection (REVISED).
        // Priority is now: 1) Local Tesseract (PRIMARY, always runs first,
        // zero cloud dependency)  2) Gemini, OPT-IN secondary verification
        // ONLY -- gated by _getOCRPolicy().enableGeminiVerification
        // (default false) AND only fired when Tesseract's own confidence
        // is below lowConfidenceThreshold. With the default policy, a
        // supplier-bill or order-sheet scan NEVER calls the Gemini API,
        // so a leaked/revoked/quota-exhausted key can no longer break
        // the scan button (the original complaint this migration fixes).
        // If Tesseract itself failed to load (script missing/blocked),
        // Gemini is used as a last-resort so the scanner still works at
        // all that day -- this is the one exception to "opt-in only",
        // justified by the "must work every day" requirement; it is
        // logged via fallbackReason so it's visible in telemetry, not
        // silent. `type`/`fallbackSupplier` are passed to OCRSharedParser
        // exactly as before so output lands in the schema
        // normalizeOCRResponse/validateOCRFields already expect.
        async recognizeWithProviderFallback(base64Data, mimeType, prompt, onProgress, type, fallbackSupplier, preprocessingMs) {
            const providers = this._getOCRProviders();
            const offline = (typeof navigator !== "undefined" && navigator.onLine === false);
            const ocrStart = performance.now();
            const policy = this._getOCRPolicy();

            const wrapTesseract = async () => {
                const raw = await providers.tesseract.recognize(base64Data, mimeType, prompt, onProgress);
                let structured = raw.text;
                try {
                    if (window.OCRSharedParser && typeof raw.text === "string") {
                        structured = window.OCRSharedParser.parseLocalText(raw.text, type, { fallbackSupplier });
                    }
                } catch (e) {
                    console.warn("[OCR] Shared parser failed on local OCR text, returning empty item set:", e);
                    structured = type === "bill" ? { items: [] } : { items: [] };
                }
                return {
                    text: structured,
                    confidence: raw.confidence,
                    provider: "tesseract",
                    metadata: Object.assign({}, raw.metadata, { ocrMs: Math.round(performance.now() - ocrStart) })
                };
            };

            const tesseractLoaded = !!(providers.tesseract && providers.tesseract.isAvailable());

            if (tesseractLoaded) {
                const localResult = await wrapTesseract();
                const lowConfidence = typeof localResult.confidence === "number" && localResult.confidence < policy.lowConfidenceThreshold;
                const geminiEligible = policy.enableGeminiVerification && lowConfidence &&
                    providers.gemini && providers.gemini.isAvailable() && !offline;

                if (!geminiEligible) {
                    this._recordOCRTelemetry({
                        provider: "tesseract", fallbackUsed: false, fallbackReason: null,
                        ocrMs: localResult.metadata.ocrMs, retryCount: 0, confidence: localResult.confidence,
                        type, preprocessingMs
                    });
                    return localResult;
                }

                // Low-confidence local read + verification explicitly enabled --
                // ask Gemini to verify/transcribe. A Gemini failure here (quota,
                // 403, network) is NON-FATAL: since it's opt-in verification of
                // an already-usable (if uncertain) local result, we just keep
                // the local read and let the existing manual-review gate handle
                // the low confidence, exactly as it would have anyway.
                try {
                    const verified = await providers.gemini.recognize(base64Data, mimeType, prompt, onProgress);
                    this._recordOCRTelemetry({
                        provider: "gemini", fallbackUsed: true, fallbackReason: "Low-confidence local OCR verification",
                        ocrMs: Math.round(performance.now() - ocrStart),
                        retryCount: (verified.metadata && verified.metadata.retryLog) ? verified.metadata.retryLog.length : 0,
                        confidence: verified.confidence, type, preprocessingMs
                    });
                    return Object.assign({}, verified, { metadata: Object.assign({}, verified.metadata, { usedSecondaryVerification: true }) });
                } catch (err) {
                    console.warn("[OCR] Optional Gemini verification failed -- keeping local Tesseract result:", err);
                    this._recordOCRTelemetry({
                        provider: "tesseract", fallbackUsed: false, fallbackReason: "Gemini verification unavailable (kept local result)",
                        ocrMs: localResult.metadata.ocrMs, retryCount: 0, confidence: localResult.confidence,
                        type, preprocessingMs
                    });
                    return localResult;
                }
            }

            // Tesseract failed to load at all -- Gemini is the only remaining
            // way to scan today. This is a last-resort exception, not the
            // default path (see header comment).
            if (providers.gemini && providers.gemini.isAvailable() && !offline) {
                console.warn("[OCR] Local Tesseract provider unavailable -- using Gemini as last-resort primary.");
                const result = await providers.gemini.recognize(base64Data, mimeType, prompt, onProgress);
                this._recordOCRTelemetry({
                    provider: "gemini", fallbackUsed: true, fallbackReason: "Local OCR unavailable (last resort)",
                    ocrMs: Math.round(performance.now() - ocrStart),
                    retryCount: (result.metadata && result.metadata.retryLog) ? result.metadata.retryLog.length : 0,
                    confidence: result.confidence, type, preprocessingMs
                });
                return result;
            }

            throw new Error("No OCR provider is available (local Tesseract not loaded, Gemini not configured/offline).");
        }

        // Central place to read the OCR provider policy. Defaults to the
        // Phase A migration goal: local-first, Gemini opt-in only. Reads
        // an optional override from localStorage (ti_ocr_policy) so this
        // can be exposed as a Settings toggle later without another code
        // change -- if that key is absent or invalid, the safe default
        // (Gemini OFF) applies.
        _getOCRPolicy() {
            const defaults = { enableGeminiVerification: false, lowConfidenceThreshold: 60 };
            try {
                const raw = localStorage.getItem("ti_ocr_policy");
                if (!raw) return defaults;
                const parsed = JSON.parse(raw);
                return {
                    enableGeminiVerification: !!parsed.enableGeminiVerification,
                    lowConfidenceThreshold: typeof parsed.lowConfidenceThreshold === "number" ? parsed.lowConfidenceThreshold : defaults.lowConfidenceThreshold
                };
            } catch (e) {
                return defaults;
            }
        }

        // Phase 3.6 -- Batch Processing entry point.
        // Runs a bounded-concurrency queue of OCR jobs (one per file) using
        // the existing per-file scanning logic supplied by the caller,
        // with progress callbacks, retry, and cancel/resume. Does not
        // replace the existing single-image scan buttons; this is a new
        // capability for wiring up a future multi-file drop zone.
        createOCRBatchQueue(files, { concurrency = 2, onProgress, buildTask } = {}) {
            if (!window.OCRQueue) throw new Error("ocr/queue.js is not loaded -- batch OCR unavailable.");
            const queue = new window.OCRQueue({ concurrency });
            if (typeof onProgress === "function") queue.onProgress = onProgress;
            queue.addAll(Array.from(files), (file) => buildTask(file, this));
            return queue;
        }

        // Priority 3.11, Requirement 5 -- Queue Integration.
        // Batch entry point: reads each File with FileReader, then runs it
        // through the EXACT SAME parseOrderSheet/parseSupplierBill used by
        // the existing single-file scan flows (so preprocessing, provider
        // fallback, retry, JSON repair, medicine matching, and manual
        // review are all identical per-file) -- OCRQueue only adds bounded
        // concurrency, retry-on-queue-failure, progress, and cancel/resume
        // around calling that same per-file function multiple times.
        async scanImagesBatch(fileList, type, { concurrency = 2, onProgress } = {}) {
            const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            const queue = this.createOCRBatchQueue(fileList, {
                concurrency,
                onProgress,
                buildTask: async (file) => {
                    try {
                        const dataUrl = await readFileAsDataUrl(file);
                        const [, mimeType, base64Data] = dataUrl.match(/^data:(.+);base64,(.*)$/) || [];
                        if (!base64Data) throw new Error(`Unsupported or corrupted file: ${file.name}`);
                        const parsed = type === "bill"
                            ? await this.parseSupplierBill(base64Data, mimeType)
                            : await this.parseOrderSheet(base64Data, mimeType);
                        return { fileName: file.name, parsed };
                    } catch (err) {
                        // Never let one bad file (corrupted image, unsupported
                        // format) crash the batch or the UI -- surface it as
                        // a per-job failure; the queue's own retry/cancel
                        // logic and the caller's UI decide what to do next.
                        console.warn(`[OCR] Batch job failed for ${file.name}:`, err);
                        throw err;
                    }
                }
            });

            await queue.run();
            return queue.results();
        }

        // Priority 2 -- Batch OCR queue, wired into the production Bill
        // Processing UI. Runs scanImagesBatch (unchanged) to OCR every
        // selected file IN PARALLEL, bounded by concurrency, with a live
        // progress bar. Deliberately does NOT try to auto-import every
        // result: duplicate-detection, medicine matching, and validation in
        // importExtractedBillResolved() are all per-invoice-header-form,
        // synchronous-looking-but-sometimes-modal-interrupted flows that
        // must not be touched or raced against each other. Instead, once
        // scanning finishes, successfully-parsed bills are queued in
        // memory and the user reviews/imports them ONE AT A TIME through
        // the exact same, completely unmodified Extracted Items table and
        // "Verify & Import Stock" button -- this only parallelizes OCR.
        async startBatchBillScan(files) {
            const progressPanel = document.getElementById("batch-ocr-progress");
            const progressLabel = document.getElementById("batch-ocr-progress-label");
            const progressPct = document.getElementById("batch-ocr-progress-pct");
            const progressBar = document.getElementById("batch-ocr-progress-bar");

            if (progressPanel) progressPanel.classList.remove("hidden");
            if (progressLabel) progressLabel.textContent = `Scanning 0 of ${files.length}...`;
            if (progressPct) progressPct.textContent = "0%";
            if (progressBar) progressBar.style.width = "0%";

            this.showToast(`Batch scanning ${files.length} bill(s)...`, "info");

            let results;
            try {
                results = await this.scanImagesBatch(files, "bill", {
                    concurrency: 2,
                    onProgress: (state) => {
                        const done = state.done + state.failed + state.cancelled;
                        if (progressLabel) progressLabel.textContent = `Scanning ${done} of ${state.total}...`;
                        if (progressPct) progressPct.textContent = `${state.percentComplete}%`;
                        if (progressBar) progressBar.style.width = `${state.percentComplete}%`;
                    }
                });
            } catch (err) {
                if (progressPanel) progressPanel.classList.add("hidden");
                this.showToast(`Batch scan failed: ${err.message}`, "error");
                return;
            }

            if (progressPanel) progressPanel.classList.add("hidden");

            const succeeded = results.filter(r => r.status === "done" && r.result && r.result.parsed);
            const failed = results.filter(r => r.status !== "done");

            if (failed.length > 0) {
                this.triggerNotification(
                    "OCR", "Batch scan: some files failed",
                    `🟠 Batch Bill Scan\n${succeeded.length} of ${results.length} scanned successfully.\nFailed: ${failed.map(f => f.label).join(", ")}`,
                    "Warning", { failedCount: failed.length, totalCount: results.length }
                );
            }

            if (succeeded.length === 0) {
                this.showToast(`Batch scan finished, but no bills could be read (${failed.length} failed). Try uploading them individually.`, "error");
                return;
            }

            // Store the queue of successfully-scanned bills (raw parseSupplierBill
            // output per file, same shape the single-scan flow produces) and
            // load the first one into the existing review UI.
            this._batchBillReviewQueue = succeeded.map(r => ({ fileName: r.label, parsed: r.result.parsed }));
            this._batchBillReviewIndex = 0;

            this.showToast(`Batch scan complete: ${succeeded.length} of ${results.length} bill(s) scanned. Review and import them one at a time below.`, "success");
            this._loadBatchBillReviewItem(0);
        }

        // Loads one already-scanned batch result into the SAME
        // renderExtractedItems table the single-file flow uses --
        // mirrors the exact supplier/invoiceNo/invoiceDate/items mapping
        // used at the single-scan completion site (see runStagedOCRScan),
        // without modifying that function.
        _loadBatchBillReviewItem(index) {
            const queue = this._batchBillReviewQueue;
            if (!queue || !queue[index]) return;

            const { parsed, fileName } = queue[index];
            const supplier = parsed.supplier_name || "Extracted Supplier";
            const invoiceNo = parsed.invoice_number || "OCR-" + Math.floor(Math.random() * 90000 + 10000);
            const invoiceDate = parsed.purchase_date || new Date().toISOString().split('T')[0];
            const items = (parsed.items || []).map(item => this.validateOCRFields(item, "bill", supplier));

            if (items.length === 0) {
                this.showToast(`"${fileName}" produced zero medicine rows -- skipping to the next batch item.`, "warning");
                this._advanceBatchBillReview(index);
                return;
            }

            this.renderExtractedItems(items, supplier, invoiceNo, invoiceDate);
            document.getElementById("extracted-invoice-details")?.classList.remove("hidden");
            this._updateBatchNextButton();
            this.showToast(`Reviewing "${fileName}" (${index + 1} of ${queue.length} in this batch).`, "info");
        }

        _updateBatchNextButton() {
            const btn = document.getElementById("btn-batch-next");
            const remainingLabel = document.getElementById("batch-next-remaining");
            const queue = this._batchBillReviewQueue;
            const hasMore = queue && this._batchBillReviewIndex < queue.length - 1;
            if (btn) btn.classList.toggle("hidden", !hasMore);
            if (remainingLabel) {
                remainingLabel.classList.toggle("hidden", !hasMore);
                if (hasMore) remainingLabel.textContent = `${queue.length - this._batchBillReviewIndex - 1} more scanned`;
            }
        }

        // User-driven advance -- clicking "Next Scanned Bill" does NOT try
        // to infer whether the current one was imported (importExtractedBillResolved
        // is async and can be interrupted by the Medicine Confirmation
        // modal), so it's a deliberate manual step, not automatic chaining.
        loadNextBatchBillResult() {
            this._advanceBatchBillReview(this._batchBillReviewIndex);
        }

        _advanceBatchBillReview(fromIndex) {
            if (!this._batchBillReviewQueue) return;
            const nextIndex = fromIndex + 1;
            if (nextIndex >= this._batchBillReviewQueue.length) {
                this.showToast("That was the last bill in this batch.", "info");
                this._batchBillReviewQueue = null;
                this._batchBillReviewIndex = 0;
                this._updateBatchNextButton();
                return;
            }
            this._batchBillReviewIndex = nextIndex;
            this._loadBatchBillReviewItem(nextIndex);
        }

        // Phase 3.7 -- Confidence-based manual review flag.
        // Additive helper: tags an already-normalized OCR item with
        // needsReview=true if any of its per-field confidence values is
        // below threshold. Does NOT change existing manualReview counters
        // (diag.manualReview) or validateOCRFields' own confidence_score
        // defaulting -- it only adds a `needsReview` boolean field for any
        // NEW UI (e.g. batch review screen) to key off, so existing
        // Manual Review gating logic is untouched.
        flagLowConfidenceFields(item, threshold = 60) {
            if (!item || typeof item !== "object") return item;
            let lowest = null;
            const scan = (obj) => {
                if (!obj || typeof obj !== "object") return;
                Object.values(obj).forEach(v => {
                    if (typeof v === "number" && (lowest === null || v < lowest)) lowest = v;
                });
            };
            if (item.confidence && typeof item.confidence === "object") scan(item.confidence);
            if (typeof item.confidence_score === "number") {
                lowest = lowest === null ? item.confidence_score : Math.min(lowest, item.confidence_score);
            }
            if (item.field_confidence && typeof item.field_confidence === "object") scan(item.field_confidence);
            item.needsReview = lowest !== null && lowest < threshold;
            item.lowestFieldConfidence = lowest;
            return item;
        }

        // ============================================================
        // SHARED OCR ENGINE
        // ------------------------------------------------------------
        // ONE entry point used by BOTH the Order Sheet Scanner and the
        // Supplier Bill Scanner. Each caller supplies its own prompt /
        // schema; this method owns everything else the two scanners
        // used to duplicate:
        //   Image Optimization (resize <=1600px, JPEG 85%)
        //   -> ONE Gemini Vision request
        //   -> Strict JSON validation (parseGeminiJSON)
        //   -> exactly ONE retry, and ONLY on invalid JSON / HTTP /
        //      timeout failures -- never a second, different engine.
        // No regex parser, no local OCR, no AI text parser, no second
        // Gemini request beyond the single allowed retry.
        // ============================================================
        // Classifies a Gemini call failure as "high demand" (retryable, NOT an
        // OCR failure) vs a genuine failure (auth, decode, network, malformed
        // JSON after repair, etc -- these still bubble up as hard errors).
        _isGeminiBusyError(err) {
            if (!err) return false;
            if (err.httpStatus === 429 || err.httpStatus === 503) return true;
            const msg = (err.message || "").toLowerCase();
            return /\b429\b/.test(msg) || /\b503\b/.test(msg) ||
                /high demand/.test(msg) || /quota.*exceed/.test(msg) ||
                /model.*overloaded/.test(msg) || /overloaded/.test(msg) ||
                /service unavailable/.test(msg) || /temporarily unavailable/.test(msg) ||
                /try again later/.test(msg);
        }

        // Precise failure classifier used for (1) deciding what's safe to
        // retry and (2) showing a real reason in Scan Diagnostics instead of
        // a generic FAIL. Kept separate from _isGeminiBusyError (still used
        // for the exhausted-retry busy-banner check) so neither function's
        // existing callers change behavior.
        //
        // Retryable: timeout, quota (429), service unavailable/overloaded (503).
        // NOT retryable: auth (401/403), invalid request (400), invalid/unknown
        // model (404 "not found"), malformed JSON (handled by its own existing
        // one-shot repair attempt, not the general retry loop).
        _classifyGeminiError(err) {
            if (!err) return { code: "unknown", label: "OCR Extraction Failed", retryable: false };

            const status = err.httpStatus;
            const msg = (err.message || "").toLowerCase();

            if (err.isTimeout || /timed out/.test(msg)) {
                return { code: "timeout", label: "Timeout", retryable: true };
            }
            if (status === 401 || status === 403 || /api key not valid/.test(msg) || /permission denied/.test(msg)) {
                return { code: "auth", label: "Invalid API Key", retryable: false };
            }
            if (status === 404 || (/not found/.test(msg) && /model/.test(msg))) {
                return { code: "invalid_model", label: "Invalid Model", retryable: false };
            }
            if (status === 400) {
                return { code: "invalid_request", label: "Invalid Request", retryable: false };
            }
            if (status === 429 || /\b429\b/.test(msg) || /quota.*exceed/.test(msg)) {
                return { code: "quota", label: "Quota Exceeded", retryable: true };
            }
            if (status === 503 || /\b503\b/.test(msg) || /overloaded/.test(msg) ||
                /service unavailable/.test(msg) || /temporarily unavailable/.test(msg) ||
                /high demand/.test(msg) || /try again later/.test(msg)) {
                return { code: "service_busy", label: "Service Busy", retryable: true };
            }
            if (/invalid ai response format/.test(msg)) {
                return { code: "invalid_json", label: "JSON Parse Failed", retryable: false };
            }
            return { code: "unknown", label: "OCR Extraction Failed", retryable: false };
        }

        async runSharedGeminiVisionOCR(base64Data, mimeType, prompt, onProgress) {
            const apiKey = localStorage.getItem("ti_ai_key");
            if (!apiKey) {
                throw new Error("Gemini API key is missing. Please configure it in the 'Bill Processing' tab.");
            }

            // Image Optimization: downscale to max 1600px, JPEG quality 85%.
            // No-op for PDFs or already-small images. Run AFTER the file-hash
            // cache check in the callers (which hash the original bytes), so
            // cache hits/misses are unaffected by this optimization.
            const resized = await this.resizeBase64ImageForOCR(base64Data, mimeType);
            base64Data = resized.base64;
            mimeType = resized.mimeType;

            const callOnce = async (promptText, model) => {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                // Vision (image) requests are heavier than the lightweight
                // text-only Test Connection call and can legitimately take
                // longer than 20s under real-world conditions -- 45s gives
                // real multimodal requests room to complete without
                // changing retry count, model fallback, or any other logic.
                const response = await this.fetchWithTimeout(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    { text: promptText },
                                    { inlineData: { mimeType: mimeType, data: base64Data } }
                                ]
                            }
                        ],
                        generationConfig: {
                            responseMimeType: "application/json"
                        }
                    })
                }, 45000);

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    const errMsg = errData.error?.message || `HTTP ${response.status}`;
                    const err = new Error(`Gemini Vision API error: ${errMsg}`);
                    err.httpStatus = response.status;
                    throw err;
                }

                const result = await response.json();
                const jsonText = result.candidates?.[0]?.content?.parts?.[0]?.text || "";
                return this.parseGeminiJSON(jsonText);
            };

            // Attempt plan (max 3 attempts, exponential backoff 2s / 4s):
            // the first two attempts use the primary model (gemini-2.5-flash);
            // the final attempt falls back to gemini-2.5-pro so a saturated
            // flash quota doesn't burn the last retry on the same model.
            const attemptPlan = [
                { model: "gemini-2.5-flash", waitBeforeMs: 0 },
                { model: "gemini-2.5-flash", waitBeforeMs: 2000 },
                { model: "gemini-2.5-pro", waitBeforeMs: 4000 }
            ];

            const retryLog = [];
            this._lastGeminiUsedJsonRepair = false;
            this._lastGeminiRetryLog = retryLog;

            let lastRetryableErr = null;
            let lastRetryableCode = null; // "timeout" | "quota" | "service_busy" -- tracked so the
                                           // exhausted-retry message/reason reflects what actually
                                           // happened instead of always saying "busy".

            for (let i = 0; i < attemptPlan.length; i++) {
                const { model, waitBeforeMs } = attemptPlan[i];
                if (waitBeforeMs > 0) {
                    console.log(`[Gemini OCR] Waiting ${waitBeforeMs / 1000}s before attempt ${i + 1} (${model})`);
                    if (typeof onProgress === "function") {
                        onProgress({ phase: "waiting", attempt: i + 1, total: attemptPlan.length, model, waitMs: waitBeforeMs });
                    }
                    await new Promise(r => setTimeout(r, waitBeforeMs));
                }

                if (typeof onProgress === "function") {
                    onProgress({ phase: "attempting", attempt: i + 1, total: attemptPlan.length, model });
                }

                const attemptStart = performance.now();
                try {
                    const parsed = await callOnce(prompt, model);
                    retryLog.push({ attempt: i + 1, model, status: "SUCCESS", ms: Math.round(performance.now() - attemptStart) });
                    console.log(`[Gemini OCR] Attempt ${i + 1} (${model}) SUCCESS`);
                    return parsed;
                } catch (err) {
                    const classification = this._classifyGeminiError(err);
                    err.geminiErrorCode = classification.code;
                    err.geminiErrorLabel = classification.label;

                    if (!classification.retryable) {
                        // Auth (401/403), invalid request (400), invalid/unknown
                        // model (404), and unclassified errors are genuine,
                        // non-transient failures -- retrying them wastes the
                        // finite attempt budget on something that will never
                        // succeed, and (for auth/invalid-request) could look
                        // like it's "still trying" when it's actually
                        // misconfigured. They propagate immediately.
                        retryLog.push({ attempt: i + 1, model, status: "FAILED", reason: classification.label, error: err.message, ms: Math.round(performance.now() - attemptStart) });
                        console.error(`[Gemini OCR] Attempt ${i + 1} (${model}) FAILED (non-retryable: ${classification.label}): ${err.message}`);

                        // Malformed JSON keeps its existing single stricter-prompt
                        // repair attempt -- unchanged business logic, just now
                        // tagged with a precise reason if the repair also fails.
                        if (classification.code === "invalid_json") {
                            console.warn("Gemini OCR response wasn't valid JSON, retrying ONCE with a stricter prompt:", err);
                            this._lastGeminiUsedJsonRepair = true;
                            const stricterPrompt = prompt + `

IMPORTANT: Your previous response could not be parsed as JSON. This time, respond with ONLY the raw JSON object described above -- no markdown code fences, no backticks, no explanation text before or after it, and no trailing commas.`;
                            try {
                                const parsed = await callOnce(stricterPrompt, model);
                                retryLog.push({ attempt: i + 1, model, status: "SUCCESS (json-repair)" });
                                return parsed;
                            } catch (repairErr) {
                                this._lastGeminiUsedJsonRepair = "FAIL";
                                const repairClassification = this._classifyGeminiError(repairErr);
                                repairErr.geminiErrorCode = repairClassification.code === "unknown" ? "invalid_json" : repairClassification.code;
                                repairErr.geminiErrorLabel = repairClassification.code === "unknown" ? "JSON Parse Failed" : repairClassification.label;
                                throw repairErr;
                            }
                        }
                        throw err;
                    }

                    // Retryable: timeout, quota (429), or service unavailable/
                    // overloaded (503). Same finite attempt plan as before
                    // (max 3 attempts total, flash/flash/pro) -- timeouts just
                    // now consume a slot and get a real retry instead of
                    // failing hard on attempt 1.
                    const statusLabel = classification.code === "timeout" ? "TIMEOUT" : "BUSY";
                    retryLog.push({ attempt: i + 1, model, status: statusLabel, reason: classification.label, error: err.message, ms: Math.round(performance.now() - attemptStart) });
                    console.warn(`[Gemini OCR] Attempt ${i + 1} (${model}) ${classification.label}: ${err.message}`);
                    if (typeof onProgress === "function") {
                        onProgress({ phase: classification.code === "timeout" ? "timeout" : "busy", attempt: i + 1, total: attemptPlan.length, model });
                    }
                    lastRetryableErr = err;
                    lastRetryableCode = classification.code;

                    // Quota-specific optimization: retrying the SAME model
                    // against a quota cap within a couple of seconds cannot
                    // succeed -- 429/RESOURCE_EXHAUSTED doesn't clear that
                    // fast. If the next planned attempt uses the identical
                    // model, skip it and jump straight to the next attempt
                    // that uses a different model (different models
                    // typically draw from separate quota pools -- the same
                    // reasoning the fixed attempt plan already uses for why
                    // its final attempt falls back to gemini-2.5-pro).
                    // Verified against production evidence: a quota-exceeded
                    // scan was observed taking 96.8s total, consistent with
                    // burning a full ~45s timeout on a same-model repeat that
                    // had no chance of succeeding.
                    if (classification.code === "quota") {
                        while (i + 1 < attemptPlan.length && attemptPlan[i + 1].model === model) {
                            i++;
                            retryLog.push({ attempt: i + 1, model, status: "SKIPPED", reason: "Quota Exceeded on same model -- skipped to avoid a guaranteed-futile repeat" });
                            console.warn(`[Gemini OCR] Skipping attempt ${i + 1} (${model}): same model already hit quota this run`);
                        }
                    }
                }
            }

            // All attempts in the plan were exhausted and every single one was
            // retryable (timeout and/or 429/503). Signal this distinctly
            // (isGeminiBusy) so callers show a Warning + Retry/Cancel, never a
            // Critical Alert, and never auto-switch away from the scanner --
            // but say WHICH transient condition it actually was.
            const allTimeouts = retryLog.every(r => r.status === "TIMEOUT");
            const allQuota = retryLog.filter(r => r.status !== "SKIPPED").every(r => r.reason === "Quota Exceeded");
            console.warn(`[Gemini OCR] All ${attemptPlan.length} attempts exhausted (${lastRetryableCode || "busy"}). Total: ${retryLog.reduce((s, r) => s + (r.ms || 0), 0)}ms`);
            const exhaustedMessage = allTimeouts
                ? `Gemini requests kept timing out after ${attemptPlan.length} attempts. Your image is still loaded. Please Retry in a few moments.`
                : allQuota
                ? "Gemini API quota has been exceeded. Retrying immediately will not help -- this is a plan/billing limit, not a temporary outage. Check the Gemini API quota/billing dashboard, or wait for the quota window to reset, before retrying. Your image is still loaded."
                : "Gemini Vision is temporarily busy. Your image is still loaded. Please Retry in a few moments.";
            const busyError = new Error(exhaustedMessage);
            busyError.isGeminiBusy = true;
            busyError.retryLog = retryLog;
            busyError.cause = lastRetryableErr;
            busyError.geminiErrorCode = lastRetryableCode || "service_busy";
            busyError.geminiErrorLabel = lastRetryableCode === "timeout"
                ? `Timeout (Failed after ${attemptPlan.length} attempts)`
                : (lastRetryableCode === "quota" ? "Quota Exceeded" : "Service Busy");
            throw busyError;
        }

        // ============================================================
        // FIELD VALIDATION STAGE
        // ------------------------------------------------------------
        // Sits between "Structured JSON" (Gemini's raw response) and the
        // Medicine Identity Engine in the pipeline. Two pure, side-effect
        // free functions shared by BOTH scanners -- neither one matches
        // or looks up medicines; that stays exclusively in
        // resolveMedicine() (Medicine Identity Engine), untouched here.
        // ============================================================

        // normalizeOCRResponse(parsed, type)
        // Renames/aliases Gemini's schema field names to the field names
        // the rest of the app already expects, so downstream code
        // (populateOrderBuilder, resolveMedicine, etc.) never has to know
        // about Gemini's raw JSON shape. type is "order" or "bill".
        normalizeOCRResponse(parsed, type) {
            if (type === "order") {
                // Enforce the tablet-count contract: quantity_tablets is the
                // ONLY quantity value that ever reaches the Medicine Identity
                // Engine / Inventory Verification -- never a raw strip/box count.
                const items = Array.isArray(parsed) ? parsed : (parsed && parsed.items);
                if (Array.isArray(items)) {
                    items.forEach(it => {
                        if (it.quantity_tablets !== undefined && it.quantity === undefined) {
                            it.quantity = it.quantity_tablets;
                        }
                        if (it.dosage_form !== undefined && it.form === undefined) {
                            it.form = it.dosage_form;
                        }

                        // Medicine identity fix: the extraction prompt asks
                        // Gemini for medicine_name and strength/unit as
                        // SEPARATE fields (so strength can be validated and
                        // confidence-scored on its own), but every downstream
                        // consumer -- matching (resolveMedicine), display
                        // (populateOrderBuilder), and the workflow/audit trail
                        // -- only ever reads medicine_name. Left unmerged,
                        // that silently drops the strength ("Roseday" instead
                        // of "Roseday 20 MG"), which can resolve to the wrong
                        // product entirely when a brand has multiple
                        // strengths. Fold it back in exactly once, here, so
                        // nothing downstream has to know the two were ever
                        // separate.
                        if (it.medicine_name && it.strength !== undefined && it.strength !== null && it.strength !== "") {
                            const strengthStr = String(it.strength).trim();
                            const unitStr = (it.unit || "MG").toString().trim().toUpperCase();
                            const alreadyPresent = new RegExp(`\\b${strengthStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${unitStr}\\b`, "i").test(it.medicine_name);
                            if (strengthStr && !alreadyPresent) {
                                it.medicine_name = `${it.medicine_name.trim()} ${strengthStr}${unitStr}`;
                            }
                        }
                    });
                }
                return parsed;
            }
            if (type === "bill") {
                // Same fold-back as the "order" branch above, and for the
                // same reason: the Bill prompt now asks Gemini for strength
                // as its own field (so it can be read/scored independently),
                // but every downstream consumer of a bill row -- 
                // validateOCRFields, resolveMedicine, renderExtractedItems --
                // only ever reads medicine_name. Fold strength back in here,
                // once, so medicine_name keeps its current shape/meaning and
                // nothing downstream needs to change.
                const items = Array.isArray(parsed) ? parsed : (parsed && parsed.items);
                if (Array.isArray(items)) {
                    items.forEach(it => {
                        if (it.medicine_name && it.strength !== undefined && it.strength !== null && it.strength !== "") {
                            const strengthStr = String(it.strength).trim();
                            const unitStr = (it.strength_unit || "MG").toString().trim().toUpperCase();
                            const alreadyPresent = new RegExp(`\\b${strengthStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*${unitStr}\\b`, "i").test(it.medicine_name);
                            if (strengthStr && !alreadyPresent) {
                                it.medicine_name = `${it.medicine_name.trim()} ${strengthStr}${unitStr}`;
                            }
                        }
                    });
                }
                return parsed;
            }
            // Supplier Bill: Gemini's field names already match the extraction
            // schema 1:1 -- no renaming needed, field coercion/defaulting is
            // handled per-row by validateOCRFields() instead.
            return parsed;
        }

        // validateOCRFields(item, type, fallbackSupplier)
        // Coerces/defaults a single raw Gemini row into the well-typed shape
        // the UI and Medicine Identity Engine expect (numbers parsed, blanks
        // defaulted, never throws on a missing field). type is "order" or
        // "bill".
        validateOCRFields(item, type, fallbackSupplier) {
            if (type === "bill") {
                const name = item.medicine_name || "Unknown Medicine";
                const brand = item.brand_name || item.manufacturer || this.getBrandFromName(name);
                const mrpVal = item.mrp !== undefined && item.mrp !== null && item.mrp !== "" ? parseFloat(item.mrp) : null;
                const costVal = item.purchase_rate !== undefined && item.purchase_rate !== null && item.purchase_rate !== "" ? parseFloat(item.purchase_rate)
                              : (mrpVal !== null ? mrpVal / 1.4 : null);

                return {
                    name: name.toUpperCase(),
                    supplier_name: item.supplier_name || fallbackSupplier,
                    brand_name: brand,
                    drug_name: item.drug_name || "",
                    discount_percent: item.discount_percent || "0%",
                    batch: item.batch_number || null,
                    exp: item.expiry_date || null,
                    pack: item.pack_size || null,
                    qty: item.quantity !== undefined && item.quantity !== null && item.quantity !== "" ? parseInt(item.quantity) : null,
                    free_qty: item.free_qty !== undefined && item.free_qty !== null && item.free_qty !== "" ? parseInt(item.free_qty) : 0,
                    cost: costVal,
                    mrp: mrpVal,
                    gst: item.gst_percent || "5%",
                    confidence_score: item.confidence_score !== undefined && item.confidence_score !== null ? parseInt(item.confidence_score) : null,
                    // Was being read from Gemini's response and then silently
                    // dropped here -- this object is what everything
                    // downstream (validateExtractedItem, renderExtractedItems)
                    // actually operates on, so without this line per-field
                    // confidence (specifically strength, the field this app's
                    // own "never merge different strengths" rule depends on)
                    // never reached the Manual Review gate for Bill Processing,
                    // even though Order Processing already gates on it.
                    field_confidence: item.field_confidence && typeof item.field_confidence === "object" ? item.field_confidence : null
                };
            }
            // Order Sheet rows are validated inline today via
            // normalizeOCRResponse (quantity_tablets contract) and consumed
            // directly by populateOrderBuilder / resolveMedicine.
            return item;
        }

        async parseSupplierBill(base64Data, mimeType, onProgress) {
            const prompt = `You are a medical invoice scanning AI.
This image might be tilted, rotated sideways, or upside down; please analyze the layout carefully and rotate/read the text in whatever orientation it appears.

FIRST, locate the medicine/tablet table on the invoice. Identify its Medicine, Batch, Expiry, Pack, Quantity, Rate, MRP, and GST columns. Ignore everything outside that table.

Extract these header fields ONLY:
- supplier_name: Look for supplier name at the top or headers (e.g. LPH, MUTHU, VCARE, Lifecare, MUNOT, ANGEL PHARMA, Kastoori Medicals, etc.).
- invoice_number: Invoice/Bill number.
- purchase_date: Date of invoice (formatted as YYYY-MM-DD). If missing, return null.

For each medicine/tablet row in the table, extract:
- supplier_name: supplier name (LPH, MUTHU, VCARE, etc. matching the top supplier name if not specified in the row).
- medicine_name: Exact tablet name AS PRINTED, including strength if it's part of the printed name (e.g. "USV L. ROSEDAY 20MG" or "ROS-20").
- strength: the MG/MCG/ML/etc. number ONLY (e.g. "20" not "20mg"), extracted separately from medicine_name so it can be validated on its own. Many brands are sold in multiple strengths of the exact same name (e.g. "ROSEDAY 10MG" vs "ROSEDAY 20MG" are different products) -- read every digit of the strength carefully, even if it's in a smaller font or adjoining the name with no space. Leave empty only if the row genuinely has no strength printed anywhere.
- strength_unit: MG/MCG/G/ML/IU/% (default MG).
- brand_name: Manufacturer or brand name abbreviation (e.g. "USV", "LUPIN", "CIPLA").
- drug_name: Active ingredient/chemical name of the medicine (e.g. "Rosuvastatin" for ROSEDAY, "Metformin" for GLYCOMET, "Calcium + Vitamin D3" for SUPRACAL XT, etc.). If not explicitly written on the bill, use your medical knowledge to fill this column based on the medicine name.
- batch_number: Batch number.
- expiry_date: Expiry date formatted as MM/YY (e.g. 05/27). Convert "05/2027" or "05-27" to "05/27".
- pack_size: Pack size (e.g. "10's", "15's", "1's").
- quantity: Number of packs or tablets purchased.
- free_qty: Free or bonus quantity if mentioned in the bill (e.g. "2" in a line like "10 + 2" or under a "Free/Scheme" column). If not mentioned, return 0 or null.
- discount_percent: Item level discount percentage (e.g. "6.00%" or "0.00%").
- mrp: Maximum Retail Price per pack.
- gst_percent: GST percentage (e.g. "5%" or "12%").
- purchase_rate: Purchase rate/cost price.
- confidence_score: Overall confidence (0 to 100) for this row.
- field_confidence: an object with a SEPARATE 0-100 confidence for EACH of brand_name, strength, pack_size, and quantity individually, e.g. {"brand_name": 99, "strength": 90, "pack_size": 81, "quantity": 100}.

IGNORE and do not extract into items: hospital/customer/supplier addresses, phone numbers, emails, GSTIN, CIN, PAN, IFSC, bank account details, QR codes, barcodes, invoice footer text, terms & conditions, page numbers, watermarks, signatures, the total amount line, and tax summary rows — these are not medicine rows.

Return your response in JSON format matching this schema:
{
  "supplier_name": "Supplier Name or null",
  "invoice_number": "Invoice Number or null",
  "purchase_date": "YYYY-MM-DD or null",
  "items": [
    {
      "supplier_name": "e.g. LPH, MUTHU, VCARE, or others",
      "medicine_name": "CAPITALIZED MEDICINE NAME",
      "strength": "20",
      "strength_unit": "MG",
      "brand_name": "Brand/Mfr abbreviation",
      "drug_name": "Active ingredient chemical name",
      "batch_number": "Batch No or null",
      "expiry_date": "MM/YY or null",
      "pack_size": "e.g. 15's, 10's or null",
      "quantity": 10,
      "free_qty": 2,
      "discount_percent": "6.00%",
      "purchase_rate": 69.29,
      "mrp": 90.94,
      "gst_percent": "5%",
      "confidence_score": 95,
      "field_confidence": { "brand_name": 99, "pack_size": 81, "quantity": 100 }
    }
  ]
}`;

            // Priority 3.11 production integration: same wrapper as
            // parseOrderSheet -- preprocess, then automatic provider
            // selection (Gemini primary, local Tesseract fallback only on
            // quota/timeout/service-busy/offline). Caller (below) applies
            // validateOCRFields/normalizeOCRResponse to the returned JSON
            // exactly as it always has, regardless of which provider
            // produced it.
            const _preStart = performance.now();
            const preprocessed = await this.preprocessImageForOCR(base64Data, mimeType, {
                autoRotate: true,
                deskew: true,
                autoCrop: true,
                normalizeBrightness: true,
                denoise: true,
                contrast: true,
                sharpen: true,
                adaptiveThreshold: false
            });
            const preprocessingMs = Math.round(performance.now() - _preStart);

            const result = await this.recognizeWithProviderFallback(
                preprocessed.base64, preprocessed.mimeType, prompt, onProgress, "bill", null, preprocessingMs
            );
            return result.text;
        }

        // File-hash-based OCR cache (Phase 8): rescanning the exact same bill
        // image should be instant instead of re-calling the OCR API. Cache
        // is keyed by a SHA-256 hash of the raw image bytes (base64), so a
        // byte-identical re-upload always hits, regardless of filename.
        async computeFileHash(base64Data) {
            try {
                const bytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
                const digest = await crypto.subtle.digest("SHA-256", bytes);
                return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
            } catch (e) {
                return null; // hashing unavailable -- caller falls back to no-cache
            }
        }
        getOcrCache() { return JSON.parse(localStorage.getItem("ti_ocr_cache") || "{}"); }
        setOcrCache(data) { return this._safeSetItem("ti_ocr_cache", JSON.stringify(data), "OCR", "OCR Cache"); }

        // Separate cache namespace for Order Sheet scans (distinct shape --
        // { items: [...] } -- from the Supplier Bill cache above, so the two
        // never collide even if a file were byte-identical by coincidence).
        // Capped at the most recent 30 entries so localStorage can't grow
        // unbounded from a busy day of scanning.
        getOrderOcrCache() { return JSON.parse(localStorage.getItem("ti_order_ocr_cache") || "{}"); }
        setOrderOcrCache(data) {
            const keys = Object.keys(data);
            if (keys.length > 30) {
                keys.sort((a, b) => new Date(data[a].cachedOn || 0) - new Date(data[b].cachedOn || 0));
                for (let i = 0; i < keys.length - 30; i++) delete data[keys[i]];
            }
            return this._safeSetItem("ti_order_ocr_cache", JSON.stringify(data), "OCR", "Order Sheet OCR Cache");
        }

        // Duplicate-request guard (Bug #4): a double-click (or the user
        // re-uploading before the first scan finished) used to fire a second,
        // fully redundant OCR/API call in parallel with the first. This thin
        // wrapper makes sure only one Supplier Bill OCR scan runs at a time --
        // the real work is unchanged, still in _runStagedOCRScanInner below.
        async runStagedOCRScan(base64Data, mimeType, fileName) {
            if (this._billOcrInFlight) {
                this.showToast("A bill scan is already in progress — please wait for it to finish.", "info");
                return;
            }
            this._billOcrInFlight = true;
            try {
                return await this._runStagedOCRScanInner(base64Data, mimeType, fileName);
            } finally {
                this._billOcrInFlight = false;
            }
        }

        async _runStagedOCRScanInner(base64Data, mimeType, fileName) {
            this.bumpOcrStat("supplierBillsUploaded");
            this.bumpOcrStat("pendingFiles", 1);
            const _cloudImageUploadPromise = this._uploadBillImageToCloud(base64Data, mimeType, fileName, "supplier_bill").catch(() => null);
            const ocrProgress = document.getElementById("ocr-progress");
            const ocrStatusText = document.getElementById("ocr-status-text");
            const ocrStatus = document.getElementById("ocr-status-container");
            const lensHelper = document.getElementById("lens-helper-panel");

            if (ocrStatus) ocrStatus.classList.remove("hidden");
            if (ocrProgress) ocrProgress.style.width = "10%";
            if (ocrStatusText) ocrStatusText.textContent = "Scanning Purchase Bill... (Initializing)";

            const _pipelineStart = performance.now();
            const _imageLoadMs = this._lastOcrImageLoadMs || 0;

            // Check the OCR cache first -- if this exact image was scanned
            // before, reuse the result instantly instead of calling the API.
            const fileHash = await this.computeFileHash(base64Data);
            if (fileHash) {
                const cache = this.getOcrCache();
                const cached = cache[fileHash];
                if (cached) {
                    if (ocrProgress) ocrProgress.style.width = "100%";
                    if (ocrStatusText) ocrStatusText.textContent = "Loaded from cache (identical file scanned previously)...";
                    this.renderExtractedItems(cached.items, cached.supplier, cached.invoiceNo, cached.invoiceDate);
                    document.getElementById("extracted-invoice-details").classList.remove("hidden");
                    if (ocrStatus) ocrStatus.classList.add("hidden");
                    if (lensHelper) lensHelper.classList.add("hidden");
                    this.showToast("This exact bill was scanned before — loaded instantly from cache.", "success");
                    return;
                }
            }

            const nameLower = (fileName || "").toLowerCase();
            // Fast path for the built-in offline demo templates -- gated
            // behind an explicit opt-in flag (set only when intentionally
            // testing with the bundled sample images), NOT filename
            // sniffing. Root cause this fixes: the numeric match strings
            // here (e.g. "1782029421019") are 13-digit values in the same
            // format Android/WhatsApp uses for auto-generated photo
            // filenames -- a real supplier invoice photo could coincidentally
            // match one and silently get replaced with canned demo data
            // instead of actually running OCR on it. That failure is worse
            // than a visible error because nothing looks wrong.
            const _demoTemplatesEnabled = localStorage.getItem("ti_enable_demo_ocr_templates") === "1";
            if (_demoTemplatesEnabled && (nameLower.includes("26kk404") || nameLower.includes("1781937") || nameLower.includes("1781945"))) {
                if (ocrStatus) ocrStatus.classList.add("hidden");
                this.showOCRResultsKastoori();
                return;
            }
            if (_demoTemplatesEnabled && (nameLower.includes("26kk405") || nameLower.includes("1782029421019") || nameLower.includes("1782029421030"))) {
                if (ocrStatus) ocrStatus.classList.add("hidden");
                this.showOCRResultsKastoori405();
                return;
            }
            if (_demoTemplatesEnabled && (nameLower.includes("26kk398") || nameLower.includes("1782029421043") || nameLower.includes("1782029421050"))) {
                if (ocrStatus) ocrStatus.classList.add("hidden");
                this.showOCRResultsKastoori398();
                return;
            }
            if (_demoTemplatesEnabled && (nameLower.includes("26kk401") || nameLower.includes("1782029421230"))) {
                if (ocrStatus) ocrStatus.classList.add("hidden");
                this.showOCRResultsKastoori401();
                return;
            }

            // --- Lean pipeline ---
            // Image Optimization -> ONE Gemini Vision request -> Strict JSON
            // Validation (inside runSharedGeminiVisionOCR, including its one
            // retry-on-invalid-JSON) -> Normalize Fields -> Medicine Identity
            // Engine (via renderExtractedItems / the existing import workflow).
            // No local OCR, no regex parser, no second/different AI engine.
            const diag = { geminiStatus: "SKIPPED", jsonRepair: "N/A", imageLoadMs: _imageLoadMs };
            const _geminiStart = performance.now();
            let validatedData = null;
            try {
                if (ocrProgress) ocrProgress.style.width = "30%";
                if (ocrStatusText) ocrStatusText.textContent = "AI OCR processing purchase bill...";

                validatedData = await this.parseSupplierBill(base64Data, mimeType, (progress) => {
                    if (!ocrStatusText) return;
                    if (progress.phase === "attempting" && progress.attempt === 1) {
                        ocrStatusText.textContent = "AI OCR processing purchase bill...";
                    } else if (progress.phase === "waiting" || progress.phase === "busy") {
                        ocrStatusText.textContent = `Gemini is busy. Retrying... Attempt ${progress.attempt} of ${progress.total}`;
                    } else if (progress.phase === "timeout") {
                        ocrStatusText.textContent = `Request timed out. Retrying... Attempt ${progress.attempt} of ${progress.total}`;
                    } else if (progress.phase === "attempting") {
                        ocrStatusText.textContent = `Attempt ${progress.attempt} of ${progress.total} (${progress.model})...`;
                    }
                });
                validatedData = this.normalizeOCRResponse(validatedData, "bill");
                diag.geminiStatus = "PASS";
                diag.jsonRepair = this._lastGeminiUsedJsonRepair ? "PASS (retried)" : "N/A";
            } catch (err) {
                diag.resizeMs = this._lastOcrResizeMs || 0;
                diag.ocrTimeMs = Math.round(performance.now() - _geminiStart);
                diag.geminiStatus = err.geminiErrorLabel || (err.isGeminiBusy ? "Service Busy" : "OCR Extraction Failed");
                diag.jsonRepair = this._lastGeminiUsedJsonRepair ? "FAIL" : "N/A";
                diag.matched = 0;
                diag.totalTimeMs = Math.round(performance.now() - _pipelineStart);
                if (err.retryLog && err.retryLog.length) {
                    diag.retryLog = err.retryLog;
                    console.log("[Gemini OCR] Retry diagnostics:\n" + err.retryLog.map(r => `  Attempt ${r.attempt} (${r.model}): ${r.status}`).join("\n"));
                }
                this.renderOcrDiagnostics(diag, "scanner-visualizer-box", "bill-ocr-diagnostics");
                // Log the EXACT reason, never a generic error.
                console.error("Supplier Bill AI OCR failed (single-request pipeline, no automatic fallback):", err.message, err);
                this.bumpOcrStat("ocrFailed");
                this.bumpOcrStat("pendingFiles", -1);
                _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "failed"));

                if (ocrStatus) ocrStatus.classList.add("hidden");
                const badge = document.getElementById("ocr-badge-status");
                if (badge) {
                    badge.className = "status-badge badge-error";
                    badge.textContent = "Scan Failed";
                }
                this.showToast("OCR failed. Please try another image.", "error");
                this.triggerNotification(
                    "OCR", "Supplier bill validation failure",
                    `🔴 Supplier Bill Validation Failure\nFile: ${fileName || "unknown"}\nError: ${err.message}\nGemini Vision request failed (and its one JSON-repair retry, if triggered). Please try another image, or use "Paste Text Bill (Backup)".`,
                    "Critical", { errorDetails: err.message, stackTrace: err.stack }
                );
                return;
            }
            diag.resizeMs = this._lastOcrResizeMs || 0;
            diag.geminiRequestMs = Math.round(performance.now() - _geminiStart) - diag.resizeMs;
            diag.ocrTimeMs = Math.round(performance.now() - _geminiStart);
            console.log(`[Timing] Gemini OCR (supplier bill): ${diag.ocrTimeMs}ms`);

            const supplier = validatedData.supplier_name || "Extracted Supplier";
            const invoiceNo = validatedData.invoice_number || "OCR-" + Math.floor(Math.random() * 90000 + 10000);
            const invoiceDate = validatedData.purchase_date || new Date().toISOString().split('T')[0];

            const items = (validatedData.items || []).map(item => this.validateOCRFields(item, "bill", supplier));

            if (ocrStatus) ocrStatus.classList.add("hidden");
            if (lensHelper) lensHelper.classList.add("hidden");

            // Gemini succeeded but returned zero rows -- no local fallback
            // chain anymore; surface it plainly instead of guessing.
            if (items.length === 0) {
                diag.matched = 0;
                diag.totalTimeMs = Math.round(performance.now() - _pipelineStart);
                this.renderOcrDiagnostics(diag, "scanner-visualizer-box", "bill-ocr-diagnostics");
                this.showEmptyOCRResults(fileName, "OCR finished, but Gemini returned zero medicine rows for this image.");
                this.bumpOcrStat("ocrFailed");
                this.bumpOcrStat("pendingFiles", -1);
                _cloudImageUploadPromise.then(id => this._markCloudImageOcrStatus(id, "failed"));
                return;
            }

            if (ocrProgress) ocrProgress.style.width = "100%";
            this.renderExtractedItems(items, supplier, invoiceNo, invoiceDate);
            document.getElementById("extracted-invoice-details").classList.remove("hidden");

            if (fileHash) {
                const cache = this.getOcrCache();
                cache[fileHash] = { items, supplier, invoiceNo, invoiceDate, cachedOn: new Date().toISOString() };
                this.setOcrCache(cache);
            }

            diag.matched = items.length;
            diag.totalTimeMs = Math.round(performance.now() - _pipelineStart);
            this.renderOcrDiagnostics(diag, "scanner-visualizer-box", "bill-ocr-diagnostics");
            this.bumpOcrStat("ocrSuccess");
            this.bumpOcrStat("pendingFiles", -1);
            this.bumpOcrStat("medicinesExtracted", items.length);
            this.recordOcrTiming(diag.totalTimeMs);
            _cloudImageUploadPromise.then(imageId => {
                this._markCloudImageOcrStatus(imageId, "success");
                if (supabaseClient) {
                    supabaseClient.from("supplier_bills").upsert({
                        invoice_number: invoiceNo,
                        invoice_date: invoiceDate,
                        supplier_name: supplier,
                        uploaded_by: this.currentUser ? this.currentUser.name : "System",
                        image_id: imageId,
                        total_items: items.length,
                        ocr_confidence: validatedData.confidence_score != null ? validatedData.confidence_score : null
                    }, { onConflict: "invoice_number,supplier_name,invoice_date" })
                      .then(({ error }) => { if (error) console.warn("supplier_bills upsert skipped (run migration 06):", error.message); });
                }
            });
            console.log(
                `[OCR]\n` +
                `  Image Loaded:        ${diag.imageLoadMs}ms\n` +
                `  Image Resize:        ${diag.resizeMs}ms\n` +
                `  Gemini Request:      ${(diag.geminiRequestMs / 1000).toFixed(1)}s\n` +
                `  JSON Repair:         ${diag.jsonRepair === "PASS (retried)" ? "retried" : "0"}ms\n` +
                `  Items Returned:      ${items.length}\n` +
                `  TOTAL:               ${(diag.totalTimeMs / 1000).toFixed(1)}s`
            );

            // OCR confidence below threshold check
            const _overallConf = validatedData.confidence_score;
            if (_overallConf === undefined || _overallConf === null || _overallConf < 90) {
                this.triggerNotification(
                    "OCR", "OCR confidence below threshold",
                    `🟠 Low OCR Confidence\nOverall confidence: ${_overallConf !== undefined && _overallConf !== null ? _overallConf + "%" : "Unknown"}\nInvoice: ${invoiceNo || "unknown"}\nSome text may be misread. Please review all extracted values carefully.`,
                    "Warning", { invoiceNo: invoiceNo, ocrConfidence: _overallConf }
                );
            }
            // High-value checks on OCR output
            items.forEach(ocr_itm => {
                this.checkHighValueMedicineAlert(ocr_itm.name, ocr_itm.qty + " units", "OCR", invoiceNo);
            });

            const statusBadge = document.getElementById("ocr-badge-status");
            if (statusBadge) {
                statusBadge.className = "status-badge badge-success";
                statusBadge.textContent = "AI OCR Scanned";
            }
            this.showToast(`Successfully extracted ${items.length} bill item(s)!`, "success");
        }

        parseExpiryDate(expStr) {
            if (!expStr) return new Date(2099, 11, 31);
            
            const cleanStr = expStr.trim().replace(/[\-\.\s]/g, '/');
            const parts = cleanStr.split('/');
            
            if (parts.length !== 2) {
                return new Date(2099, 11, 31);
            }
            
            let month = parseInt(parts[0], 10);
            let year = parseInt(parts[1], 10);
            
            if (isNaN(month) || isNaN(year)) {
                return new Date(2099, 11, 31);
            }
            
            if (year < 100) {
                year += 2000;
            }
            
            return new Date(year, month, 0, 23, 59, 59);
        }

        checkExpiries() {
            const tablets = this.getTablets();
            const today = new Date();
            
            let countExpired = 0;
            let count90 = 0;
            let count180 = 0;
            let alertCount = 0;
            
            tablets.forEach(t => {
                const batches = t.batches || [];
                batches.forEach(b => {
                    if (b.quantity <= 0) return;
                    
                    const expDate = this.parseExpiryDate(b.expiryDate);
                    const diffTime = expDate - today;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    
                    if (diffDays < 0) {
                        countExpired++;
                        alertCount++;
                    } else if (diffDays < 90) {
                        count90++;
                        alertCount++;
                    } else if (diffDays < 180) {
                        count180++;
                    }
                });
            });
            
            const kpiExpired = document.getElementById("kpi-count-expired");
            const kpi90 = document.getElementById("kpi-count-expiring-90");
            const kpi180 = document.getElementById("kpi-count-expiring-180");
            
            if (kpiExpired) kpiExpired.textContent = countExpired;
            if (kpi90) kpi90.textContent = count90;
            if (kpi180) kpi180.textContent = count180;
            
            const badgeSidebar = document.getElementById("expiry-badge-sidebar");
            if (badgeSidebar) {
                badgeSidebar.textContent = alertCount;
                if (alertCount > 0) {
                    badgeSidebar.classList.add("active");
                } else {
                    badgeSidebar.classList.remove("active");
                }
            }
        }

        renderExpiryPage() {
            const tableBody = document.getElementById("expiry-table-body");
            if (!tableBody) return;

            tableBody.innerHTML = "";
            const tablets = this.getTablets();
            const today = new Date();
            
            const filterRadio = document.querySelector('input[name="expiry-filter"]:checked');
            const filterVal = filterRadio ? filterRadio.value : "ALL";
            
            const rows = [];
            
            tablets.forEach(t => {
                const batches = t.batches || [];
                batches.forEach(b => {
                    if (b.quantity <= 0) return;
                    
                    const expDate = this.parseExpiryDate(b.expiryDate);
                    const diffTime = expDate - today;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    
                    let status = "Healthy";
                    let badgeClass = "badge-success";
                    let rowGlowClass = "";
                    
                    if (diffDays < 0) {
                        status = "Expired";
                        badgeClass = "badge-error";
                        rowGlowClass = "expired-red-glow";
                    } else if (diffDays < 90) {
                        status = "Expiring < 90 Days";
                        badgeClass = "badge-warning";
                        rowGlowClass = "expiring-orange-glow";
                    } else if (diffDays < 180) {
                        status = "Expiring < 180 Days";
                        badgeClass = "badge-yellow";
                        rowGlowClass = "expiring-yellow-glow";
                    }
                    
                    let include = false;
                    if (filterVal === "ALL") {
                        include = true;
                    } else if (filterVal === "EXPIRED" && diffDays < 0) {
                        include = true;
                    } else if (filterVal === "90" && diffDays >= 0 && diffDays < 90) {
                        include = true;
                    } else if (filterVal === "180" && diffDays >= 0 && diffDays < 180) {
                        include = true;
                    }
                    
                    if (include) {
                        rows.push({
                            code: t.code,
                            name: t.name,
                            batchNumber: b.batchNumber,
                            expiryDate: b.expiryDate,
                            quantity: b.quantity,
                            diffDays: diffDays,
                            status: status,
                            badgeClass: badgeClass,
                            rowGlowClass: rowGlowClass
                        });
                    }
                });
            });
            
            rows.sort((a, b) => a.diffDays - b.diffDays);
            
            if (rows.length === 0) {
                tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No batches match the selected expiry filter.</td></tr>`;
                return;
            }
            
            rows.forEach(row => {
                const tr = document.createElement("tr");
                if (row.rowGlowClass) {
                    tr.className = row.rowGlowClass;
                }
                
                const daysText = row.diffDays < 0 
                    ? `<span class="text-danger font-weight-700">Expired (${Math.abs(row.diffDays)} days ago)</span>`
                    : `<span>${row.diffDays} days</span>`;
                
                tr.innerHTML = `
                    <td>${row.name}</td>
                    <td><code>${row.batchNumber}</code></td>
                    <td>${row.expiryDate}</td>
                    <td>${(() => {
                        const t = row.code ? this.getTabletByCode(row.code) : this.getTablets().find(tab => tab.name === row.name);
                        return this.fmtStock(row.quantity, t ? (t.tabsPerStrip || 10) : 10, t ? t.category : 'Tablets & Capsules');
                    })()}</td>
                    <td>${daysText}</td>
                    <td><span class="status-badge ${row.badgeClass}">${row.status}</span></td>
                `;
                tableBody.appendChild(tr);
            });
        }

        exportExpiriesToCSV() {
            const tablets = this.getTablets();
            const today = new Date();
            
            let csv = "Medicine Code,Medicine Name,Batch Number,Expiry Date,No. of Tablets,Days to Expiry,Status\n";
            
            const rows = [];
            
            tablets.forEach(t => {
                const batches = t.batches || [];
                batches.forEach(b => {
                    if (b.quantity <= 0) return;
                    
                    const expDate = this.parseExpiryDate(b.expiryDate);
                    const diffTime = expDate - today;
                    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                    
                    let status = "Healthy";
                    if (diffDays < 0) {
                        status = "Expired";
                    } else if (diffDays < 90) {
                        status = "Expiring < 90 Days";
                    } else if (diffDays < 180) {
                        status = "Expiring < 180 Days";
                    }
                    
                    rows.push({
                        code: t.code,
                        name: t.name,
                        batchNumber: b.batchNumber,
                        expiryDate: b.expiryDate,
                        quantity: b.quantity,
                        diffDays: diffDays,
                        status: status
                    });
                });
            });
            
            rows.sort((a, b) => a.diffDays - b.diffDays);
            
            rows.forEach(r => {
                csv += `"${r.code}","${r.name}","${r.batchNumber}","${r.expiryDate}",${r.quantity},${r.diffDays},"${r.status}"\n`;
            });
            
            this.downloadCSV(csv, "Expiry_Report.csv");
            this.showToast("Expiry report CSV downloaded.");
        }

        calculateLocalConfidence(item) {
            let score = 95;
            const tablets = this.getTablets();
            const match = this.resolveMedicine(item.name, null, tablets).tablet;
            if (!match) {
                score -= 10;
            }
            if (item.name.length < 4 || !this.isLikelyMedicineName(item.name)) {
                score -= 30;
            }
            if (item.batch === null || item.batch === undefined || item.batch === "") {
                score -= 15;
            }
            if (item.exp === null || item.exp === undefined || item.exp === "") {
                score -= 15;
            }
            if (item.qty === null || item.qty === undefined || isNaN(item.qty)) {
                score -= 20;
            }
            if (item.mrp === null || item.mrp === undefined || isNaN(item.mrp)) {
                score -= 20;
            }
            return Math.max(30, score);
        }

        isLikelyMedicineName(name) {
            const cleanName = (name || "").trim().toUpperCase();
            if (cleanName.length < 4) return false;

            // Rejection keywords (invoice terms, tax terms, bank terms, etc.)
            const rejectKeywords = [
                "GST", "CGST", "SGST", "IGST", "HSN", "SAC", "TAX", "TOTAL", "AMOUNT", 
                "RUPEES", "ROUND", "DISCOUNT", "DISC", "SCHEME", "RATE", "MRP", "QTY", 
                "BATCH", "EXPIRY", "DATE", "INVOICE", "BILL", "SUPPLIER", "CUSTOMER", 
                "PATIENT", "DOCTOR", "ADDRESS", "PHONE", "MOBILE", "EMAIL", "WEBSITE", 
                "PAGE", "S.NO", "SR.NO", "CASH", "CREDIT", "NET", "SUBTOTAL", "MFR", 
                "DESCRIPTION", "TAXABLE", "E.&O.E", "GRAND TOTAL", "TAX SUMMARY", "SGST AMT", "CGST AMT",
                "GSTIN"
            ];
            
            const containsReject = rejectKeywords.some(kw => {
                const regex = new RegExp(`\\b${kw}\\b`);
                return regex.test(cleanName);
            });
            if (containsReject) return false;

            // Split into words
            const words = cleanName.split(/[\s\-\.\/\+]+/);
            
            // Check for specific hardcoded junk words as substrings
            const knownJunkWords = ["RFXGS", "CEEIEE", "MR.W", "ABCD", "XYZ"];
            const containsKnownJunk = knownJunkWords.some(junk => cleanName.includes(junk));
            if (containsKnownJunk) return false;

            // Check for words of length >= 4 that are completely consonants (junk letters)
            const hasJunkConsonantWord = words.some(w => {
                return w.length >= 4 && !/[AEIOUY]/.test(w) && /^[A-Z]+$/.test(w);
            });
            if (hasJunkConsonantWord) return false;

            // Validate against common pharmaceutical naming patterns
            // Pattern 1: Direct match with preloaded medicines in database
            const tablets = this.getTablets();
            const directDbMatch = tablets.some(t => {
                const tName = t.name.toUpperCase();
                return cleanName.includes(tName) || tName.includes(cleanName);
            });
            if (directDbMatch) return true;

            // Pattern 2: Has standard dosage form indicator
            const dosageForms = [
                "GEL", "POWDER", "TAB", "TABS", "TABLET", "TABLETS", "CAP", "CAPS", 
                "CAPSULE", "CAPSULES", "OINTMENT", "OINTMENTS", "CREAM", "CREAMS", "DROP", "DROPS", 
                "SYRUP", "SYP", "INJ", "INJECTION", "INJECTIONS", "SUSP", "SUSPENSION", 
                "SOLN", "SOLUTION", "LOTION", "SPRAY", "SPRAYS", "SPARSE",
                "INHALER", "INHALERS", "ROTOCAP", "ROTOCAPS", "RESPULE", "RESPULES", "REPULSE", "REPULES",
                "PEN", "PENS", "SOAP", "SOAPS", "WASH", "SUNSCREEN"
            ];
            const hasDosageForm = words.some(w => dosageForms.includes(w));
            if (hasDosageForm) return true;

            // Pattern 3: Has strength indicator (e.g. 10MG, 12GM, 0.5)
            const hasStrength = words.some(w => {
                return /^\d+(\.\d+)?(MG|GM|ML|CAP|TAB|IU|%|S)?$/i.test(w) || 
                       /^\d+(\.\d+)?$/i.test(w); // e.g. GP 0.5
            });
            if (hasStrength) return true;

            // Pattern 4: Has common brand/manufacturer prefixes
            const brandWords = [
                "USV", "LUPIN", "PHAR", "GRAN", "REDD", "UNJOINT", "AVEN", "SUN", 
                "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", "GLEN", 
                "MICR", "ALLE", "NOVA", "ANGL", "GERM", "SUNW", "LINK", "CIPLA", 
                "MSD", "RANB", "MANO", "CADILA", "ABBOTT", "ALKEM", "TORRENT", 
                "ZYDUS", "SANOFI", "GLAXO", "GSK", "PFIZER", "DR.REDDY", "DR.REDDY'S", 
                "LUPIN", "SUN PHARMA"
            ];
            const hasBrandPrefix = brandWords.some(b => words.includes(b) || cleanName.startsWith(b));
            if (hasBrandPrefix) return true;

            // Pattern 5: Check if the word is pronounceable (mix of vowels and consonants)
            const longestWord = words.reduce((a, b) => a.length > b.length ? a : b, "");
            if (longestWord.length >= 4) {
                const vowels = (longestWord.match(/[AEIOUY]/g) || []).length;
                const consonants = longestWord.length - vowels;
                
                if (vowels === 0 || consonants === 0) {
                    return false;
                }
                
                const vowelRatio = vowels / longestWord.length;
                if (vowelRatio >= 0.15 && vowelRatio <= 0.85) {
                    return true;
                }
            }

            return false;
        }

        detectCategoryFromName(name, pack = "") {
            const cleanName = (name || "").trim().toUpperCase();
            const cleanPack = (pack || "").trim().toUpperCase();
            // Injection/vial packaging cues (e.g. "5 x 10 ml", "Pack of 5")
            // often live in the PACK field rather than the product name --
            // real-world brand names like "Novamix" or "Insulin" don't say
            // "injection" anywhere. Checking name+pack together lets those
            // cues be picked up either way, without changing anything for
            // records where the name alone was already enough.
            const combined = (cleanName + " " + cleanPack).trim();

            // 1. Rotacaps
            if (combined.includes("ROTACAP") || combined.includes("ROTA CAP")) {
                return "Rotacaps";
            }

            // 2. Inhalers
            if (/\b(MD|MDI|INHALER|INHALERS|DPI)\b/.test(combined) || combined.includes("METERED DOSE INHALER")) {
                return "Inhalers";
            }

            // 3. Respules (Nebules) - explicit keyword only. The ambiguous
            // "N x M ml" numeric pattern (shared with injection vial packs,
            // e.g. "5 x 10 ml") is checked further down as rule 5b, AFTER
            // the explicit Injection/Vial/Ampoule keyword check in rule 5 --
            // so a genuine injection is never misclassified as a Respule
            // just because its pack has the same "number x number ml" shape.
            if (/\b(RESPULE|RESPULES|NEBULE|NEBULES)\b/.test(combined) ||
                combined.includes("UNIT DOSE NEBULIZER")) {
                return "Respules";
            }

            // 4. Syrups & Oral Solutions
            if (/\b(SYRUP|SYP|ORAL\s+SOL|ORAL\s+SOLUTION|SUSPENSION|SUSP|SUS|ORAL\s+LIQUID|PEDIATRIC\s+SYRUP)\b/.test(combined)) {
                return "Syrups & Oral Solutions";
            }

            // 5. Injections - explicit keywords take priority over the
            // generic "N x M ml" numeric pattern (rule 5b below).
            if (/\b(INJECTION|INJECTIONS|INJ|IV|IM|AMPOULE|AMPOULES|VIAL|VIALS|SYRINGE|SYRINGES)\b/.test(combined)) {
                return "Injections";
            }

            // 5b. Fallback Respule signal: a bare "N x M ml" pattern with no
            // explicit Injection/Vial/Ampoule/Syringe wording anywhere in
            // the name or pack (moved here from rule 3 -- see note above).
            if (/\b\d+(\.\d+)?\s*[X×*]\s*\d+(\.\d+)?\s*(ML|M.L.)\b/.test(combined)) {
                return "Respules";
            }

            // 6. Drops
            if (combined.includes("DROP") || combined.includes("DROPS")) {
                return "Drops";
            }

            // 7. Sprays
            if (combined.includes("SPRAY") || combined.includes("SPRAYS")) {
                return "Sprays";
            }

            // 8. Creams / Gels / Ointments
            if (/\b(CREAM|CREAMS|OINTMENT|OINT|OINTS|GEL|GELS|LOTION|LOTIONS)\b/.test(combined)) {
                return "Creams / Gels / Ointments";
            }

            // 9. Powders
            if (/\b(POWDER|POWDERS|SACHET|SACHETS|GRANULES|ORAL\s+POWDER)\b/.test(combined)) {
                return "Powders";
            }

            // 10. Tablets & Capsules
            if (/\b(TAB|TABLET|TABLETS|TABS|CAP|CAPSULE|CAPSULES|CAPS)\b/.test(cleanName) || 
                /\b\d+(\.\d+)?\s*(MG|G|MCG)\b/.test(cleanName) || 
                /\b\d+\s*S\b/.test(cleanName)) {
                return "Tablets & Capsules";
            }

            // 11. Others (default fallback and custom other keywords)
            const othersKeywords = ["FACE WASH", "SUNSCREEN", "SOAP", "SHAMPOO", "MOISTURIZER", "COSMETICS", "SKIN CARE"];
            if (othersKeywords.some(kw => cleanName.includes(kw))) {
                return "Others";
            }

            return "Tablets & Capsules";
        }

        validateExtractedItem(item) {
            const name = (item.name || "").trim().toUpperCase();
            
            if (!this.isLikelyMedicineName(name)) {
                return "rejected";
            }
            
            // Validation rules (if failed, move to manual_review)
            const expRegex = /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/;
            const isValidExp = item.exp !== null && item.exp !== undefined && expRegex.test((item.exp || "").trim());
            
            const isNumericQty = item.qty !== null && item.qty !== undefined && !isNaN(item.qty) && Number.isInteger(Number(item.qty)) && Number(item.qty) > 0;
            
            const isValidMrp = item.mrp !== null && item.mrp !== undefined && !isNaN(item.mrp) && parseFloat(item.mrp) > 0;
            
            const isValidBatch = item.batch !== null && item.batch !== undefined && (item.batch || "").trim().length > 0 && /[a-zA-Z0-9]/.test(item.batch);
            
            if (!isValidExp || !isNumericQty || !isValidMrp || !isValidBatch) {
                const currentConf = item.confidence_score !== undefined && item.confidence_score !== null && !isNaN(parseInt(item.confidence_score)) ? parseInt(item.confidence_score) : 0;
                item.confidence_score = Math.min(currentConf, 75);
                if (!isValidBatch) {
                    this.triggerNotification("Bill Processing", "Batch number missing",
                        "Batch Number Missing\nMedicine: " + name + "\nA batch number is required before stock-in.",
                        "Warning", { medicineName: name });
                }
                if (!isValidExp) {
                    this.triggerNotification("Bill Processing", "Expiry date missing",
                        "Expiry Date Missing or Invalid\nMedicine: " + name + "\nValue: " + (item.exp || "—") + "\nFormat must be MM/YY or MM/YYYY.",
                        "Warning", { medicineName: name });
                }
                return "manual_review";
            }

            const tablets = this.getTablets();
            const match = this.resolveMedicine(name, null, tablets).tablet;
            const matchScore = match ? match.matchScore : 0;

            // Strength-specific gate (mirrors the same check already applied
            // to Order Processing rows in verifyStockItemsResolved()): a
            // low-confidence STRENGTH reading is a direct risk of merging two
            // different products (e.g. ROSEDAY 10 vs ROSEDAY 20), so it forces
            // manual_review independent of the overall confidence_score,
            // which could still be high if every other field was clear.
            const fieldConf = item.field_confidence;
            if (fieldConf && typeof fieldConf === "object" && fieldConf.strength !== undefined && fieldConf.strength < 80) {
                const currentConf = item.confidence_score !== undefined && item.confidence_score !== null && !isNaN(parseInt(item.confidence_score)) ? parseInt(item.confidence_score) : 0;
                item.confidence_score = Math.min(currentConf, 89);
                this.triggerNotification("Bill Processing", "Low confidence on Strength",
                    "Low OCR Confidence on Strength\nMedicine: " + name + "\nPlease verify the strength before this is added to inventory.",
                    "Warning", { medicineName: name });
                return "manual_review";
            }

            const initialConf = item.confidence_score !== undefined && item.confidence_score !== null && !isNaN(parseInt(item.confidence_score)) ? parseInt(item.confidence_score) : 0;
            let combinedConf = Math.min(initialConf, matchScore);
            item.confidence_score = combinedConf;

            // Confidence tiers: >= 90 can continue only after structure and
            // Master Data matching pass. Anything lower, including unknown
            // confidence promoted to 0 above, requires Manual Review.
            if (combinedConf < 90) {
                return "manual_review";
            }
            if (combinedConf <= 95) {
                return "warning";
            }

            return "valid";
        }

        bindExtractedRowEvents(row) {
            const inputs = row.querySelectorAll("input");
            inputs.forEach(input => {
                input.addEventListener("input", (e) => {
                    const isNameInput = e.target.classList.contains("edit-item-name");
                    this.revalidateExtractedRow(row, isNameInput);
                });
            });

            const codeSelect = row.querySelector(".edit-item-code");
            if (codeSelect) {
                codeSelect.addEventListener("change", () => {
                    const codeVal = codeSelect.value;
                    if (codeVal) {
                        const tablets = this.getTablets();
                        const tab = tablets.find(t => t.code === codeVal);
                        if (tab && row.querySelector(".edit-item-name")) {
                            row.querySelector(".edit-item-name").value = tab.name;
                        }
                    }
                    this.revalidateExtractedRow(row, false);
                });
            }
        }

        revalidateExtractedRow(row, syncCodeFromName = false) {
            const supplierInput = row.querySelector(".edit-item-supplier");
            const billdateInput = row.querySelector(".edit-item-billdate");
            const nameInput = row.querySelector(".edit-item-name");
            const brandInput = row.querySelector(".edit-item-brand");
            const drugInput = row.querySelector(".edit-item-drug");
            const batchInput = row.querySelector(".edit-item-batch");
            const expInput = row.querySelector(".edit-item-exp");
            const packInput = row.querySelector(".edit-item-pack");
            const qtyInput = row.querySelector(".edit-item-qty");
            const discountInput = row.querySelector(".edit-item-discount");
            const costInput = row.querySelector(".edit-item-cost");
            const mrpInput = row.querySelector(".edit-item-mrp");
            const gstInput = row.querySelector(".edit-item-gst");
            const statusCell = row.querySelector(".status-cell");

            if (!nameInput) return;

            const name = nameInput.value.trim();

            // Sync Name input -> Code select box ONLY if requested
            const codeSelect = row.querySelector(".edit-item-code");
            if (codeSelect && syncCodeFromName) {
                const tablets = this.getTablets();
                const match = this.resolveMedicine(name, null, tablets).tablet;
                if (match) {
                    codeSelect.value = match.code;
                } else {
                    codeSelect.value = this.generateProductCode(name);
                }
            }
            const supplier_name = supplierInput ? supplierInput.value.trim() : "";
            const bill_date = billdateInput ? billdateInput.value.trim() : "";
            const brand_name = brandInput ? brandInput.value.trim() : "";
            const drug_name = drugInput ? drugInput.value.trim() : "";
            const pack = packInput ? packInput.value.trim() : "";
            const discount_percent = discountInput ? discountInput.value.trim() : "";
            const batch = batchInput.value.trim() !== "" ? batchInput.value.trim() : null;
            const exp = expInput.value.trim() !== "" ? expInput.value.trim() : null;
            const qty = qtyInput.value.trim() !== "" ? parseInt(qtyInput.value) : null;
            const mrp = mrpInput.value.trim() !== "" ? parseFloat(mrpInput.value) : null;
            const cost = (costInput && costInput.value.trim() !== "") ? parseFloat(costInput.value) : (mrp !== null ? mrp / 1.4 : null);
            const gst = gstInput.value.trim();

            let confidence = row.dataset.confidence ? parseInt(row.dataset.confidence) : null;
            const item = { name, batch, exp, qty, cost, mrp, gst, supplier_name, bill_date, brand_name, drug_name, pack, discount_percent, confidence_score: confidence };

            const formatChecksPassed = (
                name && this.isLikelyMedicineName(name) &&
                exp && /^(0[1-9]|1[0-2])\/(\d{2}|\d{4})$/.test(exp.trim()) &&
                qty !== null && !isNaN(qty) && Number.isInteger(Number(qty)) && qty > 0 &&
                mrp !== null && !isNaN(mrp) && mrp > 0 &&
                batch && batch.trim().length > 0 && /[a-zA-Z0-9]/.test(batch)
            );

            let validationStatus = this.validateExtractedItem(item);
            // validateExtractedItem() above already set item.confidence_score
            // correctly by reference (accounting for structural completeness,
            // strength-field confidence, and medicine-match score together) --
            // trust it directly. A prior version of this function force-promoted
            // any manual_review/warning row to valid/100% as soon as the
            // structural fields (batch/exp/qty/mrp) were filled in, regardless
            // of the actual reason for the flag. Since low-strength-confidence
            // rows are usually already structurally complete (batch/exp/qty/mrp
            // are the easy fields; strength is the hard one), that meant editing
            // any unrelated field silently cleared a strength warning without
            // the strength itself ever being verified -- a direct risk to the
            // "never merge different strengths" requirement.
            row.dataset.confidence = item.confidence_score !== null && item.confidence_score !== undefined ? item.confidence_score.toString() : "";

            const displayConf = item.confidence_score !== null && item.confidence_score !== undefined ? item.confidence_score : 0;
            const confidenceCell = row.querySelector(".confidence-cell");
            if (confidenceCell) {
                let confColor = "#10B981"; // success
                if (displayConf < 90) {
                    confColor = "#EF4444"; // error
                } else if (displayConf < 95) {
                    confColor = "#F59E0B"; // warning
                }
                confidenceCell.style.color = confColor;
                confidenceCell.textContent = `${displayConf}%`;
            }

            row.classList.remove("expired-red-glow", "expiring-orange-glow", "expiring-yellow-glow");

            const tablets = this.getTablets();
            const match = this.resolveMedicine(name, null, tablets).tablet;
            const selectedCode = match ? match.code : "";
            const isUnmatched = !selectedCode;
            const isLowConf = displayConf < 90;

            let statusHTML = "";
            if (validationStatus === "rejected") {
                row.classList.add("expired-red-glow");
                statusHTML = `<span class="status-badge badge-error">Rejected</span>`;
            } else if (validationStatus === "manual_review") {
                row.classList.add("expiring-orange-glow");
                const confSuffix = item.confidence_score !== null ? ` (${item.confidence_score}%)` : "";
                statusHTML = `<span class="status-badge badge-warning">Manual Review${confSuffix}</span>`;
            } else if (isUnmatched) {
                row.classList.add("expiring-yellow-glow");
                statusHTML = `<span class="status-badge badge-warning">New Product</span>`;
            } else if (validationStatus === "warning" || isLowConf) {
                row.classList.add("expiring-yellow-glow");
                const confSuffix = item.confidence_score !== null ? ` (${item.confidence_score}%)` : "";
                statusHTML = `<span class="status-badge badge-yellow">Low Conf${confSuffix}</span>`;
            } else {
                statusHTML = `<span class="status-badge badge-success">Matched: ${selectedCode}</span>`;
            }
            if (statusCell) {
                statusCell.innerHTML = statusHTML;
            }
        }

        // --- AI Assistant Chatbot Integration ---
        getCurrentDatabaseContext() {
            try {
                const tablets = this.getTablets().map(t => {
                    const firstLetter = (t.code || "A")[0].toUpperCase();
                    const rackNum = (t.code.length % 4) + 1;
                    return {
                        code: t.code,
                        name: t.name,
                        brand: t.brand,
                        drug: t.drugName,
                        pack: t.pack,
                        stock: t.stock,
                        reorder: t.reorder,
                        cost: t.cost,
                        mrp: t.mrp,
                        category: t.category || "Tablets & Capsules",
                        rack_location: `Rack-${firstLetter}-${rackNum}`,
                        batches: (t.batches || []).map(b => ({
                            batch: b.batchNumber,
                            exp: b.expiryDate,
                            qty: b.quantity
                        }))
                    };
                });

                const dueOrders = this.getDueOrders().map(d => ({
                    id: d.id,
                    disp_id: d.dispensaryId,
                    disp_name: d.dispensaryName,
                    med: d.medicineName,
                    qty: d.dueQuantity,
                    priority: d.priority || "Normal",
                    status: d.status,
                    notes: d.notes || ""
                }));

                const history = (JSON.parse(localStorage.getItem("ti_history") || "[]")).slice(-10);

                return {
                    current_time: new Date().toLocaleString(),
                    inventory: tablets,
                    due_orders: dueOrders,
                    recent_history: history
                };
            } catch (err) {
                console.error("Failed to build DB context for AI:", err);
                return { current_time: new Date().toLocaleString(), inventory: [], due_orders: [], recent_history: [] };
            }
        }

        updateRightSidebarDetails(brandName) {
            if (!brandName) return;
            const cleanQuery = brandName.trim().toUpperCase();
            const tablets = this.getTablets();
            
            // Try exact match or substring
            let tab = tablets.find(t => t.name.toUpperCase().includes(cleanQuery) || cleanQuery.includes(t.name.toUpperCase()) || t.code.toUpperCase() === cleanQuery);
            
            // If not found, use Levenshtein fallback
            if (!tab) {
                let bestMatch = null;
                let bestDist = 999;
                tablets.forEach(t => {
                    const dist = this.levenshtein(cleanQuery, t.name.toUpperCase());
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestMatch = t;
                    }
                });
                if (bestDist < 8) { // reasonable threshold
                    tab = bestMatch;
                }
            }

            if (!tab) {
                // If not in local inventory, it's an external medicine! Show simulated/mock details matching Roseday 10
                document.getElementById("det-brand-name").textContent = brandName;
                const statusBadge = document.getElementById("det-stock-status-badge");
                statusBadge.textContent = "Out of Stock";
                statusBadge.className = "ai-card-badge out-of-stock";
                statusBadge.style.background = "#fce8e6";
                statusBadge.style.color = "#c5221f";
                statusBadge.style.border = "1px solid #fad2cf";
                
                // Generic details
                const strengthMatch = brandName.match(/\b(2.5|5|10|20|40|50|100|250|500|650)\s*(MG|G)\b/i);
                const strength = strengthMatch ? strengthMatch[0] : "10 mg";
                const generic = brandName.toUpperCase().includes("ROSEDAY") || brandName.toUpperCase().includes("ROZAT") || brandName.toUpperCase().includes("ROSULIP") ? "Rosuvastatin" : "Generic Compound";
                
                document.getElementById("det-generic-name").textContent = generic;
                document.getElementById("det-strength").textContent = strength;
                document.getElementById("det-form").textContent = "Tablet";
                document.getElementById("det-category").textContent = brandName.toUpperCase().includes("ROSEDAY") ? "Cardiovascular" : "General Medicine";
                document.getElementById("det-shelflife").textContent = "24 Months";
                document.getElementById("det-storage").textContent = "Store below 25°C";
                
                document.getElementById("mock-package-brand").textContent = brandName.toUpperCase();
                document.getElementById("det-in-stock").textContent = "0";
                document.getElementById("det-in-stock").style.color = "#c5221f";
                document.getElementById("det-low-stock").textContent = "0";
                
                document.getElementById("det-manufacturer").textContent = "Dr. Reddy's";
                document.getElementById("det-pack").textContent = "10 x 10 Tablets";
                
                // Set default batch parameters from screenshot
                document.getElementById("det-active-batch").textContent = "RDT24058";
                document.getElementById("det-mfg-date").textContent = "02-05-2024";
                document.getElementById("det-exp-date").textContent = "01-05-2026";
                document.getElementById("det-last-purchase").textContent = "100 Strips (02-05-2025)";
                
                const purchasesContainer = document.getElementById("det-recent-purchases-container");
                if (purchasesContainer) {
                    purchasesContainer.innerHTML = `
                        <table style="width:100%; border-collapse:collapse; font-size:0.75rem;">
                            <tbody>
                                <tr style="border-bottom:1px solid #f1f5f9;">
                                    <td style="padding:6px 0; font-family:monospace; color:#334155;">02-05-2025</td>
                                    <td style="padding:6px 0; text-align:center; font-family:monospace; color:#475569;">RDT24058</td>
                                    <td style="padding:6px 0; text-align:center; font-weight:700; color:#1e293b;">100 Strips</td>
                                    <td style="padding:6px 0; text-align:right; font-weight:700; color:#475569;">Purchase</td>
                                </tr>
                                <tr style="border-bottom:1px solid #f1f5f9;">
                                    <td style="padding:6px 0; font-family:monospace; color:#334155;">15-04-2025</td>
                                    <td style="padding:6px 0; text-align:center; font-family:monospace; color:#475569;">RDT24012</td>
                                    <td style="padding:6px 0; text-align:center; font-weight:700; color:#1e293b;">200 Strips</td>
                                    <td style="padding:6px 0; text-align:right; font-weight:700; color:#475569;">Purchase</td>
                                </tr>
                                <tr>
                                    <td style="padding:6px 0; font-family:monospace; color:#334155;">28-03-2025</td>
                                    <td style="padding:6px 0; text-align:center; font-family:monospace; color:#475569;">RDT23987</td>
                                    <td style="padding:6px 0; text-align:center; font-weight:700; color:#1e293b;">150 Strips</td>
                                    <td style="padding:6px 0; text-align:right; font-weight:700; color:#475569;">Purchase</td>
                                </tr>
                            </tbody>
                        </table>
                    `;
                }
                return;
            }

            // If found in local inventory!
            document.getElementById("det-brand-name").textContent = tab.name;
            const statusBadge = document.getElementById("det-stock-status-badge");
            
            let statusClass = "in-stock";
            let statusText = "In Stock";
            let valColor = "#137333"; // green
            let bgBadgeColor = "#e6f4ea";
            let borderBadgeColor = "#ceead6";
            
            if (tab.stock === 0) {
                statusClass = "out-of-stock";
                statusText = "Out of Stock";
                valColor = "#c5221f";
                bgBadgeColor = "#fce8e6";
                borderBadgeColor = "#fad2cf";
            } else if (tab.stock <= tab.reorder) {
                statusClass = "low-stock";
                statusText = "Low Stock";
                valColor = "#b06000";
                bgBadgeColor = "#fef7e0";
                borderBadgeColor = "#feebc8";
            }
            
            statusBadge.textContent = statusText;
            statusBadge.className = `ai-card-badge ${statusClass}`;
            statusBadge.style.background = bgBadgeColor;
            statusBadge.style.color = valColor;
            statusBadge.style.border = `1px solid ${borderBadgeColor}`;
            
            document.getElementById("det-generic-name").textContent = tab.drugName || "Generic Drug";
            
            const strengthMatch = tab.name.match(/\b(2.5|5|10|20|40|50|100|250|500|650)\s*(MG|G)\b/i);
            document.getElementById("det-strength").textContent = strengthMatch ? strengthMatch[0] : "10 mg";
            document.getElementById("det-form").textContent = tab.pack.includes("STRIP") || tab.pack.includes("'s") ? "Tablet" : "Liquid/Other";
            document.getElementById("det-category").textContent = tab.category || "Tablets & Capsules";
            document.getElementById("det-shelflife").textContent = tab.shelflife || "24 Months";
            document.getElementById("det-storage").textContent = tab.storage || "Store below 25°C";
            
            document.getElementById("mock-package-brand").textContent = tab.name.split(" ").slice(-2).join(" ").toUpperCase();
            
            document.getElementById("det-in-stock").textContent = tab.stock;
            document.getElementById("det-in-stock").style.color = valColor;
            document.getElementById("det-low-stock").textContent = tab.stock <= tab.reorder ? tab.stock : "0";
            
            // Set dynamic/randomized batch numbers
            const batchSeed = (tab.code || "ROS").replace(/[^a-zA-Z0-9]/g, "");
            document.getElementById("det-active-batch").textContent = `${batchSeed}24058`;
            document.getElementById("det-mfg-date").textContent = "02-05-2024";
            document.getElementById("det-exp-date").textContent = "01-05-2026";
            document.getElementById("det-last-purchase").textContent = `${tab.stock > 0 ? tab.stock : 100} Strips (02-05-2025)`;
            
            document.getElementById("det-manufacturer").textContent = tab.brand || "Dr. Reddy's";
            document.getElementById("det-pack").textContent = tab.pack;
            
            // Update purchase logs dynamically from history
            const history = JSON.parse(localStorage.getItem("ti_history") || "[]");
            const logs = history.filter(h => h.tabletName === tab.name && h.type === "STOCK IN").slice(-3);
            
            const purchasesContainer = document.getElementById("det-recent-purchases-container");
            if (purchasesContainer) {
                if (logs.length === 0) {
                    purchasesContainer.innerHTML = `
                        <table style="width:100%; border-collapse:collapse; font-size:0.75rem;">
                            <tbody>
                                <tr style="border-bottom:1px solid #f1f5f9;">
                                    <td style="padding:6px 0; font-family:monospace; color:#334155;">02-05-2025</td>
                                    <td style="padding:6px 0; text-align:center; font-family:monospace; color:#475569;">${batchSeed}24058</td>
                                    <td style="padding:6px 0; text-align:center; font-weight:700; color:#1e293b;">100 Strips</td>
                                    <td style="padding:6px 0; text-align:right; font-weight:700; color:#475569;">Purchase</td>
                                </tr>
                            </tbody>
                        </table>
                    `;
                } else {
                    purchasesContainer.innerHTML = `
                        <table style="width:100%; border-collapse:collapse; font-size:0.75rem;">
                            <tbody>
                                ${logs.map((l, index) => `
                                    <tr style="${index < logs.length - 1 ? 'border-bottom:1px solid #f1f5f9;' : ''}">
                                        <td style="padding:6px 0; font-family:monospace; color:#334155;">${l.datetime.split(" ")[0]}</td>
                                        <td style="padding:6px 0; text-align:center; font-family:monospace; color:#475569;">${l.batch || "RDT24058"}</td>
                                        <td style="padding:6px 0; text-align:center; font-weight:700; color:#1e293b;">${l.qty} Strips</td>
                                        <td style="padding:6px 0; text-align:right; font-weight:700; color:#475569;">Purchase</td>
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    `;
                }
            }
        }

        // ================================================================
        // AI Reporting Center (Priority 3) — natural language -> read-only
        // SQL -> report, via the `ai-report-query` Edge Function. This is
        // deliberately independent from the (separate, pre-existing)
        // Pharmacy AI Assistant chat below — different purpose, different
        // backend, kept as its own module per the implementation rules.
        //
        // Schema metadata now lives server-side in schema-knowledge.json
        // (loaded by the Edge Function) — nothing schema-related needs to
        // change here when tables/views are added.
        // ================================================================

        initAIReportsInterface() {
            const input = document.getElementById("ai-report-input");
            const btnSend = document.getElementById("btn-send-ai-report");
            const btnClear = document.getElementById("btn-clear-ai-report-chat");
            const suggestions = document.getElementById("ai-report-suggestions");
            const savedRow = document.getElementById("ai-report-saved");

            if (!this.aiReportHistory) this.aiReportHistory = this.loadAIReportConversation();

            if (!this.aiReportInterfaceInitialized) {
                this.aiReportInterfaceInitialized = true;

                const handleSend = () => {
                    const text = input.value.trim();
                    if (!text) return;
                    input.value = "";
                    input.style.height = "auto";
                    this.sendAIReportQuestion(text);
                };

                if (btnSend) btnSend.addEventListener("click", handleSend);
                if (input) {
                    input.addEventListener("keydown", (e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    });
                    input.addEventListener("input", () => {
                        input.style.height = "auto";
                        input.style.height = input.scrollHeight + "px";
                    });
                }
                if (btnClear) {
                    btnClear.addEventListener("click", () => {
                        this.aiReportHistory = [];
                        this.saveAIReportConversation();
                        this.renderAIReportMessages();
                    });
                }
                if (suggestions) {
                    suggestions.addEventListener("click", (e) => {
                        const chip = e.target.closest(".suggestion-chip[data-q]");
                        if (chip) this.sendAIReportQuestion(chip.getAttribute("data-q"));
                    });
                }
                if (savedRow) {
                    savedRow.addEventListener("click", (e) => {
                        const delBtn = e.target.closest(".del-saved");
                        if (delBtn) {
                            e.stopPropagation();
                            this.deleteAISavedReport(delBtn.getAttribute("data-id"));
                            return;
                        }
                        const chip = e.target.closest(".suggestion-chip[data-q]");
                        if (chip) this.sendAIReportQuestion(chip.getAttribute("data-q"));
                    });
                }
            }

            this.renderAIReportRecentSearches();
            this.loadAISavedReports();

            if (this.aiReportHistory.length === 0) {
                this.aiReportHistory.push({
                    role: "system",
                    text: "Ask about stock, dues, suppliers, reorders, expiry, or OCR history — in English or Tamil. I only run read-only queries and never modify data.",
                });
            }
            this.renderAIReportMessages();
        }

        // ---- Conversation history: persisted per-browser so users don't
        //      have to retype earlier questions after a reload. ----
        aiReportConversationKey() {
            const uid = (this.currentUser && (this.currentUser.id || this.currentUser.email)) || "guest";
            return `ai_report_conversation_${uid}`;
        }

        loadAIReportConversation() {
            try {
                const raw = localStorage.getItem(this.aiReportConversationKey());
                return raw ? JSON.parse(raw) : [];
            } catch { return []; }
        }

        saveAIReportConversation() {
            try {
                // Cap what's persisted so a long session doesn't bloat localStorage —
                // keep the most recent 30 messages.
                const trimmed = this.aiReportHistory.slice(-30).filter(m => !m.loading);
                localStorage.setItem(this.aiReportConversationKey(), JSON.stringify(trimmed));
            } catch { /* localStorage full or unavailable — non-fatal */ }
        }

        renderAIReportRecentSearches() {
            const suggestions = document.getElementById("ai-report-suggestions");
            if (!suggestions) return;
            let recent = [];
            try { recent = JSON.parse(localStorage.getItem("ai_report_recent_searches") || "[]"); } catch { recent = []; }
            suggestions.querySelectorAll(".suggestion-chip[data-recent]").forEach(c => c.remove());
            recent.slice(0, 5).forEach(q => {
                const chip = document.createElement("span");
                chip.className = "suggestion-chip";
                chip.setAttribute("data-q", q);
                chip.setAttribute("data-recent", "1");
                chip.style.borderColor = "rgba(0, 242, 254, 0.3)";
                chip.textContent = q.length > 40 ? q.slice(0, 40) + "…" : q;
                suggestions.appendChild(chip);
            });
        }

        saveAIReportRecentSearch(question) {
            let recent = [];
            try { recent = JSON.parse(localStorage.getItem("ai_report_recent_searches") || "[]"); } catch { recent = []; }
            recent = [question, ...recent.filter(q => q !== question)].slice(0, 8);
            localStorage.setItem("ai_report_recent_searches", JSON.stringify(recent));
        }

        // ---- Saved Reports: named, frequently-used queries, stored in
        //      Supabase (ai_saved_reports) so they follow the user across
        //      devices, same pattern as the rest of the app's cloud data. ----
        async loadAISavedReports() {
            const row = document.getElementById("ai-report-saved");
            if (!row || !supabaseClient || !this.currentUser) return;
            try {
                const { data, error } = await supabaseClient
                    .from("ai_saved_reports")
                    .select("id, title, question")
                    .order("created_at", { ascending: false })
                    .limit(15);
                if (error) throw error;
                row.querySelectorAll(".suggestion-chip[data-saved-id]").forEach(c => c.remove());
                (data || []).forEach(r => {
                    const chip = document.createElement("span");
                    chip.className = "suggestion-chip";
                    chip.setAttribute("data-q", r.question);
                    chip.setAttribute("data-saved-id", r.id);
                    chip.style.borderColor = "rgba(52, 211, 153, 0.35)";
                    chip.innerHTML = `${this.escapeHtml(r.title)} <span class="del-saved" data-id="${r.id}" title="Remove" style="opacity:0.6;margin-left:4px;">✕</span>`;
                    row.appendChild(chip);
                });
            } catch (e) {
                console.error("Failed to load saved reports:", e);
            }
        }

        async saveAIReportAsFavorite(question) {
            if (!supabaseClient || !this.currentUser) {
                this.showToast("Sign in required to save reports.", "warning");
                return;
            }
            const title = window.prompt("Name this saved report:", question.length > 40 ? question.slice(0, 40) : question);
            if (!title) return;
            try {
                const { data: sessionData } = await supabaseClient.auth.getSession();
                const uid = sessionData && sessionData.session ? sessionData.session.user.id : null;
                if (!uid) throw new Error("Not signed in.");
                const { error } = await supabaseClient.from("ai_saved_reports").insert({
                    owner_id: uid,
                    owner_name: (this.currentUser && this.currentUser.name) || null,
                    title: title.trim(),
                    question: question.trim(),
                });
                if (error) throw error;
                this.showToast("Report saved.", "success");
                this.loadAISavedReports();
            } catch (e) {
                this.showToast(`Could not save report: ${e.message}`, "error");
            }
        }

        async deleteAISavedReport(id) {
            if (!supabaseClient) return;
            try {
                const { error } = await supabaseClient.from("ai_saved_reports").delete().eq("id", id);
                if (error) throw error;
                this.loadAISavedReports();
            } catch (e) {
                this.showToast(`Could not remove saved report: ${e.message}`, "error");
            }
        }

        async sendAIReportQuestion(question) {
            if (!question || !question.trim()) return;
            this.aiReportHistory.push({ role: "user", text: question });
            this.aiReportHistory.push({ role: "bot", loading: true });
            this.renderAIReportMessages();
            this.saveAIReportRecentSearch(question.trim());
            this.renderAIReportRecentSearches();

            const statusEl = document.getElementById("ai-report-status");
            if (statusEl) statusEl.textContent = "Thinking…";

            try {
                const result = await callEdgeFunction("ai-report-query", { action: "query", question: question.trim() });
                const loadingMsg = this.aiReportHistory[this.aiReportHistory.length - 1];
                loadingMsg.loading = false;
                loadingMsg.result = result;
            } catch (err) {
                const loadingMsg = this.aiReportHistory[this.aiReportHistory.length - 1];
                loadingMsg.loading = false;
                loadingMsg.error = err.message || "Something went wrong running that report.";
            }

            if (statusEl) statusEl.textContent = "Ask a question in English or Tamil · read-only, safe by design";
            this.saveAIReportConversation();
            this.renderAIReportMessages();
        }

        async explainAIReportResult(msgIdx) {
            const msg = this.aiReportHistory[msgIdx];
            if (!msg || !msg.result || !msg.result.rows || msg.result.rows.length === 0) return;
            msg.explainLoading = true;
            this.renderAIReportMessages();
            try {
                const questionMsg = this.aiReportHistory.slice(0, msgIdx).reverse().find(m => m.role === "user");
                const resp = await callEdgeFunction("ai-report-query", {
                    action: "explain",
                    question: questionMsg ? questionMsg.text : "",
                    columns: msg.result.columns,
                    rows: msg.result.rows,
                });
                msg.explanation = resp.explanation || "No explanation available.";
            } catch (e) {
                msg.explanation = `Couldn't generate an explanation: ${e.message}`;
            }
            msg.explainLoading = false;
            this.saveAIReportConversation();
            this.renderAIReportMessages();
        }

        renderAIReportMessages() {
            const container = document.getElementById("ai-report-messages");
            if (!container) return;
            const role = (this.currentUser && this.currentUser.role) || "Staff";
            const isAdmin = role === "Administrator";

            container.innerHTML = this.aiReportHistory.map((msg, idx) => {
                if (msg.role === "system") {
                    return `<div class="message system-message">${this.escapeHtml(msg.text)}</div>`;
                }
                if (msg.role === "user") {
                    return `<div class="message user-message">
                        ${this.escapeHtml(msg.text)}
                        <div style="margin-top:4px;">
                            <span class="suggestion-chip" style="font-size:0.68rem;padding:3px 8px;" data-save-question="${idx}">☆ Save</span>
                        </div>
                    </div>`;
                }
                // bot message
                if (msg.loading) {
                    return `<div class="message bot-message"><span style="opacity:0.7;">Running your report…</span></div>`;
                }
                if (msg.error) {
                    return `<div class="message bot-message" style="border-color: rgba(244,63,94,0.35);">
                        <strong style="color:#fb7185;">Couldn't run that report</strong><br>
                        <span style="font-size:0.85rem;">${this.escapeHtml(msg.error)}</span>
                    </div>`;
                }
                const r = msg.result || {};
                const rows = r.rows || [];
                const columns = r.columns || [];
                let tableHtml = "";
                if (rows.length > 0) {
                    tableHtml = `
                        <div class="table-responsive max-height-300" style="margin-top:10px;">
                            <table class="data-table compact">
                                <thead><tr>${columns.map(c => `<th>${this.escapeHtml(c)}</th>`).join("")}</tr></thead>
                                <tbody>
                                    ${rows.slice(0, 100).map(row => `<tr>${columns.map(c => `<td>${this.escapeHtml(row[c] === null || row[c] === undefined ? "" : String(row[c]))}</td>`).join("")}</tr>`).join("")}
                                </tbody>
                            </table>
                        </div>
                        ${rows.length > 100 ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">Showing first 100 of ${rows.length} rows — use Export for the full result.</div>` : ""}
                        <div class="chat-quick-suggestions" style="padding:10px 0 0 0;border-top:none;background:transparent;">
                            <span class="suggestion-chip" data-export="csv" data-msg-idx="${idx}">Export CSV</span>
                            <span class="suggestion-chip" data-export="excel" data-msg-idx="${idx}">Export Excel</span>
                            <span class="suggestion-chip" data-export="print" data-msg-idx="${idx}">Print</span>
                            <span class="suggestion-chip" data-explain="1" data-msg-idx="${idx}">${msg.explainLoading ? "Explaining…" : "✨ Explain Result"}</span>
                        </div>
                        ${msg.explanation ? `<div style="margin-top:8px;padding:10px 12px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.25);border-radius:8px;font-size:0.85rem;">${this.escapeHtml(msg.explanation)}</div>` : ""}`;
                }
                const sqlHtml = (isAdmin && r.sql) ? `
                        <details style="margin-top:10px;">
                            <summary style="cursor:pointer;font-size:0.75rem;color:var(--text-muted);">View SQL used (Admin only)</summary>
                            <pre style="white-space:pre-wrap;font-size:0.75rem;background:rgba(0,0,0,0.35);padding:10px;border-radius:8px;margin-top:6px;color:#a5f3fc;">${this.escapeHtml(r.sql)}</pre>
                        </details>` : "";
                return `<div class="message bot-message">
                    <div>${this.escapeHtml(r.summary || "No summary available.")}</div>
                    ${r.rowCount ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:4px;">${r.rowCount} record${r.rowCount === 1 ? "" : "s"}${r.executionMs ? ` · ${r.executionMs}ms` : ""}</div>` : ""}
                    ${tableHtml}
                    ${sqlHtml}
                </div>`;
            }).join("");

            container.querySelectorAll(".suggestion-chip[data-export]").forEach(chip => {
                chip.addEventListener("click", () => {
                    const idx = parseInt(chip.getAttribute("data-msg-idx"), 10);
                    const format = chip.getAttribute("data-export");
                    this.exportAIReportResult(idx, format);
                });
            });
            container.querySelectorAll(".suggestion-chip[data-explain]").forEach(chip => {
                chip.addEventListener("click", () => {
                    const idx = parseInt(chip.getAttribute("data-msg-idx"), 10);
                    this.explainAIReportResult(idx);
                });
            });
            container.querySelectorAll("[data-save-question]").forEach(el => {
                el.addEventListener("click", () => {
                    const idx = parseInt(el.getAttribute("data-save-question"), 10);
                    const m = this.aiReportHistory[idx];
                    if (m && m.text) this.saveAIReportAsFavorite(m.text);
                });
            });

            container.scrollTop = container.scrollHeight;
        }

        exportAIReportResult(msgIdx, format) {
            const msg = this.aiReportHistory[msgIdx];
            if (!msg || !msg.result || !msg.result.rows || msg.result.rows.length === 0) {
                this.showToast("Nothing to export.", "warning");
                return;
            }
            const rows = msg.result.rows;
            const stamp = new Date().toISOString().slice(0, 10);

            if (format === "csv") {
                const headers = Object.keys(rows[0]);
                let csv = headers.join(",") + "\n";
                rows.forEach(row => {
                    csv += headers.map(h => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(",") + "\n";
                });
                this.downloadCSV(csv, `ai-report-${stamp}.csv`);
            } else if (format === "excel") {
                if (!window.XLSX) {
                    this.showToast("Excel export library did not load — check your internet connection and try again.", "error");
                    return;
                }
                const ws = window.XLSX.utils.json_to_sheet(rows);
                const wb = window.XLSX.utils.book_new();
                window.XLSX.utils.book_append_sheet(wb, ws, "AI Report");
                window.XLSX.writeFile(wb, `ai-report-${stamp}.xlsx`);
                this.showToast(`Exported ${rows.length} records to Excel.`, "success");
            } else if (format === "print") {
                const headers = Object.keys(rows[0]);
                const htmlRows = rows.map(row => `<tr>${headers.map(h => `<td style="border:1px solid #ccc;padding:4px 8px;font-size:12px;">${row[h] ?? ""}</td>`).join("")}</tr>`).join("");
                const printWindow = window.open("", "_blank");
                printWindow.document.write(`
                    <html><head><title>AI Report - ${stamp}</title></head>
                    <body style="font-family:Arial, sans-serif;">
                        <h3>Kastoori Medicals — AI Report (${stamp})</h3>
                        <table style="border-collapse:collapse;width:100%;">
                            <thead><tr>${headers.map(h => `<th style="border:1px solid #ccc;padding:4px 8px;font-size:12px;text-align:left;">${h}</th>`).join("")}</tr></thead>
                            <tbody>${htmlRows}</tbody>
                        </table>
                    </body></html>
                `);
                printWindow.document.close();
                printWindow.print();
            }
        }

        // Small shared helper: escape untrusted text (AI output, DB values)
        // before it goes into innerHTML anywhere in the AI Reporting Center.
        escapeHtml(str) {
            const div = document.createElement("div");
            div.textContent = str === null || str === undefined ? "" : String(str);
            return div.innerHTML;
        }

        initChatInterface() {
            const chatMessages = document.getElementById("ai-chat-messages");
            const chatInput = document.getElementById("ai-chat-input");
            const btnSend = document.getElementById("btn-send-chat-msg");
            const btnClear = document.getElementById("btn-clear-chat");
            const globalSearch = document.getElementById("ai-global-search-bar");

            // Avoid binding events multiple times
            if (this.chatInterfaceInitialized) return;
            this.chatInterfaceInitialized = true;

            const handleSend = () => {
                const text = chatInput.value.trim();
                if (!text) return;
                chatInput.value = "";
                chatInput.style.height = "auto";
                this.sendChatMessage(text);
            };

            const handleGlobalSearch = () => {
                const text = globalSearch.value.trim();
                if (!text) return;
                globalSearch.value = "";
                this.sendChatMessage(`Search medicine or find alternatives for: ${text}`);
            };

            if (btnSend) {
                btnSend.addEventListener("click", handleSend);
            }

            if (chatInput) {
                chatInput.addEventListener("keydown", (e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSend();
                    }
                });
                
                // Auto-grow height
                chatInput.addEventListener("input", () => {
                    chatInput.style.height = "auto";
                    chatInput.style.height = (chatInput.scrollHeight) + "px";
                });
            }

            if (globalSearch) {
                globalSearch.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        handleGlobalSearch();
                    }
                });
            }

            // Global Ctrl + K search focus shortcut
            document.addEventListener("keydown", (e) => {
                if (e.ctrlKey && e.key.toLowerCase() === "k") {
                    e.preventDefault();
                    if (globalSearch) {
                        globalSearch.focus();
                        globalSearch.select();
                    }
                }
            });

            // Collapsible Sidebar Toggle
            const btnCollapse = document.getElementById("btn-side-collapse");
            const aiLeftSidebar = document.getElementById("ai-left-sidebar");
            if (btnCollapse && aiLeftSidebar) {
                btnCollapse.addEventListener("click", () => {
                    aiLeftSidebar.classList.toggle("collapsed");
                });
            }

            // Tab Screen Switch Logic
            const showScreen = (screenId) => {
                document.querySelectorAll(".ai-screen").forEach(screen => {
                    screen.classList.remove("active");
                    screen.style.display = "none";
                });
                const activeScreen = document.getElementById(screenId);
                if (activeScreen) {
                    activeScreen.style.display = "flex";
                    // Trigger reflow for transition
                    setTimeout(() => activeScreen.classList.add("active"), 10);
                }
            };

            // Bind click to menu buttons matching mockup IDs
            const bindSideBtn = (id, promptText) => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener("click", () => {
                        document.querySelectorAll(".ai-menu-btn").forEach(b => b.classList.remove("active"));
                        el.classList.add("active");
                        if (promptText) {
                            this.sendChatMessage(promptText);
                        }
                    });
                }
            };

            bindSideBtn("btn-side-main", null); // stays on main chat
            bindSideBtn("btn-side-inv", "List all available medicines in stock");
            bindSideBtn("btn-side-alt", "Find equivalents and alternatives for Roseday 10 mg");
            bindSideBtn("btn-side-generic", "Show drug information for Rosuvastatin");
            
            // Due orders menu: switch to the main due orders tab of the system!
            const btnSideDues = document.getElementById("btn-side-dues");
            if (btnSideDues) {
                btnSideDues.addEventListener("click", () => {
                    document.querySelectorAll(".ai-menu-btn").forEach(b => b.classList.remove("active"));
                    btnSideDues.classList.add("active");
                    this.switchTab("due-view");
                });
            }
            
            bindSideBtn("btn-side-low", "Show all low stock alert medicines");
            bindSideBtn("btn-side-tool-inter", "Explain drug interactions for Rosuvastatin");
            bindSideBtn("btn-side-tool-expiry", "Show upcoming expiry dates for medicines");
            bindSideBtn("btn-side-tool-price", "Compare prices of all Rosuvastatin brands");
            bindSideBtn("btn-side-tool-supplier", "Show contact details of USV suppliers");

            // Suggestion chips listeners
            const bindChip = (id, promptText) => {
                const el = document.getElementById(id);
                if (el) {
                    el.addEventListener("click", () => {
                        this.sendChatMessage(promptText);
                    });
                }
            };

            bindChip("btn-sq-substitutes", "Show generic of Roseday 10 mg");
            bindChip("btn-sq-expiry", "Show composition details of Rosuvastatin");
            bindChip("btn-sq-brands", "Show other strengths of Roseday");
            bindChip("btn-sq-history", "Show price comparison of Rosuvastatin alternatives");

            const btnSqDueQty = document.getElementById("btn-sq-due-qty");
            if (btnSqDueQty) {
                btnSqDueQty.addEventListener("click", () => {
                    this.showToast("Added Roseday 10 mg to Favourites!", "success");
                });
            }

            // Voice Assistant simulation trigger
            const handleVoiceMic = () => {
                this.showToast("Listening... (Simulating Voice Recognition)", "info");
                setTimeout(() => {
                    const samplePrompts = [
                        "Find substitutes for USV L. ROSEDAY 20MG",
                        "Show stock levels for Roseday 10 mg",
                        "List all pending due orders",
                        "List low stock warning tablets"
                    ];
                    const randomPrompt = samplePrompts[Math.floor(Math.random() * samplePrompts.length)];
                    if (chatInput) {
                        chatInput.value = randomPrompt;
                        chatInput.focus();
                        chatInput.dispatchEvent(new Event("input"));
                        this.showToast(`Voice input: "${randomPrompt}"`, "success");
                    }
                }, 2000);
            };

            const btnMic = document.getElementById("btn-input-mic");
            if (btnMic) {
                btnMic.addEventListener("click", handleVoiceMic);
            }

            // Floating action buttons handlers
            const btnFabMain = document.getElementById("btn-floating-fab-main");
            if (btnFabMain) {
                btnFabMain.addEventListener("click", () => {
                    const btnChat = document.getElementById("btn-side-main");
                    if (btnChat) btnChat.click();
                    if (chatInput) chatInput.focus();
                    this.showToast("AI workspace active", "info");
                });
            }

            const btnFabTheme = document.getElementById("btn-floating-theme-toggle");
            if (btnFabTheme) {
                btnFabTheme.addEventListener("click", () => {
                    document.body.classList.toggle("dark-theme");
                    this.showToast(document.body.classList.contains("dark-theme") ? "Dark Mode Active" : "Light Mode Active", "info");
                });
            }

            const btnFabOcr = document.getElementById("btn-floating-ocr-scanner");
            if (btnFabOcr) {
                btnFabOcr.addEventListener("click", () => {
                    const appOcrInput = document.getElementById("ocr-file-input");
                    if (appOcrInput) {
                        appOcrInput.click();
                    } else {
                        const inputOcr = document.getElementById("btn-input-ocr");
                        if (inputOcr) inputOcr.click();
                    }
                });
            }

            // Input Scan Invoice button click triggers OCR
            const inputOcrBtn = document.getElementById("btn-input-ocr");
            if (inputOcrBtn) {
                inputOcrBtn.addEventListener("click", () => {
                    const fileInput = document.getElementById("ocr-file-input");
                    if (fileInput) {
                        fileInput.click();
                        this.showToast("Please upload/scan a purchase invoice image", "info");
                    }
                });
            }


            if (btnClear) {
                btnClear.addEventListener("click", () => {
                    if (chatMessages) {
                        chatMessages.innerHTML = `
                            <div class="message system-message">
                                <div class="message-content">
                                    Welcome to the <strong>Pharmacy AI Assistant</strong>. Use the sidebar shortcuts, search bar, or quick actions to research drugs and manage stock.
                                </div>
                            </div>
                        `;
                    }
                });
            }

            // Delegated click listener in chat messages to load right details panel
            if (chatMessages) {
                chatMessages.addEventListener("click", (e) => {
                    // Click on a table row
                    const row = e.target.closest("tr");
                    if (row) {
                        const brandCell = row.cells[0];
                        if (brandCell) {
                            const brandName = brandCell.textContent.trim();
                            this.updateRightSidebarDetails(brandName);
                        }
                        return;
                    }
                    
                    // Click on a medicine card
                    const card = e.target.closest(".ai-medicine-card");
                    if (card && !e.target.closest("button")) {
                        const titleEl = card.querySelector(".ai-card-title");
                        if (titleEl) {
                            const brandName = titleEl.textContent.trim();
                            this.updateRightSidebarDetails(brandName);
                        }
                        return;
                    }

                    // Click on card actions buttons
                    if (e.target.closest("button")) {
                        const btn = e.target.closest("button");
                        const brandName = btn.getAttribute("data-brand") || "USV L. ROSEDAY 20MG";
                        
                        if (btn.classList.contains("btn-card-details")) {
                            this.updateRightSidebarDetails(brandName);
                            this.showToast(`Loading details for ${brandName}...`);
                        } else if (btn.classList.contains("btn-card-reserve")) {
                            this.showToast(`Stock Reserved: 10 units of ${brandName} secured for dispensary delivery.`, "success");
                            // Reduce stock locally by 10 to show real-time changes
                            const tablets = this.getTablets();
                            const tab = tablets.find(t => t.name.toUpperCase().includes(brandName.toUpperCase()));
                            if (tab && tab.stock >= 10) {
                                tab.stock -= 10;
                                this.setTablets(tablets);
                                this.updateRightSidebarDetails(brandName);
                                this.initInventorySearchGrid();
                            }
                        } else if (btn.classList.contains("btn-card-inv")) {
                            const btnInv = document.getElementById("btn-side-inv");
                            if (btnInv) btnInv.click();
                            this.showToast(`Showing stock details matching: ${brandName}`);
                        } else if (btn.classList.contains("btn-card-po")) {
                            const ordTab = document.querySelector('[data-target="order-view"]');
                            if (ordTab) {
                                ordTab.click();
                                const ordName = document.getElementById("due-tablet-name");
                                if (ordName) {
                                    ordName.value = brandName;
                                    ordName.dispatchEvent(new Event("change"));
                                }
                                this.showToast(`Pre-populated order form for ${brandName}`, "success");
                            }
                        }
                    }
                });
            }

            // Left Sidebar Main Menu Buttons
            const bindSideMenu = (id, promptText) => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.addEventListener("click", () => {
                        const tabName = btn.getAttribute("data-tab");
                        if (!tabName) {
                            showScreen("ai-screen-chat");
                            this.sendChatMessage(promptText);
                        }
                    });
                }
            };

            bindSideMenu("btn-side-main", "Hi! Show me how to search medicines, list substitutes, or verify batch allocations.");
            bindSideMenu("btn-side-alt", "Find alternative brands for USV L. ROSEDAY 20MG.");
            bindSideMenu("btn-side-generic", "Show me the salt composition details for Rosuvastatin.");
            bindSideMenu("btn-side-brand", "Search for USV brand medicine lines.");
            bindSideMenu("btn-side-bills", "Verify recent invoice billing entries.");
            bindSideMenu("btn-side-verify", "Run verification check on pending purchase logs.");
            bindSideMenu("btn-side-expiry", "Show all batches expiring in the next 90 days.");
            bindSideMenu("btn-side-favourites", "Show my favorite tablets list.");
            bindSideMenu("btn-side-settings", "Open AI model parameters and system prompt settings.");

            // Left Sidebar History list clicks
            const bindHistoryItem = (id, promptText) => {
                const item = document.getElementById(id);
                if (item) {
                    item.addEventListener("click", () => {
                        showScreen("ai-screen-chat");
                        this.sendChatMessage(promptText);
                    });
                }
            };
            bindHistoryItem("hist-1", "Give me alternatives for Roseday 10 mg.");
            bindHistoryItem("hist-2", "List details for Paracetamol 650 mg.");
            bindHistoryItem("hist-3", "Find alternatives for Amoxicillin 500 mg.");
            bindHistoryItem("hist-4", "Check inventory for Pantoprazole 40 mg.");

            if (document.getElementById("btn-view-all-history")) {
                document.getElementById("btn-view-all-history").addEventListener("click", () => {
                    showScreen("ai-screen-chat");
                    this.sendChatMessage("Show complete search history and session audits.");
                });
            }

            // New Chat tab handler
            if (document.getElementById("ai-tab-new")) {
                document.getElementById("ai-tab-new").addEventListener("click", () => {
                    showScreen("ai-screen-chat");
                    if (chatMessages) {
                        chatMessages.innerHTML = `
                            <div class="message system-message">
                                <div class="message-content">
                                    New session started. Ask me about medicine generic equivalents, stock counts, or supplier histories.
                                </div>
                            </div>
                        `;
                    }
                    this.updateRightSidebarDetails("USV L. ROSEDAY 20MG");
                });
            }

            // Quick Action Buttons
            const bindQuickAction = (id, promptText) => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.addEventListener("click", () => {
                        showScreen("ai-screen-chat");
                        this.sendChatMessage(promptText);
                    });
                }
            };

            bindQuickAction("btn-qa-alt", "Find substitutes and alternatives for USV L. ROSEDAY 20MG.");
            bindQuickAction("btn-qa-inv", "List the current inventory stock level for Roseday.");
            bindQuickAction("btn-qa-info", "Give detailed drug profile information for Metformin.");
            bindQuickAction("btn-qa-dues", "Show due orders summary.");

            // Suggested Questions Chips Clicks
            const bindSuggestedQuestion = (id, promptText) => {
                const btn = document.getElementById(id);
                if (btn) {
                    btn.addEventListener("click", () => {
                        showScreen("ai-screen-chat");
                        this.sendChatMessage(promptText);
                    });
                }
            };
            bindSuggestedQuestion("btn-sq-substitutes", "Show generic of this medicine.");
            bindSuggestedQuestion("btn-sq-expiry", "Show composition details.");
            bindSuggestedQuestion("btn-sq-brands", "Show other strengths available.");
            bindSuggestedQuestion("btn-sq-history", "Show price comparison across manufacturers.");
            bindSuggestedQuestion("btn-sq-due-qty", "Add this medicine to my favorite lists.");
        }

        initAnalyticsCharts() {
            const ctxCat = document.getElementById("chart-stock-distribution");
            if (ctxCat) {
                if (window.myChartStockDist) {
                    window.myChartStockDist.destroy();
                }
                const tablets = this.getTablets();
                const categories = {};
                tablets.forEach(t => {
                    const cat = t.category || "Tablets & Capsules";
                    categories[cat] = (categories[cat] || 0) + t.stock;
                });
                const labels = Object.keys(categories);
                const data = Object.values(categories);
                window.myChartStockDist = new Chart(ctxCat, {
                    type: 'doughnut',
                    data: {
                        labels: labels,
                        datasets: [{
                            data: data,
                            backgroundColor: ['#3b82f6', '#10b981', '#a855f7', '#f59e0b', '#ef4444', '#6366f1']
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                display: true,
                                position: 'bottom',
                                labels: { font: { size: 10 } }
                            }
                        }
                    }
                });
            }

            const ctxTrends = document.getElementById("chart-trends-trends");
            if (ctxTrends) {
                if (window.myChartTrends) {
                    window.myChartTrends.destroy();
                }
                window.myChartTrends = new Chart(ctxTrends, {
                    type: 'line',
                    data: {
                        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
                        datasets: [
                            {
                                label: 'Purchases (₹)',
                                data: [12000, 19000, 15000, 25000, 22000, 30000],
                                borderColor: '#10b981',
                                fill: false,
                                tension: 0.1
                            },
                            {
                                label: 'Sales (₹)',
                                data: [14000, 17000, 18000, 22000, 26000, 32000],
                                borderColor: '#3b82f6',
                                fill: false,
                                tension: 0.1
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                display: true,
                                position: 'bottom',
                                labels: { font: { size: 10 } }
                            }
                        }
                    }
                });
            }
        }

        initInventorySearchGrid() {
            const container = document.getElementById("ai-inventory-table-container");
            if (!container) return;
            const tablets = this.getTablets();
            let tableHTML = `
                <table class="data-table small" style="margin: 0;">
                    <thead>
                        <tr>
                            <th>Brand Name</th>
                            <th>Generic Name</th>
                            <th>Stock</th>
                            <th>Status</th>
                            <th>Cost</th>
                            <th>MRP</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            tableHTML += tablets.map(t => {
                let statusBadge = `<span class="status-badge badge-success">In Stock</span>`;
                if (t.stock === 0) {
                    statusBadge = `<span class="status-badge badge-error">Out of Stock</span>`;
                } else if (t.stock <= t.reorder) {
                    statusBadge = `<span class="status-badge badge-warning">Low Stock</span>`;
                }
                return `
                    <tr style="cursor: pointer;" onclick="window.app.updateRightSidebarDetails('${t.name}')">
                        <td><strong>${t.name}</strong></td>
                        <td>${t.drugName}</td>
                        <td>${t.stock} Packs</td>
                        <td>${statusBadge}</td>
                        <td>₹${t.cost}</td>
                        <td>₹${t.mrp}</td>
                    </tr>
                `;
            }).join("");
            tableHTML += `
                    </tbody>
                </table>
            `;
            container.innerHTML = tableHTML;
        }

        sendQuickSuggestion(text) {
            const chatInput = document.getElementById("ai-chat-input");
            if (chatInput) {
                chatInput.value = text;
                chatInput.focus();
                chatInput.dispatchEvent(new Event("input"));
            }
        }

        appendChatBubble(text, sender) {
            const chatMessages = document.getElementById("ai-chat-messages");
            if (!chatMessages) return;

            const msgDiv = document.createElement("div");
            msgDiv.className = `message ${sender}-message`;
            msgDiv.style.display = "flex";
            msgDiv.style.gap = "12px";
            msgDiv.style.alignItems = "flex-start";
            
            const avatarDiv = document.createElement("div");
            avatarDiv.className = "msg-avatar-circle";
            avatarDiv.style.width = "34px";
            avatarDiv.style.height = "34px";
            avatarDiv.style.borderRadius = "50%";
            avatarDiv.style.background = "#e8f0fe";
            avatarDiv.style.display = "flex";
            avatarDiv.style.alignItems = "center";
            avatarDiv.style.justifyContent = "center";
            avatarDiv.style.color = "#0b57d0";
            avatarDiv.style.flexShrink = "0";

            if (sender === "user") {
                avatarDiv.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
            } else {
                avatarDiv.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4M8 15h.01M16 15h.01M12 16v2"></path></svg>`;
            }

            const bodyContainer = document.createElement("div");
            bodyContainer.style.flex = "1";
            bodyContainer.style.overflow = "hidden";

            const metaHeader = document.createElement("div");
            metaHeader.style.fontSize = "0.75rem";
            metaHeader.style.fontWeight = "700";
            metaHeader.style.color = "#64748b";
            metaHeader.style.marginBottom = "4px";
            
            const timeSpan = document.createElement("span");
            timeSpan.style.fontWeight = "500";
            timeSpan.style.marginLeft = "6px";
            timeSpan.style.color = "#94a3b8";
            const now = new Date();
            timeSpan.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            if (sender === "user") {
                metaHeader.textContent = "You ";
            } else {
                metaHeader.textContent = "AI Assistant ";
            }
            metaHeader.appendChild(timeSpan);

            const contentDiv = document.createElement("div");
            contentDiv.className = "message-content";
            if (sender === "user") {
                contentDiv.style.background = "#e8f0fe";
                contentDiv.style.border = "1px solid #c2dbff";
                contentDiv.style.borderRadius = "8px";
                contentDiv.style.padding = "12px 16px";
                contentDiv.style.fontSize = "0.88rem";
                contentDiv.style.color = "#1e293b";
                contentDiv.style.fontWeight = "500";
                contentDiv.style.maxWidth = "85%";
            } else {
                contentDiv.style.fontSize = "0.88rem";
                contentDiv.style.color = "#1e293b";
                contentDiv.style.fontWeight = "500";
                contentDiv.style.lineHeight = "1.5";
            }
            
            let formattedText = text;
            if (text.includes("ai-medicine-card") || text.includes("<div class=") || text.includes("<table")) {
                formattedText = text.replace(/\r?\n|\r/g, "");
            } else {
                formattedText = text
                    .replace(/&/g, "&amp;")
                    .replace(/</g, "&lt;")
                    .replace(/>/g, "&gt;")
                    .replace(/^### (.*?)$/gm, "<h3>$1</h3>")
                    .replace(/^## (.*?)$/gm, "<h2>$1</h2>")
                    .replace(/^# (.*?)$/gm, "<h1>$1</h1>")
                    .replace(/^\*\s+(.*?)$/gm, "• $1")
                    .replace(/\n/g, "<br>")
                    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
                    .replace(/\*(.*?)\*/g, "<em>$1</em>")
                    .replace(/`([^`]+)`/g, "<code>$1</code>")
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" style="color:#00F2FE;">$1</a>');
            }

            contentDiv.innerHTML = formattedText;

            bodyContainer.appendChild(metaHeader);
            bodyContainer.appendChild(contentDiv);
            
            msgDiv.appendChild(avatarDiv);
            msgDiv.appendChild(bodyContainer);
            chatMessages.appendChild(msgDiv);

            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        getLocalSearchResponse(text) {
            const words = text.toUpperCase();
            const tablets = this.getTablets();
            let matchedTab = null;

            // Common utility functions localized
            function getCleanBrandName(name) {
                let clean = name;
                const prefixes = [
                    "USV L.", "USV", "PHAR", "GRAN", "LUPIN", "REDD", "AVEN", 
                    "SUN P", "PRINC", "PENIS", "MANK", "APEX", "IPCAL", "ALCO", "INTAS", 
                    "GLEN", "MICR", "ALLE", "SUNW", "NOVA", "ANGL", "GERM", "LINK", 
                    "CIPLA", "RANB", "MSD"
                ];
                for (let pref of prefixes) {
                    const regex = new RegExp("^" + pref.replace(".", "\\.") + "\\s+", "i");
                    clean = clean.replace(regex, "");
                }
                clean = clean.replace(/\b(2.5|5|10|20|40|50|100|250|500|650)\s*(MG|G)?\b/i, "");
                clean = clean.replace(/\b(TAB|TABS|CAP|CAPS|EYE DROP|EYE DROPS|15GM|DROP|DROPS|SYP)\b/i, "");
                clean = clean.replace(/\s+/g, " ").trim();
                return clean.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
            }

            function getSaltComposition(drugName) {
                const salts = {
                    "ROSUVASTATIN": "Rosuvastatin Calcium",
                    "METFORMIN": "Metformin Hydrochloride",
                    "AMLODIPINE": "Amlodipine Besylate",
                    "ATORVASTATIN": "Atorvastatin Calcium",
                    "TELMISARTAN": "Telmisartan",
                    "GLIMEPIRIDE": "Glimepiride",
                    "VOGLIBOSE": "Voglibose",
                    "METHYLCOBALAMIN": "Methylcobalamin",
                    "GLICLAZIDE": "Gliclazide"
                };
                const key = drugName.toUpperCase();
                if (salts[key]) return salts[key];
                if (key.includes(" + ")) {
                    return drugName.split(" + ").map(d => salts[d.toUpperCase()] || d).join(" + ");
                }
                return drugName;
            }

            function getDosageForm(name, pack) {
                const n = name.toUpperCase();
                const p = pack.toUpperCase();
                if (n.includes("EYE DROP") || n.includes("EYE DROPS")) return "Eye Drops";
                if (n.includes("DROP") || n.includes("DROPS")) return "Drops";
                if (n.includes("GEL") || n.includes("OINTMENT") || n.includes("CREAM")) return "Gel/Ointment";
                if (n.includes("SYP") || n.includes("SYRUP") || n.includes("SUSPENSION")) return "Syrup";
                if (n.includes("CAP") || n.includes("CAPS") || n.includes("CAPSULE") || n.includes("CAPSULES")) return "Capsule";
                if (p.includes("STRIP") || p.includes("'S") || n.includes("TAB") || n.includes("TABLET") || n.includes("TABLETS")) return "Tablet";
                return "Tablet";
            }

            const POPULAR_ALTERNATIVES = {
                "ROSUVASTATIN": [
                    { name: "Rozat", brand: "Dr. Reddy's" },
                    { name: "Rosulip", brand: "Cipla" },
                    { name: "Rosuvas", brand: "Sun Pharma" },
                    { name: "Novastat", brand: "Lupin" },
                    { name: "Rozavel", brand: "Sun Pharma" }
                ],
                "METFORMIN": [
                    { name: "Gluformin", brand: "Abbott" },
                    { name: "Obimet", brand: "Abbott" },
                    { name: "Metfor", brand: "Cipla" },
                    { name: "Glyciphage", brand: "Franco-Indian" }
                ],
                "TELMISARTAN": [
                    { name: "Telma", brand: "Glenmark" },
                    { name: "Arbitel", brand: "Micro Labs" },
                    { name: "Telvas", brand: "Aristo" },
                    { name: "Telmikind", brand: "Mankind" }
                ],
                "AMLODIPINE": [
                    { name: "Amlopin", brand: "USV" },
                    { name: "Amlodac", brand: "Zydus" },
                    { name: "Stamlo", brand: "Dr. Reddy's" },
                    { name: "Amlovas", brand: "Macleods" }
                ],
                "ATORVASTATIN": [
                    { name: "Lipitor", brand: "Pfizer" },
                    { name: "Atorva", brand: "Zydus" },
                    { name: "Tonact", brand: "Lupin" },
                    { name: "Lipvas", brand: "Cipla" }
                ],
                "VOGLIBOSE": [
                    { name: "Volibo", brand: "Sun Pharma" },
                    { name: "Vobose", brand: "Micro Labs" },
                    { name: "Voglistar", brand: "Mankind" }
                ],
                "GLIMEPIRIDE + METFORMIN": [
                    { name: "Gemer", brand: "Sun Pharma" },
                    { name: "Gluconorm G", brand: "Lupin" },
                    { name: "Amaryl M", brand: "Sanofi" },
                    { name: "Glycomet GP", brand: "USV" }
                ],
                "METHYLCOBALAMIN": [
                    { name: "Nurokind", brand: "Mankind" },
                    { name: "Mecobon", brand: "Bonitas" },
                    { name: "Renerve Plus", brand: "Grandix" }
                ]
            };
            
            // Try exact matching by word tokens
            for (let t of tablets) {
                const nameUpper = t.name.toUpperCase();
                const nameParts = nameUpper.split(" ");
                if (words.includes(nameUpper) || nameParts.some(w => w.length > 3 && words.includes(w))) {
                    matchedTab = t;
                    break;
                }
            }
            
            // Try matching generic drug composition
            if (!matchedTab) {
                for (let t of tablets) {
                    const drugUpper = (t.drugName || "").toUpperCase();
                    if (drugUpper && words.includes(drugUpper)) {
                        matchedTab = t;
                        break;
                    }
                }
            }

            // Fallback default to Roseday if user searches for "Roseday" specifically
            if (!matchedTab && (words.includes("ROSEDAY") || words.includes("ROSUB") || words.includes("ROSAT"))) {
                matchedTab = tablets.find(t => t.name.toUpperCase().includes("ROSEDAY")) || tablets[0];
            }

            if (matchedTab) {
                const generic = matchedTab.drugName || "Rosuvastatin";
                
                // Parse strength from user text or database item
                let strength = "10 mg";
                const queryStrengthMatch = text.match(/\b(2.5|5|10|20|40|50|100|250|500|650)\s*(MG|G)?\b/i);
                if (queryStrengthMatch) {
                    strength = queryStrengthMatch[1] + " " + (queryStrengthMatch[2] || "mg").toLowerCase();
                } else {
                    const dbStrengthMatch = matchedTab.name.match(/\b(2.5|5|10|20|40|50|100|250|500|650)\s*(MG|G)\b/i);
                    if (dbStrengthMatch) {
                        strength = dbStrengthMatch[1] + " " + dbStrengthMatch[2].toLowerCase();
                    }
                }

                const dosageForm = getDosageForm(matchedTab.name, matchedTab.pack);
                const brandName = getCleanBrandName(matchedTab.name) + " " + strength.split(" ")[0];
                const saltComposition = getSaltComposition(generic);

                // Find local alternatives
                let alts = tablets.filter(t => 
                    getCleanBrandName(t.name).toUpperCase() !== getCleanBrandName(matchedTab.name).toUpperCase() &&
                    (t.drugName || "").toUpperCase() === generic.toUpperCase()
                );

                // Find popular alternatives
                const popAlts = POPULAR_ALTERNATIVES[generic.toUpperCase()] || [];

                let mergedAlts = [];
                let seen = new Set();

                // Add local ones
                for (let a of alts) {
                    const cleanAltBrand = getCleanBrandName(a.name);
                    const key = cleanAltBrand.toUpperCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        let altStrength = strength;
                        const altDbStrengthMatch = a.name.match(/\b(2.5|5|10|20|40|50|100|250|500|650)\s*(MG|G)\b/i);
                        if (altDbStrengthMatch) {
                            altStrength = altDbStrengthMatch[1] + " " + altDbStrengthMatch[2].toLowerCase();
                        }
                        mergedAlts.push({
                            name: cleanAltBrand + " " + altStrength.split(" ")[0],
                            manufacturer: a.brand
                        });
                    }
                }

                // Add popular ones
                const cleanMatchedBrand = getCleanBrandName(matchedTab.name).toUpperCase();
                for (let pa of popAlts) {
                    const key = pa.name.toUpperCase();
                    if (!seen.has(key) && key !== cleanMatchedBrand) {
                        seen.add(key);
                        mergedAlts.push({
                            name: pa.name + " " + strength.split(" ")[0],
                            manufacturer: pa.brand
                        });
                    }
                }

                // Format alternatives list
                let altsList = "";
                if (mergedAlts.length > 0) {
                    altsList = mergedAlts.map(a => `* ${a.name} (${a.manufacturer})`).join("\n");
                } else {
                    altsList = "No verified equivalent brands were found.";
                }

                return {
                    success: true,
                    text: `**Medicine:** ${brandName}\n\n**Generic Name:** ${generic}\n\n**Salt Composition:** ${saltComposition}\n\n**Strength:** ${strength}\n\n**Manufacturer:** ${matchedTab.brand || "Unknown"}\n\n**Available Alternative Brands:**\n${altsList}\n\n**Source:** Local Inventory Database\n\n**Confidence Level:** High (Verified Local Match)`
                };
            }
            
            // Check if medical advice questions are asked
            if (words.includes("TAKE") || words.includes("DIAGNOSE") || words.includes("TREAT") || words.includes("PRESCRIPTION")) {
                return {
                    success: true,
                    text: "I can provide medicine information and inventory details, but treatment decisions should be made by a qualified healthcare professional."
                };
            }
            
            return {
                success: false,
                text: "No verified equivalent brands were found."
            };
        }

        updateDynamicSuggestions(text) {
            const suggestionsList = document.getElementById("ai-suggestions-list");
            if (suggestionsList) {
                const words = text.toUpperCase();
                let suggestionsHTML = "";
                if (words.includes("ROSEDAY") || words.includes("ROSUB") || words.includes("ALTERNATIVE")) {
                    suggestionsHTML = `
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Compare prices of Roseday alternatives')">Compare prices of alternatives</button>
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Show chemical composition of Rosuvastatin')">Show composition details</button>
                        <button class="sq-chip" onclick="window.app.sendChatMessage('View stock metrics for Rozat 10')">View stock levels</button>
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Who is the distributor of USV medicines?')">Supplier details</button>
                    `;
                } else {
                    suggestionsHTML = `
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Find equivalents for this brand')">Find Alternatives</button>
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Verify interaction warnings')">Drug Interactions</button>
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Show chemical name and structure')">Chemical Info</button>
                        <button class="sq-chip" onclick="window.app.sendChatMessage('Add item to active buy sheet')">Generate Order</button>
                    `;
                }
                suggestionsList.innerHTML = suggestionsHTML;
            }
        }

        async sendChatMessage(text) {
            this.appendChatBubble(text, "user");

            const apiKey = localStorage.getItem("ti_ai_key");
            if (!apiKey) {
                const fallback = this.getLocalSearchResponse(text);
                this.appendChatBubble(fallback.text, "bot");
                this.updateDynamicSuggestions(text);
                return;
            }

            // Append typing indicator
            const chatMessages = document.getElementById("ai-chat-messages");
            const typingDiv = document.createElement("div");
            typingDiv.className = "message bot-message typing-indicator";
            typingDiv.innerHTML = `<div class="message-content"><em>AI is thinking...</em></div>`;
            if (chatMessages) {
                chatMessages.appendChild(typingDiv);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }

            try {
                const dbContext = this.getCurrentDatabaseContext();
                
                const systemPrompt = `# Pharmacy AI with Live Google Search

You are an enterprise Pharmacy AI Assistant.

When the user asks about any medicine, brand, generic name, composition, alternative brand, manufacturer, dosage, or pharmaceutical information, always perform a live web search using the connected Google Search service before answering.

Workflow:

1. Search the local pharmacy inventory.
2. Search the local medicine database.
3. If the information is not found, perform a live Google search.
4. Collect information from reliable pharmaceutical and medical sources.
5. Compare multiple trusted sources.
6. Return only verified information.

For alternative medicines:

* Identify the active ingredient.
* Match the same strength.
* Match the same dosage form.
* Match the same route of administration.
* Display equivalent brands.

Never invent medicine names or alternatives.

If trusted sources disagree, tell the user that multiple references provide different information.

Always include the source used to generate the answer.

Display results in this format:

**Medicine:** <Brand Name or Query Name>

**Generic Name:** <Generic Name / Active Ingredient>

**Salt Composition:** <Salt Composition>

**Strength:** <Strength>

**Manufacturer:** <Manufacturer / Brand Owner>

**Available Alternative Brands:**
* <Brand 1> (Manufacturer 1)
* <Brand 2> (Manufacturer 2)
* ...

**Source:** <Sources used, e.g. web domain, database name, etc.>

**Confidence Level:** <Confidence level, e.g. High, Medium, Low with details>

SYSTEM STATE (LIVE DATABASE):
-----------------------------
INVENTORY ITEMS: ${JSON.stringify(dbContext.inventory, null, 2)}
PENDING DUE ORDERS: ${JSON.stringify(dbContext.due_orders, null, 2)}
RECENT LOGS: ${JSON.stringify(dbContext.recent_history, null, 2)}
CURRENT TIME: ${dbContext.current_time}
-----------------------------`;

                const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    { text: systemPrompt },
                                    { text: `User request: ${text}` }
                                ]
                            }
                        ],
                        tools: [
                            {
                                google_search: {}
                            }
                        ],
                        generationConfig: {
                            maxOutputTokens: 1000
                        }
                    })
                });

                if (typingDiv && typingDiv.parentNode) {
                    typingDiv.parentNode.removeChild(typingDiv);
                }

                if (!response.ok) {
                    const errData = await response.json().catch(() => ({}));
                    const errMsg = errData.error?.message || `HTTP ${response.status}`;
                    console.warn(`Gemini API connection error (${errMsg}). Falling back to local grounded database search.`);
                    const fallback = this.getLocalSearchResponse(text);
                    this.appendChatBubble(fallback.text, "bot");
                    this.updateDynamicSuggestions(text);
                    return;
                }

                const data = await response.json();
                const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response content.";
                this.appendChatBubble(aiText, "bot");

                // Dynamic update of suggested chips below bot responses
                this.updateDynamicSuggestions(text);

            } catch (err) {
                console.error("AI Assistant response failed, falling back to local grounded database:", err);
                if (typingDiv && typingDiv.parentNode) {
                    typingDiv.parentNode.removeChild(typingDiv);
                }
                const fallback = this.getLocalSearchResponse(text);
                this.appendChatBubble(fallback.text, "bot");
                this.updateDynamicSuggestions(text);
            }
        }
    }

    // ============================================================
    // CLOUD AUTH GATE + BOOT SEQUENCE
    // ============================================================
    function clearLoginMessages() {
        ["login-error", "km-access-denied-box", "km-login-success-box"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = "none";
        });
    }
    function showLoginError(msg) {
        clearLoginMessages();
        const el = document.getElementById("login-error");
        if (el) { el.textContent = msg; el.style.display = "block"; }
        shakeLoginCard();
    }
    function showAccessDenied(msg) {
        clearLoginMessages();
        const box = document.getElementById("km-access-denied-box");
        const text = document.getElementById("km-access-denied-text");
        if (text) text.textContent = msg;
        if (box) box.style.display = "flex";
        shakeLoginCard();
    }
    function showLoginSuccessBriefly() {
        clearLoginMessages();
        const box = document.getElementById("km-login-success-box");
        if (box) box.style.display = "block";
    }
    function shakeLoginCard() {
        const card = document.getElementById("km-login-card");
        if (!card) return;
        card.classList.remove("km-shake");
        void card.offsetWidth; // restart animation
        card.classList.add("km-shake");
    }
    function setLoginStatus(msg) {
        const el = document.getElementById("login-status");
        if (el) el.textContent = msg;
    }
    function showAppAfterAuth() {
        const loginScreen = document.getElementById("login-screen");
        const appContainer = document.getElementById("app-container");
        if (loginScreen) loginScreen.style.display = "none";
        if (appContainer) appContainer.style.display = "";
    }

    async function bootAppAfterAuth() {
        setLoginStatus("Syncing with cloud database...");
        const result = await hydrateFromCloud();
        await hydrateWorkflowsFromCloud();
        showAppAfterAuth();
        window.app = new TabletInventoryApp();
        if (!result.ok && supabaseClient) {
            window.app.triggerNotification(
                "Inventory", "Cloud synchronization failure",
                `🔴 Cloud Sync Failure\nCould not load the latest data from the cloud on startup: ${result.reason}\nShowing last locally cached data instead. Changes you make now will keep retrying to sync.`,
                "Critical", {}
            );
        }

        if (supabaseClient) {
            await window.app.loadUserProfile();
            window.app.applyRolePermissions();
            window.app.initSessionTimeoutWatcher();
            window.app.logActivityEvent("Login", {});
            initRealtimeSync();
            window.app.initInventoryRealtimeSync();
            window.app.initWorkflowRealtimeSync();
            flushPendingSync();
        }
    }

    window.handleLoginSubmit = async function() {
        const identifier = document.getElementById("login-email").value.trim();
        const password = document.getElementById("login-password").value;
        const rememberMe = document.getElementById("login-remember-me").checked;
        const selectedRole = window.__selectedLoginRole;
        clearLoginMessages();

        if (!selectedRole) { showLoginError("Please select your role first."); return; }
        if (!identifier || !password) { showLoginError("Please enter both User ID and password."); return; }

        if (!supabaseClient) {
            showLoginError("Cloud login is not configured yet. Add your Supabase URL/anon key in app.js (SUPABASE_URL / SUPABASE_ANON_KEY).");
            return;
        }

        const btn = document.getElementById("login-submit-btn");
        if (btn) { btn.disabled = true; btn.textContent = "Signing in..."; }
        setLoginStatus("");

        try {
            // 0. Reject immediately if the account is already locked/disabled —
            // don't even attempt the password check.
            const { data: accountStatus, error: statusErr } = await supabaseClient.rpc("get_account_status", { emp_id: identifier });
            if (statusErr) {
                console.error("[Login] get_account_status RPC failed:", statusErr);
                throw new Error(`Could not reach the account-status check: ${statusErr.message}`);
            }
            if (accountStatus === "Locked") {
                throw new Error("Account Locked. Please contact your Administrator.");
            }
            if (accountStatus === "Disabled") {
                throw new Error("This account has been disabled. Please contact your Administrator.");
            }
            if (!accountStatus) {
                // Not necessarily fatal — the identifier might be an email that simply
                // isn't in `profiles` yet, or might be an Employee ID we still need to
                // resolve below. Log it so it's visible in DevTools either way.
                console.warn("[Login] get_account_status returned no row for:", identifier);
            }

            // 1. Resolve identifier -> email (accepts either a User ID or an email)
            let email = identifier;
            if (!identifier.includes("@")) {
                const { data: resolvedEmail, error: rpcErr } = await supabaseClient.rpc("get_email_for_employee_id", { emp_id: identifier });
                if (rpcErr) {
                    console.error("[Login] get_email_for_employee_id RPC failed:", rpcErr);
                    throw new Error(`Could not resolve User ID: ${rpcErr.message}`);
                }
                if (!resolvedEmail) {
                    throw new Error("No active account found for that User ID.");
                }
                email = resolvedEmail;
            }

            // 2. Verify the password via Supabase Auth
            const { error: signInErr } = await supabaseClient.auth.signInWithPassword({ email, password });
            if (signInErr) {
                console.error("[Login] signInWithPassword failed:", signInErr.status, signInErr.message, signInErr);
                const lockResult = await supabaseClient.rpc("register_failed_login", { emp_id: identifier });
                if (lockResult && lockResult.data === "locked") {
                    throw new Error("Account Locked after 5 failed attempts. Please contact your Administrator.");
                }
                // Surface Supabase's own reason (e.g. "Invalid login credentials",
                // "Email not confirmed") instead of always saying the same generic
                // thing — that's what was making this impossible to diagnose.
                throw new Error(`Sign-in rejected by Supabase: ${signInErr.message}`);
            }

            // 3. Password correct — now verify the selected role EXACTLY matches
            // the role stored against this account. Mismatch = deny, even though
            // the password was right.
            const { data: sessionData } = await supabaseClient.auth.getSession();
            const uid = sessionData.session.user.id;
            const { data: profile, error: profileErr } = await supabaseClient.from("profiles").select("*").eq("id", uid).single();

            if (profileErr || !profile) {
                console.error("[Login] profile fetch failed for uid:", uid, profileErr);
                await supabaseClient.auth.signOut();
                throw new Error(profileErr ? `No staff profile found: ${profileErr.message}` : "No staff profile found for this account. Contact your Administrator.");
            }
            if (profile.status === "Disabled") {
                await supabaseClient.auth.signOut();
                throw new Error("This account has been disabled. Please contact your Administrator.");
            }
            if (profile.role !== selectedRole) {
                await logFailedLoginGlobal(identifier);
                await supabaseClient.auth.signOut();
                if (btn) { btn.disabled = false; btn.textContent = "Login"; }
                showAccessDenied("Access Denied. The selected role does not match your assigned account.");
                return;
            }

            // 3b. Forced password change — if the profile still has
            // must_change_password = true (set by create-user or an admin
            // password reset), the user must set their own password before
            // they ever reach bootAppAfterAuth(). This runs with a live,
            // valid session (needed for auth.updateUser to succeed), but
            // nothing past this point is reachable until it resolves.
            if (profile.must_change_password === true) {
                showLoginSuccessBriefly();
                const changed = await forcePasswordChangeGate(uid);
                if (!changed) {
                    // User backed out (closed tab / failed irrecoverably) — the
                    // gate itself signs the session out before returning false,
                    // so it is safe to just stop here.
                    if (btn) { btn.disabled = false; btn.textContent = "Login"; }
                    return;
                }
            }

            // 4. All checks passed
            await supabaseClient.rpc("register_successful_login", { emp_id: identifier });
            localStorage.setItem("ti_remember_me", rememberMe ? "1" : "0");
            showLoginSuccessBriefly();
            setTimeout(() => { bootAppAfterAuth(); }, 700);
        } catch (err) {
            await logFailedLoginGlobal(identifier);
            showLoginError(err.message || "Sign in failed. Check your User ID and password.");
            if (btn) { btn.disabled = false; btn.textContent = "Login"; }
        }
    };

    // ============================================================
    // FORCED PASSWORD CHANGE GATE
    // Blocks access until the user sets a new password. Renders its own
    // modal (no dependency on index.html markup existing ahead of time),
    // has no close/cancel control, and traps Escape/backdrop clicks so it
    // cannot be dismissed without either succeeding or signing out.
    // Resolves true only after both auth.updateUser() and the profiles
    // update to must_change_password = false have both succeeded.
    // ============================================================
    function forcePasswordChangeGate(uid) {
        return new Promise((resolve) => {
            clearLoginMessages();
            const loginScreen = document.getElementById("login-screen");
            if (loginScreen) loginScreen.style.display = "none";

            const overlay = document.createElement("div");
            overlay.id = "force-pw-change-overlay";
            overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(10,14,20,0.92);display:flex;align-items:center;justify-content:center;font-family:inherit;";
            overlay.innerHTML = `
                <div style="background:#12181f;border:1px solid #263140;border-radius:14px;padding:32px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
                    <h2 style="margin:0 0 6px;color:#fff;font-size:1.25rem;">Set a New Password</h2>
                    <p style="margin:0 0 20px;color:#9aa7b5;font-size:0.85rem;">For security, you must set your own password before continuing. This cannot be skipped.</p>
                    <label style="display:block;color:#c8d1db;font-size:0.8rem;margin-bottom:6px;">New Password</label>
                    <input id="force-pw-new" type="password" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2c3947;background:#0c1116;color:#fff;margin-bottom:14px;" />
                    <label style="display:block;color:#c8d1db;font-size:0.8rem;margin-bottom:6px;">Confirm New Password</label>
                    <input id="force-pw-confirm" type="password" autocomplete="new-password" style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2c3947;background:#0c1116;color:#fff;margin-bottom:8px;" />
                    <div id="force-pw-error" style="display:none;color:#ff6b6b;font-size:0.8rem;margin-bottom:10px;"></div>
                    <button id="force-pw-submit" style="width:100%;padding:11px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-weight:600;cursor:pointer;">Set Password & Continue</button>
                    <button id="force-pw-signout" style="width:100%;margin-top:8px;padding:9px;border:none;border-radius:8px;background:transparent;color:#8b96a3;font-size:0.8rem;cursor:pointer;">Sign out instead</button>
                </div>
            `;
            document.body.appendChild(overlay);

            // Block Escape from closing anything and block backdrop clicks —
            // the overlay itself has no listener that removes it on click.
            const escBlocker = (e) => { if (e.key === "Escape") e.stopPropagation(); };
            document.addEventListener("keydown", escBlocker, true);

            const cleanup = () => {
                document.removeEventListener("keydown", escBlocker, true);
                overlay.remove();
            };

            const errEl = overlay.querySelector("#force-pw-error");
            const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = "block"; };

            overlay.querySelector("#force-pw-signout").addEventListener("click", async () => {
                try { await supabaseClient.auth.signOut(); } catch (e) { /* best-effort */ }
                cleanup();
                if (loginScreen) loginScreen.style.display = "";
                resolve(false);
            });

            overlay.querySelector("#force-pw-submit").addEventListener("click", async () => {
                const pw1 = overlay.querySelector("#force-pw-new").value;
                const pw2 = overlay.querySelector("#force-pw-confirm").value;
                errEl.style.display = "none";

                if (!pw1 || pw1.length < 6) { showErr("Password must be at least 6 characters."); return; }
                if (pw1 !== pw2) { showErr("Passwords do not match."); return; }

                const submitBtn = overlay.querySelector("#force-pw-submit");
                submitBtn.disabled = true;
                submitBtn.textContent = "Saving...";

                try {
                    // 1. Actually change the auth password (secure — goes through
                    // Supabase Auth using the current live session, never a raw
                    // table write).
                    const { error: updErr } = await supabaseClient.auth.updateUser({ password: pw1 });
                    if (updErr) throw new Error(updErr.message || "Could not update password.");

                    // 2. Clear the flag so this gate does not re-trigger next login.
                    const { error: profErr } = await supabaseClient
                        .from("profiles")
                        .update({ must_change_password: false })
                        .eq("id", uid);
                    if (profErr) throw new Error(`Password was changed, but the profile flag update failed: ${profErr.message}. Contact your Administrator.`);

                    cleanup();
                    resolve(true);
                } catch (err) {
                    showErr(err.message || "Something went wrong.");
                    submitBtn.disabled = false;
                    submitBtn.textContent = "Set Password & Continue";
                }
            });
        });
    }

    window.__supabaseSignOut = async function() {
        if (supabaseClient) {
            await supabaseClient.auth.signOut();
        }
    };

    async function initAuthGate() {
        // Kick off the animated welcome splash regardless of auth state — it's a
        // pure UI intro, then it hands off to the login screen underneath.
        window.initKmBackgroundScene("splash-bg-scene");
        window.initKmBackgroundScene("login-bg-scene");
        setTimeout(() => {
            const splash = document.getElementById("welcome-splash");
            if (splash) splash.classList.add("splash-hidden");
        }, 2800);

        if (!supabaseClient) {
            // No Supabase credentials configured yet: run in local-only mode so the
            // app is never permanently locked out before setup is complete.
            console.warn("Supabase not configured (SUPABASE_URL/SUPABASE_ANON_KEY) — running in local-only mode, no cloud sync or login.");
            showAppAfterAuth();
            window.app = new TabletInventoryApp();
            return;
        }

        setLoginStatus("Checking session...");
        try {
            const { data } = await supabaseClient.auth.getSession();
            if (data && data.session) {
                await bootAppAfterAuth();
            } else {
                setLoginStatus("");
            }
        } catch (err) {
            console.error("Session check failed:", err);
            setLoginStatus("");
        }
    }

    // Boot
    if (document.readyState === "complete" || document.readyState === "interactive") {
        initAuthGate();
    } else {
        window.addEventListener("DOMContentLoaded", initAuthGate);
    }

})();
