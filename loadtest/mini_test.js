const path = require("path");
const { createWorker } = require("tesseract.js");

(async () => {
    try {
        const worker = await createWorker("eng", 1, {
            langPath: path.join(__dirname, "langdata"),
            corePath: path.join(__dirname, "node_modules/tesseract.js-core/tesseract-core.wasm.js"),
            gzip: true,
            logger: m => console.log("[tesseract]", JSON.stringify(m))
        });
        console.log("Worker created OK");
        const result = await worker.recognize(path.join(__dirname, "images", "bill_clean_000.png"));
        console.log("TEXT:", result.data.text.slice(0, 200));
        console.log("CONFIDENCE:", result.data.confidence);
        await worker.terminate();
    } catch (e) {
        console.error("ERROR:", e);
    }
})();
