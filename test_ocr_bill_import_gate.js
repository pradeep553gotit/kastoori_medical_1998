"use strict";

const fs = require("fs");
const appJs = fs.readFileSync("app.js", "utf8");

let pass = 0, fail = 0;
function check(desc, cond) {
    if (cond) { pass++; console.log("PASS: " + desc); }
    else { fail++; console.log("FAIL: " + desc); }
}

check("Bill confidence no longer defaults missing values to 95",
    !/confidence_score:\s*item\.confidence_score[^,\n]+:\s*95/.test(appJs));

check("Missing bill confidence is preserved as unknown/null",
    /confidence_score:\s*item\.confidence_score[^,\n]+:\s*null/.test(appJs));

check("Import gate blocks unknown confidence",
    /rowConfidence\s*===\s*null\s*\|\|\s*isNaN\(rowConfidence\)\s*\|\|\s*rowConfidence\s*<\s*90/.test(appJs));

check("Validation gate uses 90 percent Manual Review threshold",
    /if\s*\(combinedConf\s*<\s*90\)\s*{\s*return\s+"manual_review";\s*}/.test(appJs));

check("Render path treats missing confidence as unsafe",
    /billItem\.confidence_score !== null && billItem\.confidence_score !== undefined \? billItem\.confidence_score : 0/.test(appJs));

check("Supplier bill preprocessing opts into conservative existing steps",
    /autoCrop:\s*true[\s\S]*normalizeBrightness:\s*true[\s\S]*denoise:\s*true[\s\S]*contrast:\s*true[\s\S]*sharpen:\s*true[\s\S]*adaptiveThreshold:\s*false/.test(appJs));

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
