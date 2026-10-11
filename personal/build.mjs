// Independent isolated build. No dotenv, server, vault access or cloud requests.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist/personal");
const manifest = JSON.parse(await readFile(path.join(root, "personal/manifest.json"), "utf8"));
const rootManifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(await readFile(path.join(root, "versions.json"), "utf8"));
if (JSON.stringify(manifest) !== JSON.stringify(rootManifest) ||
    packageMetadata.name !== manifest.id || packageMetadata.version !== manifest.version ||
    versions[manifest.version] !== manifest.minAppVersion)
  throw new Error("VaultBridge package, manifests and compatibility version map must agree.");
const workerInputs = new Set();
const excludePro = {
  name: "exclude-upstream-pro",
  setup(b) {
    b.onLoad({ filter: /[\\/]pro[\\/]/ }, (args) => {
      throw new Error(
        `VaultBridge build must not include upstream PRO source: ${args.path}`
      );
    });
  },
};
const workers = {
  name: "personal-inline-worker",
  setup(b) {
    b.onLoad({ filter: /\.worker\.ts$/ }, async (args) => {
      const worker = await build({
        absWorkingDir: root,
        entryPoints: [args.path],
        bundle: true,
        write: false,
        metafile: true,
        format: "iife",
        target: "es2020",
        platform: "browser",
        minify: true,
        plugins: [excludePro],
      });
      for (const input of Object.keys(worker.metafile.inputs))
        workerInputs.add(input);
      if (
        Object.values(worker.metafile.outputs).some((o) =>
          o.imports.some((i) => i.external)
        )
      )
        throw new Error("Native/external dependency in encryption worker.");
      return {
        loader: "js",
        contents: `export default function EncryptionWorker() { const url = URL.createObjectURL(new Blob([${JSON.stringify(worker.outputFiles[0].text)}], {type:'text/javascript'})); const worker = new Worker(url); URL.revokeObjectURL(url); return worker; }`,
      };
    });
  },
};
const result = await build({
  absWorkingDir: root,
  entryPoints: ["personal/main.ts"],
  outfile: "dist/personal/main.js",
  bundle: true,
  write: false,
  metafile: true,
  format: "cjs",
  target: "es2020",
  platform: "browser",
  minify: true,
  banner: {
    js: "/* VaultBridge: independent Apache-2.0 implementation. Reuses Apache-licensed Remotely Save components; see LICENSE and NOTICE. */",
  },
  external: ["obsidian"],
  alias: { "aggregate-error": "./personal/aggregateError.ts" },
  inject: ["esbuild.injecthelper.mjs"],
  plugins: [excludePro, workers],
  define: {
    "global.DEFAULT_DROPBOX_APP_KEY": '""',
    "global.DEFAULT_ONEDRIVE_CLIENT_ID": '""',
    "global.DEFAULT_ONEDRIVE_AUTHORITY": '""',
    global: "globalThis",
    "process.env.NODE_DEBUG": "undefined",
    "process.env.DEBUG": "undefined",
  },
});
const inputs = Array.from(
  new Set([...Object.keys(result.metafile.inputs), ...workerInputs])
);
if (inputs.some((p) => /(^|[\\/])pro[\\/]/.test(p)))
  throw new Error("Upstream PRO code found in VaultBridge bundle.");
if (
  Object.values(result.metafile.outputs).some((o) =>
    o.imports.some((i) => i.external && i.path !== "obsidian")
  )
)
  throw new Error(
    "Unexpected external dependency; build would not be mobile compatible."
  );
for (const file of result.outputFiles) {
  if (!file.path.startsWith(`${output}${path.sep}`))
    throw new Error("Unexpected output path.");
  await mkdir(path.dirname(file.path), { recursive: true });
  await writeFile(file.path, file.contents);
}
for (const name of ["manifest.json", "styles.css"])
  await writeFile(
    path.join(output, name),
    await readFile(path.join(root, "personal", name))
  );
await writeFile(
  path.join(output, "LICENSE"),
  await readFile(path.join(root, "personal/LICENSE"))
);
await writeFile(
  path.join(output, "NOTICE"),
  await readFile(path.join(root, "personal/NOTICE"))
);
await writeFile(
  path.join(output, "build-inputs.json"),
  JSON.stringify(inputs.sort(), null, 2)
);
console.log(
  `VaultBridge built at ${output}. ${inputs.length} inputs audited; no PRO sources included.`
);
