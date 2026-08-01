const fs = require("fs");
const path = require("path");
const { createWorker } = require("tesseract.js");

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest_harsh.json"), "utf8"));

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1), curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}
function normalize(s) { return (s || "").toUpperCase().replace(/\s+/g, " ").trim(); }
function charAccuracy(gt, rec) {
    const g = normalize(gt), r = normalize(rec);
    if (g.length === 0) return 1;
    return Math.max(0, 1 - levenshtein(g, r) / g.length);
}

(async () => {
    const worker = await createWorker("eng", 1, {
        langPath: path.join(__dirname, "langdata"),
        corePath: path.join(__dirname, "node_modules/tesseract.js-core/tesseract-core.wasm.js"),
        gzip: true
    });

    const results = [];
    for (const item of manifest) {
        const t0 = Date.now();
        const r = await worker.recognize(path.join(__dirname, "images_harsh", item.file));
        const ms = Date.now() - t0;
        const acc = charAccuracy(item.ground_truth, r.data.text);
        results.push({ file: item.file, ms, confidence: r.data.confidence, accuracy: acc });
        console.log(`${item.file}: acc=${(acc*100).toFixed(1)}% conf=${r.data.confidence.toFixed(0)} time=${ms}ms`);
    }
    await worker.terminate();

    const avgAcc = results.reduce((a, r) => a + r.accuracy, 0) / results.length;
    const avgConf = results.reduce((a, r) => a + r.confidence, 0) / results.length;
    const minAcc = Math.min(...results.map(r => r.accuracy));
    const belowConfThreshold = results.filter(r => r.confidence < 60).length;

    console.log("\n=== Harsh/worst-case degraded set ===");
    console.log(`Avg character accuracy: ${(avgAcc*100).toFixed(1)}%`);
    console.log(`Worst single-image accuracy: ${(minAcc*100).toFixed(1)}%`);
    console.log(`Avg confidence: ${avgConf.toFixed(1)}`);
    console.log(`Images that would correctly trigger manual review (confidence < 60): ${belowConfThreshold}/${results.length}`);
})().catch(e => { console.error(e); process.exit(1); });
