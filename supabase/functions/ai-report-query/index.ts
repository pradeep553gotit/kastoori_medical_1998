// Supabase Edge Function: ai-report-query
// Deploy with: supabase functions deploy ai-report-query
// Requires secrets (set with `supabase secrets set`):
//   ANTHROPIC_API_KEY   — server-side only, never sent to the browser
//   LLM_PROVIDER        — optional, defaults to "anthropic" (see callLLM below)
//
// Architecture:
//   User Question -> AI Reporting UI -> Edge Function (this file)
//     -> Schema Knowledge Layer (schema-knowledge.json, loaded below)
//     -> Business Rules Layer (buildSystemPrompt, same file, from JSON)
//     -> LLM (callLLM — provider-agnostic adapter)
//     -> SQL Validator (validateSql, same file)
//     -> Supabase (execute_ai_report_sql RPC — the real security boundary)
//     -> Formatter (buildQueryResponse / buildExplainResponse)
//
// Two actions, one endpoint:
//   { action: "query",   question }              -> NL -> SQL -> rows
//   { action: "explain", question, columns, rows } -> plain-language summary of an already-fetched result

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// ================================================================
// Schema Knowledge Layer — loaded from schema-knowledge.json, which is
// deployed alongside this function. Add a table/view/relationship there
// and it's picked up automatically; this file never needs to change for
// ordinary schema growth.
// ================================================================
let schemaKnowledge = null;
async function loadSchemaKnowledge() {
    if (schemaKnowledge) return schemaKnowledge;
    const text = await Deno.readTextFile(new URL("./schema-knowledge.json", import.meta.url));
    schemaKnowledge = JSON.parse(text);
    return schemaKnowledge;
}

function describeColumns(columns) {
    return columns.map((c) => {
        let bits = `${c.name} ${c.type}`;
        if (c.pk) bits += " [PK]";
        if (c.references) bits += ` [FK -> ${c.references}]`;
        if (c.enum) bits += ` [values: ${c.enum.join("|")}]`;
        return bits;
    }).join(", ");
}

// Business Rules Layer: turns the structured JSON into the natural-language
// system prompt the LLM actually reads. Kept as its own function so the
// "rules" half (how to phrase things to the model) can evolve separately
// from the "facts" half (schema-knowledge.json).
function buildSystemPrompt(schema) {
    const tableLines = schema.tables.map((t) =>
        `- ${t.name}(${describeColumns(t.columns)}) -- ${t.description}${t.aliases ? ` [aka: ${t.aliases.join(", ")}]` : ""}`
    ).join("\n");
    const viewLines = schema.views.map((v) =>
        `- ${v.name}(${describeColumns(v.columns)}) -- ${v.description}${v.aliases ? ` [aka: ${v.aliases.join(", ")}]` : ""}`
    ).join("\n");
    const conventions = (schema.conventions || []).map((c) => `- ${c}`).join("\n");

    return `
You are a PostgreSQL query generator for a pharmaceutical inventory system (Kastoori Medicals) running on Supabase.

BUSINESS WORKFLOW: ${schema.businessWorkflow}

TABLES (public schema):
${tableLines}

VIEWS (prefer these over hand-joining when the question matches):
${viewLines}

CONVENTIONS:
${conventions}

RULES:
- Generate exactly ONE PostgreSQL statement, SELECT or WITH ... SELECT only. Never INSERT/UPDATE/DELETE/DDL/anything else.
- No trailing semicolon. No SQL comments.
- Always add a LIMIT (<=500) unless the question clearly wants a single aggregate value.
- Use ILIKE '%term%' for user-provided name/text matching.
- Questions may arrive in English, Tamil, or Tanglish — infer intent from recognizable words and answer the underlying English question.
- If the question cannot be answered from this schema (e.g. asks to change data, or asks about something not modeled here), respond with sql: null and explain briefly in summary_hint instead.

OUTPUT FORMAT — respond with ONLY a single raw JSON object, no markdown fences, no prose outside it:
{"sql": "<the SELECT statement, or null>", "summary_hint": "<one short sentence of what this query answers, in English>"}
`.trim();
}

