// Supabase Edge Function: reset-password
// Deploy with: supabase functions deploy reset-password
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

        const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
            global: { headers: { Authorization: authHeader } },
        });
        const { data: userData, error: userErr } = await callerClient.auth.getUser(callerToken);
        if (userErr || !userData?.user) {
            return new Response(JSON.stringify({ error: "Not authenticated." }), { status: 401, headers: cors });
        }

        const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
        const { data: callerProfile } = await admin
            .from("profiles").select("role, status").eq("id", userData.user.id).single();

        if (!callerProfile || callerProfile.role !== "Administrator" || callerProfile.status !== "Active") {
            return new Response(JSON.stringify({ error: "Only Administrators can reset passwords." }), { status: 403, headers: cors });
        }

        const { targetUserId, newPassword } = await req.json();
        if (!targetUserId || !newPassword) {
            return new Response(JSON.stringify({ error: "Missing targetUserId or newPassword." }), { status: 400, headers: cors });
        }

        const { error: updErr } = await admin.auth.admin.updateUserById(targetUserId, { password: newPassword });
        if (updErr) {
            return new Response(JSON.stringify({ error: updErr.message }), { status: 400, headers: cors });
        }

        await admin.from("profiles").update({ must_change_password: true }).eq("id", targetUserId);

        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message || "Unknown error" }), { status: 500, headers: cors });
    }
});
