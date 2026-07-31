import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const output = path.join(root, "dist");

await mkdir(path.join(output, "server"), { recursive: true });
await copyFile(
  path.join(root, "sites-worker.js"),
  path.join(output, "server", "index.js"),
);

console.log("Sites worker entrypoint prepared beside dist/client.");
