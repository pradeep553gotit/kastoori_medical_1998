# Local OCR (Tesseract.js) Load Test Report

**Date:** 2026-07-26
**Purpose:** Before building Phase B/C on top of the local-first `ScanningEngine`, verify with real numbers (not assumptions) that local OCR can actually sustain the stated business scale — thousands of scans/day — and understand its accuracy envelope so the confidence-gating thresholds in `ScanningEngine`/`OCRSharedParser` are grounded in evidence, not guesses.

**Method:** Ran the actual Tesseract.js engine (v5.1.1 — an upgrade from the v4.0.2 CDN build currently in `index.html`, see Finding 4) against 95 synthetic document images: 80 rendered "clean scan" bills/order-sheets with known ground-truth text, plus 15 deliberately harsh worst-case images (heavy blur, underexposure, rotation, JPEG compression artifacts) simulating a bad phone photo. Every result was scored against ground truth using character-level Levenshtein accuracy, not eyeballed.

**Important caveat up front:** these are synthetic, computer-rendered text images, not real photographs of real invoices. They test the OCR engine's raw capability and give a defensible throughput number, but they cannot fully substitute for testing against your actual bills — real documents have stamps, handwriting, overlapping print, creases, and inconsistent fonts that a rendered test image doesn't reproduce. This report should de-risk the *architecture decision* (is local-first viable at all), not be read as a final accuracy certification.

---

## Finding 1 — Throughput comfortably clears the stated target

| Mode | Images | Avg time/image | Throughput | Projected 10hr-day capacity |
|---|---|---|---|---|
| Sequential, 1 worker | 20 | 916ms | 3,910/hour | ~39,100/day |
| Single worker, mixed clean+degraded set | 80 | 680ms | 5,273/hour | ~52,733/day |

