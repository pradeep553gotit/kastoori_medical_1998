// Supabase Edge Function: create-user
// Deploy with: supabase functions deploy create-user
//
// Called by the app when an Administrator creates a new staff account.
// Runs server-side with the service_role key (never exposed to the browser).
// Verifies the CALLER is a signed-in Administrator before doing anything.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
    const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
    };
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    try {
        const authHeader = req.headers.get("Authorization") || "";
        const callerToken = authHeader.replace("Bearer ", "");

        // Client scoped to the caller's own token, used only to verify who they are.
        const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
            global: { headers: { Authorization: authHeader } },
        });
        const { data: userData, error: userErr } = await callerClient.auth.getUser(callerToken);
        if (userErr || !userData?.user) {
            return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: cors });
        }

        // Admin client with full privileges, used for all the actual work below.
        const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        const { data: callerProfile } = await admin
            .from("profiles")
            .select("role, status, full_name, employee_id")
            .eq("id", userData.user.id)
            .single();

        if (!callerProfile || callerProfile.role !== "Administrator" || callerProfile.status !== "Active") {
            return new Response(JSON.stringify({ error: "Only Administrators can create users." }), { status: 403, headers: cors });
        }

        const body = await req.json();
        const { employeeId, fullName, email, mobile, department, role, tempPassword } = body;

        if (!employeeId || !fullName || !email || !role || !tempPassword) {
            return new Response(JSON.stringify({ error: "Missing required fields." }), { status: 400, headers: cors });
        }
        if (!["Administrator", "Senior Officer", "Staff"].includes(role)) {
            return new Response(JSON.stringify({ error: "Invalid role." }), { status: 400, headers: cors });
        }

        // Create the actual auth user
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
            email,
            password: tempPassword,
            email_confirm: true,
        });
        if (createErr) {
            return new Response(JSON.stringify({ error: createErr.message }), { status: 400, headers: cors });
        }

        // Create the matching profile row (the admin_can_read_all_profiles /
        // admin_can_update_profiles RLS policies allow this insert to be read/managed
        // later; the insert itself runs with service_role so RLS is bypassed here)
        const { error: profileErr } = await admin.from("profiles").insert({
            id: created.user.id,
            employee_id: employeeId,
            full_name: fullName,
            email,
            mobile: mobile || null,
            department: department || null,
            role,
            status: "Active",
            must_change_password: true,
            created_by: userData.user.id,
        });

        if (profileErr) {
            // Roll back the auth user if the profile insert failed (e.g. max-2-admin trigger fired)
            await admin.auth.admin.deleteUser(created.user.id);
            return new Response(JSON.stringify({ error: profileErr.message }), { status: 400, headers: cors });
        }

        return new Response(JSON.stringify({ ok: true, id: created.user.id }), { status: 200, headers: cors });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message || "Unknown error" }), { status: 500, headers: cors });
    }
});