// Same denylist as execute_ai_report_sql() in Postgres. This copy exists
// only to fail fast / cheaply before spending a DB round trip — it is
// NOT the security boundary; the Postgres function re-validates independently.
const BANNED_SQL = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|call|do|copy|merge|vacuum|analyze|execute|lock|reindex|refresh|listen|notify|prepare|declare|set|reset|pg_sleep|dblink)\b/i;

function validateSql(sql) {
    if (!sql || typeof sql !== "string") return { ok: false, reason: "No SQL was generated." };
    const clean = sql.trim().replace(/;\s*$/, "");
    if (!/^\s*(select|with)\s/i.test(clean)) return { ok: false, reason: "Only SELECT/WITH statements are allowed." };
    if (/(--|\/\*)/.test(clean)) return { ok: false, reason: "Comments are not allowed." };
    if (clean.includes(";")) return { ok: false, reason: "Only a single statement is allowed." };
    if (BANNED_SQL.test(clean)) return { ok: false, reason: "Statement contains a disallowed keyword." };
    return { ok: true, sql: clean };
}

// ================================================================
// Provider-agnostic LLM adapter. Everything else in this file (and the
// rest of the app) calls callLLM() and never touches a vendor SDK
// directly, so swapping ANTHROPIC_API_KEY for OPENAI_API_KEY / a Gemini
// key / a local Ollama endpoint later means adding one branch here —
// no changes anywhere else, including the frontend.
// ================================================================
async function callLLM({ system, prompt, maxTokens }) {
    const provider = (Deno.env.get("LLM_PROVIDER") || "anthropic").toLowerCase();

    if (provider === "anthropic") {
        const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
        if (!apiKey) throw new Error("AI Reporting is not configured (missing ANTHROPIC_API_KEY secret).");
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
                model: "claude-sonnet-5",
                max_tokens: maxTokens || 700,
                system,
                messages: [{ role: "user", content: prompt }],
            }),
        });
        if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            throw new Error(`AI request failed (${resp.status}): ${errText.slice(0, 300)}`);
        }
        const json = await resp.json();
        return (json.content || []).map((b) => b.text || "").join("").trim();
    }

    // ---- Add future providers here, same input/output shape ----
    // if (provider === "openai") { ... return text; }
    // if (provider === "gemini") { ... return text; }
    // if (provider === "ollama") { ... return text; }

    throw new Error(`Unsupported LLM_PROVIDER: ${provider}`);
}

