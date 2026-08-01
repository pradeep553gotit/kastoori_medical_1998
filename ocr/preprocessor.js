/**
 * ocr/preprocessor.js
 * ------------------------------------------------------------------
 * Image preprocessing stage for the OCR pipeline (Priority 3, Phase 3.1).
 *
 * NEW module -- does not exist in the current production app. Runs
 * BEFORE any OCR provider is called. Every step is best-effort and
 * independently guarded: if a step throws or produces a degenerate
 * result, that step is skipped and the pipeline continues with the
 * image it had going in. Preprocessing must NEVER block OCR -- on
 * total failure this module hands back the original, untouched image.
 *
 * Exposes a single global: window.OCRPreprocessor
 *
 * Usage:
 *   const out = await window.OCRPreprocessor.process(base64, mimeType, {
 *       autoRotate: true, deskew: true, denoise: true,
 *       adaptiveThreshold: false, // off by default -- see note below
 *       contrast: true, maxDim: 1600, quality: 0.75
 *   });
 *   // out = { base64, mimeType, steps: [...applied step names...], skipped: [...] }
 *
 * Note on adaptiveThreshold: binarizing a photo of a printed order
 * sheet can HELP Tesseract but can also destroy faint ink / colored
 * stamps that Gemini reads fine from the grayscale/contrast version.
 * Default is OFF for the Gemini path and left as an explicit opt-in
 * so callers (e.g. the local-OCR provider) can request it deliberately
 * instead of it silently changing what every caller sends today.
 */
