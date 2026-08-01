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
// Schema Knowledge Layer — inlined directly here (previously read from a
// separate schema-knowledge.json file at runtime via Deno.readTextFile).
// That worked when using Docker-based bundling, but this project's
// deployments have been running via the CLI's fallback bundler (Docker
// not running locally), which only follows static imports and does not
// reliably package a co-located file read at runtime -- causing a 500
// "path not found" error for schema-knowledge.json in production. Inlining
// removes this failure mode entirely: there is nothing extra to bundle,
// ever, regardless of local Docker availability. To update the schema
// knowledge, edit SCHEMA_KNOWLEDGE below directly instead of the old
// schema-knowledge.json file.
// ================================================================
const SCHEMA_KNOWLEDGE = {
  "version": 1,
  "businessWorkflow": "Order Sheet -> OCR -> Verification -> Inventory Check -> Reorder (if short) -> Supplier Bill -> Supplier Due (if supplier under-supplies) -> Inventory Update -> Reports.",
  "conventions": [
    "inventory_items.stock and inventory_transactions.quantity_tablets are ALWAYS in tablets, never strips.",
    "'Due Orders' (medicine_history / workflows) = stock the pharmacy owes a DISPENSARY. 'Supplier Due' (supplier_due tables) = stock a SUPPLIER owes the pharmacy after under-supplying an invoice. These are different concepts \u2014 never conflate them.",
    "There is no separate expiry column \u2014 expiry dates live inside inventory_items.batches, a jsonb array of {batchNumber, quantity, expiryDate}.",
    "Use ILIKE '%term%' for any user-provided name/text matching (handles partial/misspelled English, Tamil, or Tanglish input).",
    "Questions may arrive in English, Tamil, or Tanglish \u2014 infer intent from whichever recognizable words appear and answer the underlying English question."
  ],
  "tables": [
    {
      "name": "inventory_items",
      "description": "Authoritative current stock per medicine (replaces localStorage as source of truth).",
      "aliases": [
        "stock",
        "current stock",
        "inventory",
        "\u0bae\u0bb0\u0bc1\u0ba8\u0bcd\u0ba4\u0bc1 \u0b87\u0bb0\u0bc1\u0baa\u0bcd\u0baa\u0bc1"
      ],
      "columns": [
        {
          "name": "code",
          "type": "text",
          "pk": true,
          "description": "Product Code, primary identifier"
        },
        {
          "name": "name",
          "type": "text",
          "description": "Medicine name"
        },
        {
          "name": "category",
          "type": "text"
        },
        {
          "name": "brand",
          "type": "text"
        },
        {
          "name": "stock",
          "type": "numeric",
          "description": "Current stock, ALWAYS tablets"
        },
        {
          "name": "tabs_per_strip",
          "type": "numeric"
        },
        {
          "name": "reorder_level",
          "type": "numeric",
          "description": "Threshold below which item is low stock"
        },
        {
          "name": "batches",
          "type": "jsonb",
          "description": "[{batchNumber, quantity, expiryDate}] \u2014 use for expiry questions"
        },
        {
          "name": "updated_at",
          "type": "timestamptz"
        },
        {
          "name": "updated_by",
          "type": "text"
        }
      ]
    },
    {
      "name": "inventory_transactions",
      "description": "Every stock in/out movement \u2014 use for 'inventory movement' / 'stock movement' questions.",
      "aliases": [
        "stock movement",
        "inventory movement",
        "stock in",
        "stock out"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "medicine_code",
          "type": "text",
          "references": "inventory_items.code"
        },
        {
          "name": "transaction_type",
          "type": "text",
          "enum": [
            "stock_in",
            "stock_out",
            "adjustment",
            "reservation",
            "release"
          ]
        },
        {
          "name": "quantity_tablets",
          "type": "numeric",
          "description": "ALWAYS tablets"
        },
        {
          "name": "batch_number",
          "type": "text"
        },
        {
          "name": "reference_id",
          "type": "text",
          "description": "order ref / due order id / supplier bill id"
        },
        {
          "name": "performed_by",
          "type": "text"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "medicine_history",
      "description": "General event log per medicine, e.g. 'Inventory Updated', 'Order Verified', 'Due Order Created'.",
      "aliases": [
        "due orders history",
        "order history",
        "medicine events"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "medicine_code",
          "type": "text"
        },
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "event_type",
          "type": "text"
        },
        {
          "name": "batch_number",
          "type": "text"
        },
        {
          "name": "quantity",
          "type": "numeric"
        },
        {
          "name": "details",
          "type": "text"
        },
        {
          "name": "performed_by",
          "type": "text"
        },
        {
          "name": "workflow_id",
          "type": "text",
          "references": "workflows.id"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "purchase_images",
      "description": "Every uploaded purchase/order-sheet image, source of OCR.",
      "aliases": [
        "uploaded images",
        "order sheet images",
        "bill images"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "filename",
          "type": "text"
        },
        {
          "name": "storage_path",
          "type": "text"
        },
        {
          "name": "upload_date",
          "type": "timestamptz"
        },
        {
          "name": "uploaded_by",
          "type": "text"
        },
        {
          "name": "image_type",
          "type": "text",
          "enum": [
            "purchase_bill",
            "order_sheet",
            "ocr_image",
            "supplier_bill",
            "customer_order"
          ]
        },
        {
          "name": "supplier",
          "type": "text"
        },
        {
          "name": "purchase_id",
          "type": "uuid"
        },
        {
          "name": "ocr_status",
          "type": "text",
          "enum": [
            "pending",
            "success",
            "failed"
          ]
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "supplier_bills",
      "description": "Normalized bill header, one row per uploaded invoice.",
      "aliases": [
        "invoices",
        "supplier invoices",
        "purchases from supplier"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "invoice_number",
          "type": "text"
        },
        {
          "name": "invoice_date",
          "type": "date"
        },
        {
          "name": "supplier_name",
          "type": "text"
        },
        {
          "name": "uploaded_by",
          "type": "text"
        },
        {
          "name": "image_id",
          "type": "uuid",
          "references": "purchase_images.id"
        },
        {
          "name": "total_items",
          "type": "integer"
        },
        {
          "name": "ocr_confidence",
          "type": "numeric"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "ocr_uploads",
      "description": "One row per file sent through the OCR pipeline.",
      "aliases": [
        "ocr jobs",
        "ocr uploads",
        "ocr accuracy source"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "file_name",
          "type": "text"
        },
        {
          "name": "upload_type",
          "type": "text",
          "enum": [
            "order_sheet",
            "supplier_bill"
          ]
        },
        {
          "name": "uploaded_by",
          "type": "text"
        },
        {
          "name": "status",
          "type": "text",
          "enum": [
            "pending",
            "processing",
            "success",
            "failed"
          ]
        },
        {
          "name": "processing_time_ms",
          "type": "integer"
        },
        {
          "name": "error_message",
          "type": "text"
        },
        {
          "name": "image_id",
          "type": "uuid",
          "references": "purchase_images.id"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "ocr_results",
      "description": "One row per extracted medicine line item from OCR.",
      "aliases": [
        "ocr extracted lines",
        "extracted medicines"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "ocr_upload_id",
          "type": "uuid",
          "references": "ocr_uploads.id"
        },
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "matched_code",
          "type": "text",
          "references": "inventory_items.code"
        },
        {
          "name": "strength",
          "type": "text"
        },
        {
          "name": "pack_size",
          "type": "text"
        },
        {
          "name": "quantity",
          "type": "numeric"
        },
        {
          "name": "confidence_score",
          "type": "numeric"
        },
        {
          "name": "match_status",
          "type": "text",
          "enum": [
            "exact",
            "pack_confirm",
            "strength_confirm",
            "new",
            "not_found"
          ]
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "not_available_items",
      "description": "Medicines marked not available for a dispensary/patient order \u2014 distinct from supplier_due 'not_available' status.",
      "aliases": [
        "not available medicines",
        "unavailable stock",
        "cannot dispense"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "strength",
          "type": "text"
        },
        {
          "name": "requested_qty",
          "type": "numeric"
        },
        {
          "name": "dispensary",
          "type": "text"
        },
        {
          "name": "order_number",
          "type": "text"
        },
        {
          "name": "patient_name",
          "type": "text"
        },
        {
          "name": "reason",
          "type": "text"
        },
        {
          "name": "marked_by",
          "type": "text"
        },
        {
          "name": "marked_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "workflows",
      "description": "One row per Workflow ID \u2014 the order-lifecycle header, id format WF-YYYYMMDD-000001.",
      "aliases": [
        "orders",
        "order workflow",
        "dispensary orders"
      ],
      "columns": [
        {
          "name": "id",
          "type": "text",
          "pk": true
        },
        {
          "name": "created_date",
          "type": "date"
        },
        {
          "name": "created_time",
          "type": "time"
        },
        {
          "name": "created_by",
          "type": "text"
        },
        {
          "name": "current_status",
          "type": "text"
        },
        {
          "name": "dispensary",
          "type": "text"
        },
        {
          "name": "dispensary_id",
          "type": "text"
        },
        {
          "name": "order_sheet_ref",
          "type": "text"
        },
        {
          "name": "completion_date",
          "type": "date"
        },
        {
          "name": "completion_time",
          "type": "time"
        },
        {
          "name": "last_updated",
          "type": "timestamptz"
        },
        {
          "name": "last_updated_by",
          "type": "text"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "workflow_events",
      "description": "Append-only audit trail, one row per event within a workflow.",
      "aliases": [
        "order events",
        "workflow audit",
        "user activity",
        "audit log"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "workflow_id",
          "type": "text",
          "references": "workflows.id"
        },
        {
          "name": "order_id",
          "type": "text"
        },
        {
          "name": "user_name",
          "type": "text"
        },
        {
          "name": "role",
          "type": "text"
        },
        {
          "name": "action",
          "type": "text"
        },
        {
          "name": "module",
          "type": "text"
        },
        {
          "name": "previous_status",
          "type": "text"
        },
        {
          "name": "new_status",
          "type": "text"
        },
        {
          "name": "description",
          "type": "text"
        },
        {
          "name": "remarks",
          "type": "text"
        },
        {
          "name": "device",
          "type": "text"
        },
        {
          "name": "browser",
          "type": "text"
        },
        {
          "name": "event_time",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "supplier_due",
      "description": "One row per invoice that had a shortfall from a supplier.",
      "aliases": [
        "supplier due",
        "supplier owes",
        "outstanding from supplier"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "supplier_name",
          "type": "text"
        },
        {
          "name": "invoice_id",
          "type": "uuid",
          "references": "supplier_bills.id"
        },
        {
          "name": "invoice_number",
          "type": "text"
        },
        {
          "name": "status",
          "type": "text",
          "enum": [
            "open",
            "partially_supplied",
            "closed",
            "not_available"
          ]
        },
        {
          "name": "created_by",
          "type": "text"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        },
        {
          "name": "updated_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "supplier_due_items",
      "description": "One row per medicine line short on a supplier invoice.",
      "aliases": [
        "supplier due items",
        "short supply lines"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "due_id",
          "type": "uuid",
          "references": "supplier_due.id"
        },
        {
          "name": "product_code",
          "type": "text",
          "references": "inventory_items.code"
        },
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "strength",
          "type": "text"
        },
        {
          "name": "ordered_quantity",
          "type": "numeric"
        },
        {
          "name": "received_quantity",
          "type": "numeric"
        },
        {
          "name": "due_quantity",
          "type": "numeric"
        },
        {
          "name": "unit",
          "type": "text"
        },
        {
          "name": "reason",
          "type": "text"
        },
        {
          "name": "status",
          "type": "text",
          "enum": [
            "due",
            "partially_supplied",
            "supplied",
            "not_available"
          ]
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        },
        {
          "name": "updated_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "supplier_due_history",
      "description": "Append-only event log per supplier due state change.",
      "aliases": [
        "supplier due history"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "due_id",
          "type": "uuid",
          "references": "supplier_due.id"
        },
        {
          "name": "due_item_id",
          "type": "uuid",
          "references": "supplier_due_items.id"
        },
        {
          "name": "event_type",
          "type": "text",
          "enum": [
            "created",
            "partial_supply",
            "due_supplied",
            "due_closed",
            "not_available",
            "reopened"
          ]
        },
        {
          "name": "quantity",
          "type": "numeric"
        },
        {
          "name": "previous_status",
          "type": "text"
        },
        {
          "name": "new_status",
          "type": "text"
        },
        {
          "name": "performed_by",
          "type": "text"
        },
        {
          "name": "notes",
          "type": "text"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "report_exports",
      "description": "Audit trail of Report Center exports (Admin only).",
      "aliases": [
        "report exports",
        "export history"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "report_type",
          "type": "text"
        },
        {
          "name": "export_format",
          "type": "text",
          "enum": [
            "excel",
            "csv",
            "pdf",
            "print"
          ]
        },
        {
          "name": "filters",
          "type": "jsonb"
        },
        {
          "name": "record_count",
          "type": "integer"
        },
        {
          "name": "exported_by",
          "type": "text"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        }
      ]
    },
    {
      "name": "dashboard_metrics",
      "description": "Daily rollups for KPI cards.",
      "aliases": [
        "daily metrics",
        "dashboard kpis"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "metric_date",
          "type": "date",
          "unique": true
        },
        {
          "name": "order_pages_uploaded",
          "type": "integer"
        },
        {
          "name": "supplier_bills_uploaded",
          "type": "integer"
        },
        {
          "name": "medicines_extracted",
          "type": "integer"
        },
        {
          "name": "ocr_success",
          "type": "integer"
        },
        {
          "name": "ocr_failed",
          "type": "integer"
        },
        {
          "name": "pending_files",
          "type": "integer"
        },
        {
          "name": "avg_ocr_time_ms",
          "type": "numeric"
        }
      ]
    },
    {
      "name": "upload_statistics",
      "description": "Per-user upload counters (Admin visibility).",
      "aliases": [
        "user upload stats",
        "staff activity"
      ],
      "columns": [
        {
          "name": "id",
          "type": "uuid",
          "pk": true
        },
        {
          "name": "user_name",
          "type": "text",
          "unique": true
        },
        {
          "name": "uploads_count",
          "type": "integer"
        },
        {
          "name": "ocr_success_count",
          "type": "integer"
        },
        {
          "name": "ocr_failed_count",
          "type": "integer"
        },
        {
          "name": "last_upload_at",
          "type": "timestamptz"
        }
      ]
    }
  ],
  "views": [
    {
      "name": "v_outstanding_supplier_due",
      "description": "Outstanding (still owed) supplier due lines with age in days. Prefer this over hand-joining supplier_due + supplier_due_items.",
      "aliases": [
        "outstanding supplier due",
        "open supplier due"
      ],
      "columns": [
        {
          "name": "due_item_id",
          "type": "uuid"
        },
        {
          "name": "due_id",
          "type": "uuid"
        },
        {
          "name": "supplier_name",
          "type": "text"
        },
        {
          "name": "invoice_number",
          "type": "text"
        },
        {
          "name": "product_code",
          "type": "text"
        },
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "strength",
          "type": "text"
        },
        {
          "name": "due_quantity",
          "type": "numeric"
        },
        {
          "name": "unit",
          "type": "text"
        },
        {
          "name": "status",
          "type": "text"
        },
        {
          "name": "created_at",
          "type": "timestamptz"
        },
        {
          "name": "age_days",
          "type": "integer"
        }
      ]
    },
    {
      "name": "v_due_by_supplier",
      "description": "Outstanding supplier due grouped by supplier \u2014 use for 'which supplier has the most due' questions.",
      "aliases": [
        "due by supplier",
        "supplier performance"
      ],
      "columns": [
        {
          "name": "supplier_name",
          "type": "text"
        },
        {
          "name": "open_items",
          "type": "integer"
        },
        {
          "name": "total_due_quantity",
          "type": "numeric"
        }
      ]
    },
    {
      "name": "v_due_by_medicine",
      "description": "Outstanding supplier due grouped by medicine.",
      "aliases": [
        "due by medicine"
      ],
      "columns": [
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "strength",
          "type": "text"
        },
        {
          "name": "product_code",
          "type": "text"
        },
        {
          "name": "open_items",
          "type": "integer"
        },
        {
          "name": "total_due_quantity",
          "type": "numeric"
        }
      ]
    },
    {
      "name": "v_due_aging",
      "description": "Outstanding supplier due bucketed by age \u2014 use for aging/overdue questions.",
      "aliases": [
        "due aging",
        "overdue supplier due"
      ],
      "columns": [
        {
          "name": "due_item_id",
          "type": "uuid"
        },
        {
          "name": "supplier_name",
          "type": "text"
        },
        {
          "name": "medicine_name",
          "type": "text"
        },
        {
          "name": "due_quantity",
          "type": "numeric"
        },
        {
          "name": "age_days",
          "type": "integer"
        },
        {
          "name": "age_bucket",
          "type": "text",
          "enum": [
            "0-3 days",
            "4-7 days",
            "8-14 days",
            "15+ days"
          ]
        }
      ]
    }
  ]
};

function loadSchemaKnowledge() {
    return SCHEMA_KNOWLEDGE;
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
    // Root cause of "Couldn't run that report": the browser's preflight
    // OPTIONS request declares every header the actual request will send
    // (callEdgeFunction in app.js sends both "apikey" and "authorization",
    // since Supabase's gateway requires "apikey" on top of the bearer
    // token). This list previously only allowed "authorization, content-type"
    // -- missing "apikey" (and "x-client-info", sent by the supabase-js
    // client library itself) caused the browser to block the request
    // before it ever reached this function, independent of any API key,
    // auth, or database issue downstream.
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    const cors = corsHeaders; // kept as `cors` too -- every response below already references `cors`; renaming the variable everywhere would be a needless larger diff for a header-only fix.
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

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