Deno.serve(async (req) => {
    const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
    };
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

    const startedAt = Date.now();
    let callerName = null;
    let callerRole = null;
    let admin;

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

        admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

        const { data: callerProfile } = await admin
            .from("profiles")
            .select("role, status, full_name")
            .eq("id", userData.user.id)
            .single();

        if (!callerProfile || callerProfile.status !== "Active") {
            return new Response(JSON.stringify({ error: "Account is not active." }), { status: 403, headers: cors });
        }
        callerName = callerProfile.full_name || userData.user.email || "Unknown";
        callerRole = callerProfile.role || "Staff";

        const body = await req.json();
        const action = body.action === "explain" ? "explain" : "query";

        // ============================================================
        // ACTION: explain — plain-language summary of an already-fetched
        // result. No SQL/DB access here at all, so it's not gated by the
        // safety validator (there's nothing to validate — it only reads
        // the rows the caller already legitimately received from a prior
        // "query" call).
        // ============================================================
        if (action === "explain") {
            const question = (body.question || "").toString().slice(0, 500);
            const columns = Array.isArray(body.columns) ? body.columns : [];
            const rows = Array.isArray(body.rows) ? body.rows.slice(0, 50) : [];
            if (rows.length === 0) {
                return new Response(JSON.stringify({ explanation: "There's no data to explain." }), { status: 200, headers: cors });
            }
            const prompt = `Question asked: "${question}"\nColumns: ${columns.join(", ")}\nData (JSON, up to 50 rows): ${JSON.stringify(rows)}\n\nWrite ONE short, plain-language business sentence summarizing the key insight in this data (e.g. totals, a standout value, a trend). No preamble, no markdown, just the sentence.`;
            const text = await callLLM({
                system: "You are a business analyst summarizing a pharmacy inventory report result in one clear sentence for non-technical staff.",
                prompt,
                maxTokens: 200,
            });
            return new Response(JSON.stringify({ explanation: text.trim() }), { status: 200, headers: cors });
        }

        // ============================================================
        // ACTION: query — the main NL -> SQL -> rows flow.
        // ============================================================
        const question = (body.question || "").toString().trim();
        if (!question) {
            return new Response(JSON.stringify({ error: "Question is required." }), { status: 400, headers: cors });
        }
        if (question.length > 500) {
            return new Response(JSON.stringify({ error: "Question is too long (max 500 characters)." }), { status: 400, headers: cors });
        }

        const schema = await loadSchemaKnowledge();
        const systemPrompt = buildSystemPrompt(schema);
        const rawText = await callLLM({ system: systemPrompt, prompt: question, maxTokens: 700 });

        let parsed;
        try {
            const cleaned = rawText.replace(/^```json\s*|```\s*$/g, "").trim();
            parsed = JSON.parse(cleaned);
        } catch {
            await logAttempt(admin, callerName, callerRole, question, null, 0, "error", "AI did not return valid JSON.");
            return new Response(JSON.stringify({ error: "AI response could not be parsed. Try rephrasing the question." }), { status: 502, headers: cors });
        }

        const summaryHint = (parsed.summary_hint || "").toString();

        if (!parsed.sql) {
            await logAttempt(admin, callerName, callerRole, question, null, 0, "rejected", summaryHint || "AI determined this could not be answered from the schema.");
            return new Response(JSON.stringify({
                summary: summaryHint || "I couldn't turn that into a report from the current data. Try rephrasing, or ask about inventory, dues, suppliers, or OCR/expiry data.",
                sql: null,
                columns: [],
                rows: [],
                rowCount: 0,
            }), { status: 200, headers: cors });
        }

        const validated = validateSql(parsed.sql);
        if (!validated.ok) {
            await logAttempt(admin, callerName, callerRole, question, parsed.sql, 0, "rejected", validated.reason);
            return new Response(JSON.stringify({ error: `Generated query failed safety validation: ${validated.reason}` }), { status: 400, headers: cors });
        }
        const sql = validated.sql;

        // ---- Execute via the hardened Postgres function (the real boundary) ----
        const { data: rpcData, error: rpcError } = await admin.rpc("execute_ai_report_sql", { p_sql: sql, p_row_limit: 500 });
        const executionMs = Date.now() - startedAt;

        if (rpcError) {
            await logAttempt(admin, callerName, callerRole, question, sql, 0, "error", rpcError.message, executionMs);
            return new Response(JSON.stringify({ error: `Query could not be executed: ${rpcError.message}` }), { status: 400, headers: cors });
        }

        const rows = Array.isArray(rpcData) ? rpcData : [];
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

        await logAttempt(admin, callerName, callerRole, question, sql, rows.length, "success", null, executionMs);

        const isAdmin = callerRole === "Administrator";
        return new Response(JSON.stringify({
            summary: summaryHint || `Found ${rows.length} matching record${rows.length === 1 ? "" : "s"}.`,
            sql: isAdmin ? sql : null,
            columns,
            rows,
            rowCount: rows.length,
            executionMs,
        }), { status: 200, headers: cors });

    } catch (err) {
        if (admin) {
            await logAttempt(admin, callerName, callerRole, "(unknown)", null, 0, "error", err.message || "Unknown error").catch(() => {});
        }
        return new Response(JSON.stringify({ error: err.message || "Unknown error" }), { status: 500, headers: cors });
    }
});

async function logAttempt(admin, askedBy, role, question, sql, rowCount, status, errorMessage, executionMs) {
    try {
        await admin.from("ai_report_queries").insert({
            asked_by: askedBy,
            role,
            question,
            generated_sql: sql,
            row_count: rowCount || 0,
            execution_ms: executionMs || null,
            status,
            error_message: errorMessage || null,
        });
    } catch {
        // Logging failures should never break the user-facing response.
    }
}