(function (global) {
    "use strict";

    function loadImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = dataUrl;
        });
    }

    function toCanvas(img) {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return canvas;
    }

    // --- Auto rotation -------------------------------------------------
    // Reads EXIF orientation (tag 0x0112) out of a JPEG's APP1 segment and
    // returns the corrected canvas. PNGs/others have no EXIF orientation
    // and pass through unchanged. This does NOT attempt content-based
    // rotation detection (e.g. "text is upside down") -- that requires an
    // OCR pass to evaluate, which belongs in the provider/queue retry
    // logic (a provider can request a 180-degree retry), not here.
    function getExifOrientation(base64) {
        try {
            const binary = atob(base64);
            if (binary.charCodeAt(0) !== 0xFF || binary.charCodeAt(1) !== 0xD8) return 1; // not JPEG
            let offset = 2;
            while (offset < binary.length) {
                if (binary.charCodeAt(offset) !== 0xFF) break;
                const marker = binary.charCodeAt(offset + 1);
                if (marker === 0xE1) { // APP1 (EXIF)
                    const segLen = (binary.charCodeAt(offset + 2) << 8) | binary.charCodeAt(offset + 3);
                    const seg = binary.substr(offset + 4, segLen - 2);
                    if (seg.substr(0, 4) !== "Exif") return 1;
                    const tiffOffset = offset + 4 + 6;
                    const little = binary.charCodeAt(tiffOffset) === 0x49;
                    const readU16 = (o) => little
                        ? binary.charCodeAt(o) | (binary.charCodeAt(o + 1) << 8)
                        : (binary.charCodeAt(o) << 8) | binary.charCodeAt(o + 1);
                    const ifdOffset = little
                        ? (binary.charCodeAt(tiffOffset + 4) | (binary.charCodeAt(tiffOffset + 5) << 8) |
                           (binary.charCodeAt(tiffOffset + 6) << 16) | (binary.charCodeAt(tiffOffset + 7) << 24))
                        : ((binary.charCodeAt(tiffOffset + 4) << 24) | (binary.charCodeAt(tiffOffset + 5) << 16) |
                           (binary.charCodeAt(tiffOffset + 6) << 8) | binary.charCodeAt(tiffOffset + 7));
                    const entries = readU16(tiffOffset + ifdOffset);
                    for (let i = 0; i < entries; i++) {
                        const entryOffset = tiffOffset + ifdOffset + 2 + i * 12;
                        const tag = readU16(entryOffset);
                        if (tag === 0x0112) {
                            return readU16(entryOffset + 8);
                        }
                    }
                    return 1;
                }
                const len = (binary.charCodeAt(offset + 2) << 8) | binary.charCodeAt(offset + 3);
                offset += 2 + len;
            }
        } catch (e) {
            // Malformed/partial EXIF -- treat as "no rotation needed" rather
            // than throw, per the never-block-OCR contract.
        }
        return 1;
    }

    function applyExifRotation(canvas, orientation) {
        if (orientation <= 1) return canvas;
        const w = canvas.width, h = canvas.height;
        const swapDims = orientation >= 5; // 5,6,7,8 are 90/270-degree rotations
        const out = document.createElement("canvas");
        out.width = swapDims ? h : w;
        out.height = swapDims ? w : h;
        const ctx = out.getContext("2d");
        switch (orientation) {
            case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
            case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
            case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
            case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
            case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
            case 7: ctx.transform(0, -1, -1, 0, h, w); break;
            case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
            default: break;
        }
        ctx.drawImage(canvas, 0, 0);
        return out;
    }

    // --- Deskew ----------------------------------------------------------
    // Lightweight projection-profile deskew: tests a small range of
    // candidate angles, rotates a downsampled grayscale copy for each,
    // and picks the angle whose horizontal row-sum profile has the
    // highest variance (text lines are sharpest/most peaky when level).
    // This is a heuristic, not a full Hough-transform deskew -- it is
    // deliberately cheap so it can run on every scan without adding
    // meaningful latency, and it only ever nudges the image within
    // +/-7 degrees so it cannot mangle an intentionally-rotated photo.
    function estimateSkewAngle(canvas) {
        const maxDim = 300; // downsample for speed
        const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
        const w = Math.max(1, Math.round(canvas.width * scale));
        const h = Math.max(1, Math.round(canvas.height * scale));
        const small = document.createElement("canvas");
        small.width = w; small.height = h;
        const sctx = small.getContext("2d");
        sctx.drawImage(canvas, 0, 0, w, h);
        const srcData = sctx.getImageData(0, 0, w, h).data;

        const gray = new Float32Array(w * h);
        for (let i = 0, p = 0; i < srcData.length; i += 4, p++) {
            gray[p] = 0.299 * srcData[i] + 0.587 * srcData[i + 1] + 0.114 * srcData[i + 2];
        }

        function varianceAtAngle(deg) {
            const rad = deg * Math.PI / 180;
            const cos = Math.cos(rad), sin = Math.sin(rad);
            const rowSums = new Float64Array(h);
            const cx = w / 2, cy = h / 2;
            for (let y = 0; y < h; y++) {
                let sum = 0;
                for (let x = 0; x < w; x++) {
                    const dx = x - cx, dy = y - cy;
                    const sx = Math.round(cx + dx * cos - dy * sin);
                    const sy = Math.round(cy + dx * sin + dy * cos);
                    if (sx >= 0 && sx < w && sy >= 0 && sy < h) sum += gray[sy * w + sx];
                }
                rowSums[y] = sum;
            }
            let mean = 0;
            for (let y = 0; y < h; y++) mean += rowSums[y];
            mean /= h;
            let variance = 0;
            for (let y = 0; y < h; y++) variance += (rowSums[y] - mean) * (rowSums[y] - mean);
            return variance / h;
        }

        let bestAngle = 0, bestVariance = -Infinity;
        for (let deg = -7; deg <= 7; deg += 1) {
            const v = varianceAtAngle(deg);
            if (v > bestVariance) { bestVariance = v; bestAngle = deg; }
        }
        return bestAngle;
    }

    function rotateCanvas(canvas, deg) {
        if (!deg) return canvas;
        const rad = deg * Math.PI / 180;
        const w = canvas.width, h = canvas.height;
        const out = document.createElement("canvas");
        out.width = w; out.height = h;
        const ctx = out.getContext("2d");
        // Fill background white so the rotated corners don't come out
        // transparent/black, which would otherwise read as noise to OCR.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.translate(w / 2, h / 2);
        ctx.rotate(rad);
        ctx.drawImage(canvas, -w / 2, -h / 2);
        return out;
    }

    // --- Contrast enhancement (simple linear stretch) ---------------------
    function enhanceContrast(canvas, amount = 1.25) {
        const ctx = canvas.getContext("2d");
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = imgData.data;
        const factor = (259 * (amount * 128 + 255)) / (255 * (259 - amount * 128));
        for (let i = 0; i < d.length; i += 4) {
            d[i] = clamp8(factor * (d[i] - 128) + 128);
            d[i + 1] = clamp8(factor * (d[i + 1] - 128) + 128);
            d[i + 2] = clamp8(factor * (d[i + 2] - 128) + 128);
        }
        ctx.putImageData(imgData, 0, 0);
        return canvas;
    }

    function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

    // --- Noise reduction (3x3 median-ish box blur, cheap approximation) ---
    function denoise(canvas) {
        const ctx = canvas.getContext("2d");
        const { width, height } = canvas;
        if (width < 3 || height < 3) return canvas;
        const src = ctx.getImageData(0, 0, width, height);
        const out = ctx.createImageData(width, height);
        const s = src.data, o = out.data;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
                    o[idx] = s[idx]; o[idx + 1] = s[idx + 1]; o[idx + 2] = s[idx + 2]; o[idx + 3] = s[idx + 3];
                    continue;
                }
                for (let c = 0; c < 3; c++) {
                    let sum = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            sum += s[((y + dy) * width + (x + dx)) * 4 + c];
                        }
                    }
                    o[idx + c] = Math.round(sum / 9);
                }
                o[idx + 3] = s[idx + 3];
            }
        }
        ctx.putImageData(out, 0, 0);
        return canvas;
    }

    // --- Adaptive threshold (binarization) -- opt-in, see header note ----
    function adaptiveThreshold(canvas, blockSize = 15, c = 8) {
        const ctx = canvas.getContext("2d");
        const { width, height } = canvas;
        const imgData = ctx.getImageData(0, 0, width, height);
        const d = imgData.data;
        const gray = new Uint8ClampedArray(width * height);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            gray[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
        // Integral image for fast local mean.
        const integral = new Float64Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y++) {
            let rowSum = 0;
            for (let x = 0; x < width; x++) {
                rowSum += gray[y * width + x];
                integral[(y + 1) * (width + 1) + (x + 1)] = integral[y * (width + 1) + (x + 1)] + rowSum;
            }
        }
        const half = Math.floor(blockSize / 2);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const x1 = Math.max(0, x - half), y1 = Math.max(0, y - half);
                const x2 = Math.min(width - 1, x + half), y2 = Math.min(height - 1, y + half);
                const area = (x2 - x1 + 1) * (y2 - y1 + 1);
                const sum = integral[(y2 + 1) * (width + 1) + (x2 + 1)]
                    - integral[y1 * (width + 1) + (x2 + 1)]
                    - integral[(y2 + 1) * (width + 1) + x1]
                    + integral[y1 * (width + 1) + x1];
                const mean = sum / area;
                const idx = (y * width + x) * 4;
                const val = gray[y * width + x] > (mean - c) ? 255 : 0;
                d[idx] = d[idx + 1] = d[idx + 2] = val;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        return canvas;
    }

    // --- Auto crop -------------------------------------------------------
    // Finds the bounding box of "document content" (non-background pixels)
    // and crops to it, so a photo taken with background table/desk visible
    // around the page gets tightened to just the document. This is a
    // content-bounding-box crop, not a full 4-point perspective warp --
    // see the note below on why true perspective correction is out of
    // scope for a canvas-only implementation.
    function autoCrop(canvas, marginPct = 0.02) {
        const ctx = canvas.getContext("2d");
        const { width, height } = canvas;
        const imgData = ctx.getImageData(0, 0, width, height).data;

        // Sample a coarse grid (not every pixel) for speed on large photos.
        const step = Math.max(1, Math.round(Math.max(width, height) / 400));
        let minX = width, minY = height, maxX = 0, maxY = 0;
        let found = false;

        // Background is assumed near-uniform and near the image border;
        // sample the border to estimate the background brightness, then
        // treat anything sufficiently darker/lighter than that as content.
        const borderSamples = [];
        for (let x = 0; x < width; x += step) {
            borderSamples.push(pixelLuma(imgData, width, x, 0));
            borderSamples.push(pixelLuma(imgData, width, x, height - 1));
        }
        for (let y = 0; y < height; y += step) {
            borderSamples.push(pixelLuma(imgData, width, 0, y));
            borderSamples.push(pixelLuma(imgData, width, width - 1, y));
        }
        borderSamples.sort((a, b) => a - b);
        const bgLuma = borderSamples[Math.floor(borderSamples.length / 2)]; // median
        const threshold = 28; // luma delta from background to count as "content"

        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const luma = pixelLuma(imgData, width, x, y);
                if (Math.abs(luma - bgLuma) > threshold) {
                    found = true;
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
        }

        if (!found) return canvas; // uniform image (blank/solid) -- nothing to crop to

        const marginX = Math.round(width * marginPct);
        const marginY = Math.round(height * marginPct);
        minX = Math.max(0, minX - marginX);
        minY = Math.max(0, minY - marginY);
        maxX = Math.min(width - 1, maxX + marginX);
        maxY = Math.min(height - 1, maxY + marginY);

        const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
        // Refuse degenerate/near-total crops -- if content fills >97% of the
        // frame already, or the box is implausibly small, skip rather than
        // risk cutting off real content on a false read.
        if (cropW < width * 0.2 || cropH < height * 0.2) return canvas;
        if (cropW > width * 0.97 && cropH > height * 0.97) return canvas;

        const out = document.createElement("canvas");
        out.width = cropW; out.height = cropH;
        out.getContext("2d").drawImage(canvas, minX, minY, cropW, cropH, 0, 0, cropW, cropH);
        return out;
    }

    function pixelLuma(data, width, x, y) {
        const i = (y * width + x) * 4;
        return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }

    // NOTE on perspective correction: true 4-point perspective/homography
    // correction requires reliably detecting the document's four corners
    // (via contour/edge detection) and is a substantially harder CV
    // problem than the heuristics elsewhere in this file -- getting it
    // wrong (e.g. picking the wrong quad on a busy background) actively
    // damages the image, which is worse than doing nothing. A canvas-only
    // implementation without a real CV library (OpenCV.js etc.) is not
    // reliable enough to ship here. `autoCrop` above handles the common
    // "document photographed with background visible" case; genuine
    // perspective/keystone correction is listed under Remaining Work
    // rather than faked with an untrustworthy heuristic.

    // --- Brightness normalization -----------------------------------------
    // Stretches the luma histogram so the darkest content pixel maps near
    // 0 and the lightest maps near 255, correcting for under/over-exposed
    // phone-camera photos. Uses percentile clipping (2%/98%) rather than
    // true min/max so a few blown-out highlights or shadow noise pixels
    // don't dominate the stretch.
    function normalizeBrightness(canvas) {
        const ctx = canvas.getContext("2d");
        const { width, height } = canvas;
        const imgData = ctx.getImageData(0, 0, width, height);
        const d = imgData.data;

        const lumas = new Uint8ClampedArray(width * height);
        for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            lumas[p] = pixelLumaFlat(d[i], d[i + 1], d[i + 2]);
        }
        const sorted = Array.from(lumas).sort((a, b) => a - b);
        const lo = sorted[Math.floor(sorted.length * 0.02)];
        const hi = sorted[Math.floor(sorted.length * 0.98)];
        if (hi <= lo) return canvas; // degenerate (flat image) -- nothing to stretch

        const scale = 255 / (hi - lo);
        for (let i = 0; i < d.length; i += 4) {
            d[i] = clamp8((d[i] - lo) * scale);
            d[i + 1] = clamp8((d[i + 1] - lo) * scale);
            d[i + 2] = clamp8((d[i + 2] - lo) * scale);
        }
        ctx.putImageData(imgData, 0, 0);
        return canvas;
    }

    function pixelLumaFlat(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }

    // --- Sharpening (unsharp mask) -----------------------------------------
    // Classic unsharp mask: blur a copy, then push the original away from
    // the blurred version to boost edge contrast (text strokes read
    // crisper to OCR). Amount is deliberately mild -- aggressive sharpening
    // creates ringing artifacts around characters that can hurt OCR more
    // than it helps.
    function sharpen(canvas, amount = 0.5) {
        const ctx = canvas.getContext("2d");
        const { width, height } = canvas;
        if (width < 3 || height < 3) return canvas;
        const src = ctx.getImageData(0, 0, width, height);

        // Reuse the existing 3x3 box-blur as the "unsharp" base -- it's
        // already implemented above for the denoise step.
        const blurredCanvas = document.createElement("canvas");
        blurredCanvas.width = width; blurredCanvas.height = height;
        blurredCanvas.getContext("2d").putImageData(src, 0, 0);
        denoise(blurredCanvas); // in-place box blur on the copy

        const blurredData = blurredCanvas.getContext("2d").getImageData(0, 0, width, height).data;
        const out = ctx.createImageData(width, height);
        const s = src.data, o = out.data;
        for (let i = 0; i < s.length; i += 4) {
            o[i] = clamp8(s[i] + (s[i] - blurredData[i]) * amount);
            o[i + 1] = clamp8(s[i + 1] + (s[i + 1] - blurredData[i + 1]) * amount);
            o[i + 2] = clamp8(s[i + 2] + (s[i + 2] - blurredData[i + 2]) * amount);
            o[i + 3] = s[i + 3];
        }
        ctx.putImageData(out, 0, 0);
        return canvas;
    }

    function canvasToBase64(canvas, mimeType, quality) {
        const dataUrl = canvas.toDataURL(mimeType, quality);
        return { base64: dataUrl.split(",")[1], mimeType };
    }

    async function process(base64Data, mimeType, options = {}) {
        const opts = Object.assign({
            autoRotate: true,
            deskew: true,
            denoise: false,     // off by default: helps Tesseract, softens
                                 // fine print for Gemini -- opt-in per caller.
            contrast: true,
            adaptiveThreshold: false, // opt-in, see header note
            // New in Phase A (dedicated scanning engine) -- all default OFF
            // so the existing Gemini-path callers from Phase 3.11 are
            // completely unaffected unless they explicitly opt in.
            autoCrop: false,
            normalizeBrightness: false,
            sharpen: false,
            maxDim: 1600,
            quality: 0.85,
            outputMimeType: "image/jpeg"
        }, options);

        const applied = [];
        const skipped = [];

        if (!mimeType || !mimeType.startsWith("image/")) {
            // Not a raster image (e.g. a PDF page reference handled
            // upstream) -- nothing to preprocess.
            return { base64: base64Data, mimeType, steps: applied, skipped: ["not-an-image"] };
        }

        try {
            let canvas = toCanvas(await loadImage(`data:${mimeType};base64,${base64Data}`));

            if (opts.autoRotate) {
                try {
                    const orientation = getExifOrientation(base64Data);
                    if (orientation > 1) {
                        canvas = applyExifRotation(canvas, orientation);
                        applied.push("auto-rotate");
                    }
                } catch (e) { skipped.push("auto-rotate"); }
            }

            if (opts.deskew) {
                try {
                    const angle = estimateSkewAngle(canvas);
                    if (Math.abs(angle) >= 1) {
                        canvas = rotateCanvas(canvas, -angle);
                        applied.push(`deskew(${angle}deg)`);
                    }
                } catch (e) { skipped.push("deskew"); }
            }

            if (opts.autoCrop) {
                try {
                    const before = canvas;
                    canvas = autoCrop(canvas);
                    if (canvas !== before) applied.push("auto-crop");
                } catch (e) { skipped.push("auto-crop"); }
            }

            if (opts.normalizeBrightness) {
                try { canvas = normalizeBrightness(canvas); applied.push("brightness-normalize"); }
                catch (e) { skipped.push("brightness-normalize"); }
            }

            if (opts.denoise) {
                try { canvas = denoise(canvas); applied.push("denoise"); }
                catch (e) { skipped.push("denoise"); }
            }

            if (opts.contrast) {
                try { canvas = enhanceContrast(canvas); applied.push("contrast"); }
                catch (e) { skipped.push("contrast"); }
            }

            if (opts.sharpen) {
                try { canvas = sharpen(canvas); applied.push("sharpen"); }
                catch (e) { skipped.push("sharpen"); }
            }

            if (opts.adaptiveThreshold) {
                try { canvas = adaptiveThreshold(canvas); applied.push("adaptive-threshold"); }
                catch (e) { skipped.push("adaptive-threshold"); }
            }

            // Resize / compress last, once, so every earlier step works on
            // full resolution data and we only pay the encode cost once.
            if (canvas.width > opts.maxDim || canvas.height > opts.maxDim) {
                const scale = opts.maxDim / Math.max(canvas.width, canvas.height);
                const resized = document.createElement("canvas");
                resized.width = Math.round(canvas.width * scale);
                resized.height = Math.round(canvas.height * scale);
                resized.getContext("2d").drawImage(canvas, 0, 0, resized.width, resized.height);
                canvas = resized;
                applied.push("resize");
            }

            const { base64, mimeType: outMime } = canvasToBase64(canvas, opts.outputMimeType, opts.quality);
            applied.push("compress");
            return { base64, mimeType: outMime, steps: applied, skipped };
        } catch (e) {
            console.warn("[OCRPreprocessor] Preprocessing failed, using original image:", e);
            return { base64: base64Data, mimeType, steps: [], skipped: ["all (exception): " + e.message] };
        }
    }

    global.OCRPreprocessor = { process };
})(typeof window !== "undefined" ? window : globalThis);