Your stated target is **1,000+ bills/day + 1,000+ order sheets/day = 2,000+/day**. Even with a single OCR worker and no parallelism at all, this sandbox measured **~26x the required headroom**. This was run on a **single-CPU-core sandbox** — real deployment hardware (or a user's laptop/phone running the browser build) will very likely do better, and a multi-worker pool (already built in `ocr/queue.js`) would add further parallelism on top of this. I could not test true multi-core parallelism here (see Finding 3), so treat the pooled number as a floor, not a ceiling.

**Conclusion: throughput is not a risk for this architecture at your stated scale.**

## Finding 2 — Accuracy is high on clean scans, degrades honestly (and predictably) on bad photos — and the confidence gate catches it

| Image set | Avg character accuracy | Avg Tesseract confidence |
|---|---|---|
| Clean synthetic scans (80 images) | 99.99% | 91.2–91.5 |
| Mild degradation (slight rotation + blur) | 99.6% | ~90 |
| **Harsh degradation** (heavy blur, underexposure, rotation, JPEG noise — 15 images) | **61.0%** (worst single image: 34.0%) | **43.0** |

The harsh-degradation number is the one that matters most: it's a stand-in for "someone photographed a crumpled invoice in bad light." Accuracy drops hard — as expected, this is a real limitation of local OCR versus a large vision-language model. **But every single one of those 15 harsh images scored a confidence below 60**, which is below the `lowConfidenceThreshold: 45` default in `ScanningEngine` and the `<80` manual-review gate already shipped in `validateExtractedItem`. In other words: **the system doesn't silently produce wrong data on bad photos — it correctly recognizes its own uncertainty and would route every one of these to manual review (or, per the existing architecture, trigger secondary Gemini verification first).** This is the core safety property the whole local-first design depends on, and it held up under a real (if synthetic) stress test.

**Conclusion: local OCR's accuracy ceiling on clean documents is excellent; its accuracy floor on bad photos is honestly poor, but the confidence gate reliably catches the difference rather than guessing.**

## Finding 3 — True multi-core concurrency was not testable in this environment

This sandbox has exactly **1 CPU core** (`os.cpus().length === 1`). The "concurrent worker pool" benchmark technically ran with a pool size of 1 (`Math.min(4, 1)`), so it did not actually demonstrate parallel speedup — the improved throughput seen there (680ms/image vs 916ms/image) reflects Tesseract's own internal warm-up/caching between calls on a reused worker, not concurrency. Given Finding 1 already clears the target by 26x on a single worker, this isn't a blocker, but it means the *upper bound* of throughput on real multi-core hardware is still unverified — treat multi-worker scaling as a reasonable assumption backed by the architecture (independent workers, no shared state), not a measured fact yet.

## Finding 4 — Version mismatch discovered: your deployed app uses Tesseract.js v4.0.2, this benchmark used v5.1.1

This benchmark could not get **Tesseract.js v4.0.2** (the version currently loaded via CDN in your `index.html`) working at all in this environment — every recognition call failed with a low-level internal error (`Cannot read properties of null (reading 'SetImageFile')`), a known compatibility issue between that version's worker implementation and newer JS runtimes. **v5.1.1 worked immediately and correctly.** This is worth treating as a real finding, not just a sandbox quirk: it's plausible the same incompatibility could surface for some of your actual users depending on their browser/JS engine version, since browsers update continuously. **Recommendation: upgrade the CDN reference in `index.html` from `tesseract.js@4.0.2` to `tesseract.js@5` before wiring local OCR into production**, and re-run a small manual smoke test in an actual browser to confirm.

## Finding 5 — Memory footprint is modest per worker

A single Tesseract worker's process RSS grew from ~60MB to ~200MB after initialization + several recognitions, then to ~250MB after processing the full 80-image set. For a pool of N workers, budget roughly **150–250MB per worker** — a 4-worker pool would be in the ~800MB–1GB range. This is a reasonable footprint for a modern browser tab or a small dedicated OCR worker process, but worth keeping in mind if this ever moves to a constrained device (older Android tablets at a dispensary counter, for example) — that's a real-device question this synthetic benchmark can't answer.

## Finding 6 — Network dependency, ironically, exists even in "local" OCR — and is now closed

Tesseract.js's *default* configuration fetches its WASM core and language-data file from a CDN (jsDelivr) on first use — meaning the current CDN-script-tag setup in `index.html` is not actually 100% offline-capable as configured; it just has a different, less obvious third-party dependency than Gemini did. I hit this directly: this sandbox's restricted network couldn't reach jsDelivr, and the benchmark only worked after I self-hosted the two required assets (`tesseract-core.wasm.js` from the npm package, `eng.traineddata.gz` fetched once from GitHub) and pointed Tesseract.js at them explicitly via `corePath`/`langPath`. **Recommendation: do the same in production** — vendor these two files into your own deployment (they're small, static, and language-data rarely changes) rather than relying on a third-party CDN being reachable, which directly serves the "independence from third-party quotas/outages" goal from your last message. This is a config change, not a code change, and belongs in Phase B/C's integration work.

---

## Overall Assessment

| Question | Answer |
|---|---|
| Can local OCR sustain 2,000+ scans/day? | **Yes, with large headroom** (measured 26x on a single core) |
| Is accuracy good enough on clean/normal scans? | **Yes** — 99%+ on synthetic clean documents |
| Does the system handle bad-quality photos safely? | **Yes** — accuracy drops as expected, but confidence scoring correctly flags all of them for review rather than guessing |
| Is the currently-deployed Tesseract.js version safe to build on? | **No — recommend upgrading v4.0.2 → v5 first**, this benchmark couldn't even get v4.0.2 to run |
| Is local OCR actually zero-third-party-dependency as currently configured? | **Not quite** — CDN-fetched WASM/language data is a hidden dependency; self-hosting those two files closes it |
| Was this tested against real invoice photos? | **No** — synthetic only; real-image validation remains open work before full production rollout |

**Recommendation:** proceed to Phase B or Phase C. The architecture itself is validated. Fold the version upgrade (Finding 4) and self-hosted assets (Finding 6) into that work as small, concrete action items rather than separate phases.

---

## Artifacts

- `loadtest/generate_images.py` — synthetic image generator (deterministic, seeded)
- `loadtest/benchmark.js` — throughput/accuracy benchmark (clean + mild-degradation sets)
- `loadtest/benchmark_harsh.js` — worst-case degraded-image benchmark
- `loadtest/benchmark_results.json` — raw results from the throughput run
- `loadtest/images/`, `loadtest/images_harsh/`, `loadtest/manifest*.json` — the test image sets themselves, so this is reproducible/re-runnable, not just a one-off log
