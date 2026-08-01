const fs = require("fs");
const path = require("path");
const os = require("os");
const { createWorker } = require("tesseract.js");

const IMG_DIR = path.join(__dirname, "images");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8"));

// This sandbox's network is domain-restricted (no jsDelivr CDN, which is
// tesseract.js's default source for the WASM core + language data), so we
// point it at locally-vendored copies instead. This isn't just a sandbox
// workaround -- it's the SAME thing a real production deployment should do
// (self-host these two static assets) so that local OCR has zero external
// network dependency at all, consistent with the "local-first, no
// third-party dependency" requirement.
const WORKER_OPTIONS = {
    langPath: path.join(__dirname, "langdata"),
    corePath: path.join(__dirname, "node_modules/tesseract.js-core/tesseract-core.wasm.js"),
    gzip: true
};

function createLocalWorker(lang) {
    return createWorker(lang, 1, WORKER_OPTIONS);
}

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
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

function normalize(s) {
    return (s || "").toUpperCase().replace(/\s+/g, " ").trim();
}

function charAccuracy(groundTruth, recognized) {
    const gt = normalize(groundTruth);
    const rec = normalize(recognized);
    if (gt.length === 0) return 1;
    const dist = levenshtein(gt, rec);
    return Math.max(0, 1 - dist / gt.length);
}

async function recognizeOne(worker, filePath) {
    const t0 = Date.now();
    const result = await worker.recognize(filePath);
    const ms = Date.now() - t0;
    return { text: result.data.text, confidence: result.data.confidence, ms };
}

// ---- Mode 1: sequential, single worker (worst case / baseline) --------
async function runSequential(items) {
    const worker = await createLocalWorker("eng");
    const results = [];
    const t0 = Date.now();
    for (const item of items) {
        const filePath = path.join(IMG_DIR, item.file);
        const r = await recognizeOne(worker, filePath);
        const acc = charAccuracy(item.ground_truth, r.text);
        results.push({ file: item.file, type: item.type, degraded: item.degraded, ms: r.ms, confidence: r.confidence, accuracy: acc });
    }
    const totalMs = Date.now() - t0;
    await worker.terminate();
    return { results, totalMs };
}

// ---- Mode 2: concurrent worker pool (models OCRQueue's concurrency) ----
async function runConcurrent(items, poolSize) {
    const workers = await Promise.all(Array.from({ length: poolSize }, () => createLocalWorker("eng")));
    const results = [];
    let cursor = 0;
    const t0 = Date.now();

    async function workerLoop(worker) {
        while (cursor < items.length) {
            const idx = cursor++;
            const item = items[idx];
            const filePath = path.join(IMG_DIR, item.file);
            const r = await recognizeOne(worker, filePath);
            const acc = charAccuracy(item.ground_truth, r.text);
            results.push({ file: item.file, type: item.type, degraded: item.degraded, ms: r.ms, confidence: r.confidence, accuracy: acc });
        }
    }

    await Promise.all(workers.map(workerLoop));
    const totalMs = Date.now() - t0;
    await Promise.all(workers.map(w => w.terminate()));
    return { results, totalMs };
}

function summarize(label, results, totalMs, memBeforeMB, memAfterMB) {
    const avgMs = results.reduce((a, r) => a + r.ms, 0) / results.length;
    const avgAcc = results.reduce((a, r) => a + r.accuracy, 0) / results.length;
    const avgConf = results.reduce((a, r) => a + (r.confidence || 0), 0) / results.length;
    const cleanResults = results.filter(r => !r.degraded);
    const degradedResults = results.filter(r => r.degraded);
    const avgAccClean = cleanResults.length ? cleanResults.reduce((a, r) => a + r.accuracy, 0) / cleanResults.length : null;
    const avgAccDegraded = degradedResults.length ? degradedResults.reduce((a, r) => a + r.accuracy, 0) / degradedResults.length : null;

    const imagesPerHour = (results.length / (totalMs / 1000)) * 3600;
    const imagesPerDay10h = imagesPerHour * 10; // a 10-hour business day

    console.log(`\n=== ${label} ===`);
    console.log(`Images processed:        ${results.length}`);
    console.log(`Total wall-clock time:    ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`Avg time per image:       ${avgMs.toFixed(0)}ms`);
    console.log(`Avg character accuracy:   ${(avgAcc * 100).toFixed(1)}%  (clean: ${avgAccClean !== null ? (avgAccClean*100).toFixed(1) : "n/a"}%, degraded: ${avgAccDegraded !== null ? (avgAccDegraded*100).toFixed(1) : "n/a"}%)`);
    console.log(`Avg Tesseract confidence: ${avgConf.toFixed(1)}`);
    console.log(`Throughput:               ${imagesPerHour.toFixed(0)} images/hour`);
    console.log(`Projected 10hr-day cap:   ${imagesPerDay10h.toFixed(0)} images/day`);
    if (memBeforeMB != null && memAfterMB != null) {
        console.log(`RSS memory before/after:  ${memBeforeMB.toFixed(0)}MB -> ${memAfterMB.toFixed(0)}MB`);
    }
    return { label, count: results.length, totalMs, avgMs, avgAcc, avgAccClean, avgAccDegraded, avgConf, imagesPerHour, imagesPerDay10h };
}

(async () => {
    console.log(`CPU cores available: ${os.cpus().length}`);
    console.log(`Node version: ${process.version}`);

    const all = manifest;
    const smallSet = all.slice(0, 20); // sequential is slow -- use a smaller sample for the baseline

    // --- Sequential baseline ---
    const memBefore1 = process.memoryUsage().rss / 1024 / 1024;
    const seq = await runSequential(smallSet);
    const memAfter1 = process.memoryUsage().rss / 1024 / 1024;
    const seqSummary = summarize("Sequential (1 worker)", seq.results, seq.totalMs, memBefore1, memAfter1);

    // --- Concurrent, pool size = min(4, cpus) ---
    const poolSize = Math.min(4, os.cpus().length);
    const memBefore2 = process.memoryUsage().rss / 1024 / 1024;
    const conc = await runConcurrent(all, poolSize);
    const memAfter2 = process.memoryUsage().rss / 1024 / 1024;
    const concSummary = summarize(`Concurrent (${poolSize} workers, full 80-image set)`, conc.results, conc.totalMs, memBefore2, memAfter2);

    fs.writeFileSync(path.join(__dirname, "benchmark_results.json"), JSON.stringify({ seqSummary, concSummary }, null, 2));

    console.log("\n=== Projection to stated business scale ===");
    console.log(`Target: 1000+ bills/day + 1000+ order sheets/day = 2000+ scans/day`);
    console.log(`At ${poolSize}-worker concurrency: ${concSummary.imagesPerDay10h.toFixed(0)} images/day capacity (10hr business day)`);
    console.log(`Headroom vs 2000/day target: ${(concSummary.imagesPerDay10h / 2000).toFixed(1)}x`);
})().catch(err => { console.error("Benchmark failed:", err); process.exit(1); });
