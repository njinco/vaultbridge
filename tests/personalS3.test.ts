import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import {
  encryptArrayBuffer,
  encryptStringToBase64url,
} from "../src/encryptOpenSSL";

// Exercise the actual bundled S3 + encryption adapters against an in-memory
// requestUrl replacement. Dummy credentials are signed but never transmitted.
async function runPreview(
  encryption: string,
  key: string,
  content: ArrayBuffer
) {
  const calls: { url: string; method?: string }[] = [],
    notices: string[] = [],
    modals: { plan?: { changes: { action: string; path: string }[] } }[] = [];
  const note = new TextEncoder().encode("existing note\n").buffer;
  class Plugin {
    manifest = { id: "vaultbridge" };
    app = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          list: async () => ({ files: ["note.md"], folders: [] }),
          stat: async () => ({ type: "file", size: note.byteLength }),
          readBinary: async () => note,
          writeBinary: async () => {
            throw Error("Unexpected vault write during preview");
          },
        },
      },
    };
    async saveData() {}
    async loadData() {
      return null;
    }
    addSettingTab() {}
    addCommand() {}
    addRibbonIcon() {}
  }
  const button = {
    setButtonText() {
      return this;
    },
    setCta() {
      return this;
    },
    setDisabled() {
      return this;
    },
    onClick() {
      return this;
    },
  };
  const el = {
    empty() {},
    createEl() {
      return el;
    },
  };
  class Modal {
    plan?: { changes: { action: string; path: string }[] };
    contentEl = el;
    constructor(_app: unknown) {}
    onOpen() {}
    onClose() {}
    close() {
      this.onClose();
      const index = modals.indexOf(this);
      if (index >= 0) modals.splice(index, 1);
    }
    open() {
      modals.push(this);
      this.onOpen();
    }
  }
  class Setting {
    constructor(_el: unknown) {}
    addButton(f: (b: typeof button) => void) {
      f(button);
      return this;
    }
  }
  const obsidian = {
    Plugin,
    PluginSettingTab: class {},
    Modal,
    Setting,
    Notice: class {
      constructor(text: string) {
        notices.push(text);
      }
    },
    Platform: { isDesktopApp: false, isAndroidApp: true },
    requireApiVersion: () => true,
    requestUrl: async (r: { url: string; method?: string }) => {
      calls.push(r);
      assert.equal(r.method, "GET");
      const url = new URL(r.url);
      assert.equal(url.hostname, "s3.example.test");
      if (url.searchParams.get("list-type") === "2") {
        assert.equal(url.searchParams.get("prefix"), "existing/");
        const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name><IsTruncated>false</IsTruncated><KeyCount>1</KeyCount><Contents><Key>existing/${key}</Key><LastModified>2024-01-01T00:00:00.000Z</LastModified><Size>${content.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents></ListBucketResult>`;
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          arrayBuffer: new TextEncoder().encode(xml).buffer,
        };
      }
      assert.equal(decodeURIComponent(url.pathname), `/bucket/existing/${key}`);
      return {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(content.byteLength),
        },
        arrayBuffer: content,
      };
    },
  };
  const module = {
    exports: {} as {
      default: new () => {
        state: unknown;
        sessionPassword: string;
        start(): Promise<void>;
      };
    },
  };
  const dom = new JSDOM().window;
  const context: Record<string, unknown> = {
    module,
    exports: module.exports,
    require: (name: string) => {
      assert.equal(name, "obsidian");
      return obsidian;
    },
    crypto: webcrypto,
    structuredClone,
    DOMParser: dom.DOMParser,
    Node: dom.Node,
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
    ReadableStream,
    TransformStream,
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    setTimeout,
    clearTimeout,
    fetch: () => {
      throw Error("Unexpected fetch; native Obsidian transport required.");
    },
  };
  context.window = context;
  const bundle = readFileSync("dist/personal/main.js", "utf8");
  runInNewContext(bundle, context, { timeout: 5000 });
  const plugin = new module.exports.default();
  plugin.sessionPassword = "test-only-password";
  plugin.state = {
    histories: {},
    settings: {
      provider: "s3",
      encryption,
      password:
        encryption === "none" || encryption === "unset"
          ? ""
          : "test-only-password",
      s3: {
        s3Endpoint: "https://s3.example.test",
        s3Region: "us-east-1",
        s3AccessKeyID: "dummy-id",
        s3SecretAccessKey: "dummy-secret",
        s3BucketName: "bucket",
        remotePrefix: "existing/",
        bypassCorsLocally: true,
        partsConcurrency: 2,
        forcePathStyle: true,
        useAccurateMTime: false,
      },
    },
  };
  await plugin.start();
  return { calls, notices, modals };
}
describe("Personal build: existing S3 layout", () => {
  before(function () {
    if (!existsSync("dist/personal/main.js")) this.skip();
  });
  it("previews an existing plaintext S3 prefix with the mobile native transport", async () => {
    const result = await runPreview(
      "none",
      "note.md",
      new TextEncoder().encode("existing note\n").buffer
    );
    assert.equal(result.modals.length, 1, result.notices.join(" | "));
    assert.deepEqual(
      Array.from(
        result.modals[0].plan?.changes ?? [],
        (x) => `${x.action}:${x.path}`
      ),
      ["equal:note.md"]
    );
    assert.ok(result.calls.length >= 2);
  });
  it("reads the existing Apache OpenSSL filename/content format without migrating it", async () => {
    global.window = { crypto: webcrypto } as any;
    const key = await encryptStringToBase64url("note.md", "test-only-password");
    const content = await encryptArrayBuffer(
      new TextEncoder().encode("existing note\n").buffer,
      "test-only-password"
    );
    const result = await runPreview("openssl-base64", key!, content!);
    assert.equal(result.modals.length, 1, result.notices.join(" | "));
    assert.deepEqual(
      Array.from(
        result.modals[0].plan?.changes ?? [],
        (x) => `${x.action}:${x.path}`
      ),
      ["equal:note.md"]
    );
  });
  it("refuses known OpenSSL-encrypted names when unencrypted was selected", async () => {
    global.window = { crypto: webcrypto } as any;
    const key = await encryptStringToBase64url("note.md", "test-only-password");
    const result = await runPreview("none", key!, new ArrayBuffer(0));
    assert.match(result.notices.join(" | "), /Remote uses encryption/);
    assert.equal(result.modals.length, 0);
    assert.ok(result.calls.every((r) => r.method === "GET"));
  });
  it("makes no S3 request until the encryption choice is explicit", async () => {
    const result = await runPreview("unset", "note.md", new ArrayBuffer(0));
    assert.match(result.notices.join(" | "), /Select the encryption/);
    assert.equal(result.calls.length, 0);
    assert.equal(result.modals.length, 0);
  });
});
