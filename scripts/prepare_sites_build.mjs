import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const output = path.join(root, "dist");

await mkdir(path.join(output, "server"), { recursive: true });
await mkdir(path.join(output, ".openai"), { recursive: true });
await copyFile(
  path.join(root, "sites-worker.js"),
  path.join(output, "server", "index.js"),
);
await copyFile(
  path.join(root, ".openai", "hosting.json"),
  path.join(output, ".openai", "hosting.json"),
);

console.log("Sites worker entrypoint and hosting metadata prepared.");
