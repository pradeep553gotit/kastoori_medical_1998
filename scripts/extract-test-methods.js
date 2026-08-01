"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");

const methods = [
    "getTablets",
    "setTablets",
    "parsePackSize",
    "calculateLevenshteinDistance",
    "normalizeStrengthToken",
    "detectFormCodeFromName",
    "extractProductBrandWord",
    "getIndexes",
    "getBrandCodeRegistry",
    "setBrandCodeRegistry",
    "getOrAssignBrandCode",
    "generateProductCode",
    "extractPackNumber",
    "resolveMedicine",
    "_normalizeOcrText",
    "_extractGenericNameGuess",
    "_fuzzyMatchCandidates",
    "getBrandFromName"
];

function findMethod(name) {
    const pattern = new RegExp(`\\n\\s{8}${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\(`);
    const match = pattern.exec(source);
    if (!match) throw new Error(`Unable to find method ${name} in app.js`);

    const start = match.index + 1;
    const rest = source.slice(start + 1);
    const nextMethod = /\n\s{8}(?:async\s+)?[A-Za-z_$][\w$]*\s*\(/g;
    const next = nextMethod.exec(rest);
    if (!next) throw new Error(`Unable to find method boundary after ${name}`);
    return source.slice(start, start + 1 + next.index).trimEnd();
}

const out = methods.map(name => `// ==== ${name} ====\n${findMethod(name)}\n`).join("\n");
fs.writeFileSync(path.join(root, "extracted_methods.js"), out);
console.log(`Extracted ${methods.length} app.js methods for duplicate-prevention tests.`);
