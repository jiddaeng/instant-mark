import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pdfjs from "pdfjs-dist/legacy/build/pdf.js";

import { analyzeGojangeePdf } from "../pdf-indexer.js";

const [, , sourcePath, outputPath = "olympus-index.json"] = process.argv;

if (!sourcePath) {
  throw new Error(
    "Usage: node scripts/build_olympus_index.mjs <source.pdf> [output.json]",
  );
}

const pdfBytes = await readFile(sourcePath);
const sourceHash = createHash("sha256").update(pdfBytes).digest("hex");
const loadingTask = pdfjs.getDocument({
  data: new Uint8Array(pdfBytes),
  isEvalSupported: false,
});
const pdfDocument = await loadingTask.promise;

try {
  const index = await analyzeGojangeePdf({
    pdfDocument,
    Util: pdfjs.Util,
    sourceHash,
    fileName: path.basename(sourcePath),
    onProgress({ pageNumber, pageCount }) {
      process.stdout.write(`\rAnalyzing ${pageNumber}/${pageCount}`);
    },
  });
  index.source.url = "./olympus_common_math_2_answers.pdf";
  await writeFile(outputPath, `${JSON.stringify(index)}\n`, "utf8");
  process.stdout.write(
    `\nCreated ${outputPath}: ${index.sections.length} sections, ${index.range.count} problems\n`,
  );
} finally {
  await pdfDocument.destroy();
}
