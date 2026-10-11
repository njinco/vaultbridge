// Audit an existing build without executing the plugin or accessing the network.
import { readFile } from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const metadata = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8")
);
const inputs = JSON.parse(
  await readFile(path.join(root, "dist/personal/build-inputs.json"), "utf8")
);
const unused = Object.keys(metadata.dependencies).filter(
  (name) => !inputs.some((input) => input.startsWith(`node_modules/${name}/`))
);
if (unused.length)
  throw new Error(
    `Unbundled direct dependencies belong in devDependencies: ${unused.join(", ")}`
  );
console.log(
  `${Object.keys(metadata.dependencies).length} direct runtime dependencies appear in the audited bundle. Retained tooling and compatibility dependencies are development-only.`
);
