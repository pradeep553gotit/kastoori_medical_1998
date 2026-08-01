/**
 * ocr/queue.js
 * ------------------------------------------------------------------
 * OCR Batch Queue (Phase 3.6) -- NEW. Supports multi-image / multi-page
 * batches (drag-and-drop, camera capture, multi-file input) with
 * bounded parallelism, per-job retry, progress callbacks, and
 * cancel/resume, without blocking the UI thread.
 *
 * "Background execution / no UI freezing": every job is an async
 * network call (Gemini fetch or Tesseract's own worker thread), so
 * there is no CPU-heavy synchronous work here that could freeze the
 * main thread -- the queue's job is purely to bound concurrency and
 * sequence work, which setTimeout(0)/microtask scheduling already
 * yields to the render loop between jobs.
 *
 * Usage:
 *   const queue = new OCRQueue({ concurrency: 2 });
 *   queue.onProgress = (state) => updateUI(state);
 *   const jobIds = queue.addAll(files, async (file) => {
 *       // caller-supplied unit of work, e.g. read file -> preprocess ->
 *       // provider.recognize(...) -> return the parsed result
 *   });
 *   await queue.run();
 *   queue.cancel();     // stops picking up NEW jobs; in-flight jobs finish
 *   await queue.retryFailed();
 */
(function (global) {
    "use strict";

    const STATUS = { QUEUED: "queued", RUNNING: "running", DONE: "done", FAILED: "failed", CANCELLED: "cancelled" };

    class OCRQueue {
        constructor(options = {}) {
            this.concurrency = options.concurrency || 2;
            this.maxRetries = options.maxRetries != null ? options.maxRetries : 1;
            this.jobs = []; // { id, label, task, status, result, error, attempts }
            this._nextId = 1;
            this._cancelled = false;
            this._running = false;
            this.onProgress = null; // (summary) => void
            this.onJobDone = null;  // (job) => void
        }

        add(label, task) {
            const job = { id: this._nextId++, label, task, status: STATUS.QUEUED, result: null, error: null, attempts: 0 };
            this.jobs.push(job);
            return job.id;
        }

        addAll(items, taskFactory) {
            return items.map((item, i) => this.add(item && item.name ? item.name : `item-${i + 1}`, () => taskFactory(item)));
        }

        _summary() {
            const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
            this.jobs.forEach(j => { counts[j.status]++; });
            return {
                total: this.jobs.length,
                ...counts,
                percentComplete: this.jobs.length
                    ? Math.round(((counts.done + counts.failed + counts.cancelled) / this.jobs.length) * 100)
                    : 0
            };
        }

        _emitProgress() {
            if (typeof this.onProgress === "function") {
                try { this.onProgress(this._summary()); } catch (e) { /* never let a UI callback break the queue */ }
            }
        }

        async _runJob(job) {
            job.status = STATUS.RUNNING;
            job.attempts++;
            this._emitProgress();
            try {
                job.result = await job.task();
                job.status = STATUS.DONE;
                job.error = null;
            } catch (err) {
                if (job.attempts <= this.maxRetries && !this._cancelled) {
                    // Retry failed job (Phase 3.6 requirement) -- one
                    // immediate re-attempt by default; callers doing
                    // Gemini calls already get their own retry/backoff
                    // inside runSharedGeminiVisionOCR, so this queue-level
                    // retry mainly covers transient failures OUTSIDE that
                    // (e.g. file read errors, local OCR worker crashes).
                    job.status = STATUS.QUEUED;
                    this._emitProgress();
                    return this._runJob(job);
                }
                job.status = STATUS.FAILED;
                job.error = err && err.message ? err.message : String(err);
            }
            this._emitProgress();
            if (typeof this.onJobDone === "function") {
                try { this.onJobDone(job); } catch (e) { /* ignore UI callback errors */ }
            }
            return job;
        }

        async run() {
            if (this._running) return this.jobs; // already in progress
            this._running = true;
            this._cancelled = false;
            this._emitProgress();

            const pending = this.jobs.filter(j => j.status === STATUS.QUEUED);
            let cursor = 0;
            const workers = new Array(Math.min(this.concurrency, pending.length || 1)).fill(null).map(async () => {
                while (true) {
                    if (this._cancelled) return;
                    const idx = cursor++;
                    if (idx >= pending.length) return;
                    const job = pending[idx];
                    if (job.status !== STATUS.QUEUED) continue;
                    await this._runJob(job);
                }
            });

            await Promise.all(workers);
            this._running = false;
            this._emitProgress();
            return this.jobs;
        }

        // Cancel: stop picking up new queued jobs. In-flight jobs are
        // allowed to finish naturally (we don't abort a live network
        // request mid-flight, since that risks leaving the provider's
        // own retry/backoff state inconsistent).
        cancel() {
            this._cancelled = true;
            this.jobs.forEach(j => {
                if (j.status === STATUS.QUEUED) j.status = STATUS.CANCELLED;
            });
            this._emitProgress();
        }

        // Resume: re-queue any cancelled jobs and run again.
        async resume() {
            this.jobs.forEach(j => {
                if (j.status === STATUS.CANCELLED) j.status = STATUS.QUEUED;
            });
            this._cancelled = false;
            return this.run();
        }

        async retryFailed() {
            this.jobs.forEach(j => {
                if (j.status === STATUS.FAILED) {
                    j.status = STATUS.QUEUED;
                    j.attempts = 0;
                }
            });
            this._cancelled = false;
            return this.run();
        }

        results() {
            return this.jobs.map(j => ({ id: j.id, label: j.label, status: j.status, result: j.result, error: j.error }));
        }
    }

    global.OCRQueue = OCRQueue;
    global.OCRQueue.STATUS = STATUS;
})(typeof window !== "undefined" ? window : globalThis);
