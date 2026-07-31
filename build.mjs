import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(root, "dist");
const files = ["index.html", "style.css", "script.js", "data.json"];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

await Promise.all(
  files.map((file) =>
    copyFile(path.join(root, file), path.join(output, file)),
  ),
);
await cp(path.join(root, "images"), path.join(output, "images"), {
  recursive: true,
});

console.log(`Static site built in ${output}`);
