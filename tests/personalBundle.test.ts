import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { harness } from "./helpers/vaultBridgeHarness";
import type { Provider } from "../personal/cloud";

describe("Personal bundle boundary and startup", () => {
  it("does not ship Box API or authorization endpoints", function () {
    if (!existsSync("dist/personal/main.js")) this.skip();
    const bundle = readFileSync("dist/personal/main.js", "utf8");
    assert.ok(!/(?:api|upload|account)\.box\.com|\.boxcloud\.com/.test(bundle));
    const manifest = JSON.parse(readFileSync("dist/personal/manifest.json", "utf8"));
    assert.ok(!/\bBox\b/.test(manifest.description));
  });
  it("blocks an old Box selection without contacting another provider", async function () {
    if (!existsSync("dist/personal/main.js")) this.skip();
    const h = harness("");
    h.plugin.state.settings.provider = "box" as Provider;
    await h.plugin.start();
    assert.equal(h.calls.length, 0);
    assert.equal(h.localWrites.length, 0);
    assert.equal(h.workers.length, 0);
    assert.equal(h.plugin.busy, false);
    assert.equal(h.plugin.state.settings.provider, "box");
    assert.ok(h.notices.some((n) => n.includes("Choose S3, Google Drive or Dropbox")));
  });
  it("contains no PRO input, including encryption workers", function () {
    if (!existsSync("dist/personal/build-inputs.json")) this.skip();
    const inputs = JSON.parse(
      readFileSync("dist/personal/build-inputs.json", "utf8")
    ) as string[];
    assert.ok(inputs.some((x) => x.endsWith("src/encryptRClone.worker.ts")));
    assert.ok(inputs.every((x) => !/(^|[\\/])pro[\\/]/.test(x)));
  });
  it("loads without accessing vault files, cloud APIs, native Node APIs or starting timers", async function () {
    if (!existsSync("dist/personal/main.js")) this.skip();
    let vaultReads = 0,
      http = 0,
      timers = 0;
    class Plugin {
      app = {
        vault: {
          adapter: new Proxy(
            {},
            {
              get() {
                vaultReads++;
                throw Error("unexpected vault access");
              },
            }
          ),
        },
      };
      async loadData() {
        return null;
      }
      addSettingTab() {}
      addCommand() {}
      addRibbonIcon() {}
    }
    const obsidian = {
      Plugin,
      PluginSettingTab: class {},
      Modal: class {},
      Notice: class {},
      Platform: { isDesktopApp: false },
      requireApiVersion: () => true,
      requestUrl: () => {
        http++;
        throw Error("unexpected HTTP");
      },
    };
    const module = {
      exports: {} as { default?: new () => { onload(): Promise<void> } },
    };
    const context = {
      module,
      exports: module.exports,
      require: (name: string) => {
        assert.equal(name, "obsidian");
        return obsidian;
      },
      crypto: webcrypto,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      Blob,
      btoa,
      atob,
      AbortController,
      Headers,
      Request,
      Response,
      console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
      fetch: () => {
        http++;
        throw Error("unexpected fetch");
      },
      setTimeout: () => {
        timers++;
        throw Error("unexpected timer");
      },
      clearTimeout() {},
    };
    runInNewContext(readFileSync("dist/personal/main.js", "utf8"), context, {
      timeout: 5000,
    });
    assert.ok(module.exports.default);
    const plugin = new module.exports.default();
    await plugin.onload();
    assert.equal(vaultReads, 0);
    assert.equal(http, 0);
    assert.equal(timers, 0);
  });
});
