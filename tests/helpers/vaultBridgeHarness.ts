import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import type { Plan } from "../../personal/engine";
import type { Settings } from "../../personal/storage";

export const encode = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer;
export const decode = (b: ArrayBuffer): string => new TextDecoder().decode(b);
export interface TestModal {
  plan?: Plan;
  onOpen(): void;
  onClose(): void;
  open(): void;
  close(): void;
}
// Message ports copy payloads and detach transferred ArrayBuffers, as browser
// workers do. They do not use Node MessagePorts, sockets, processes or timers.
class Port {
  peer!: Port;
  onmessage?: (event: { data: unknown }) => void;
  onmessageerror?: (error: unknown) => void;
  closed = false;
  postMessage(data: unknown, transfer: ArrayBuffer[] = []) {
    const copy = structuredClone(data, { transfer });
    queueMicrotask(() => {
      if (!this.peer.closed) this.peer.onmessage?.({ data: copy });
    });
  }
  close() {
    this.closed = true;
  }
}
class Channel {
  port1 = new Port();
  port2 = new Port();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}
const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function harness(password: string, desktop = false, options: {
  workerMode?: "silent" | "crash";
  beforeRequest?: (request: { method?: string }) => Promise<void>;
} = {}) {
  const local = new Map<string, ArrayBuffer>(),
    remote = new Map<string, ArrayBuffer>();
  const localWrites: string[] = [],
    calls: { method: string; key?: string }[] = [],
    notices: string[] = [],
    logs: unknown[][] = [];
  const modals: TestModal[] = [],
    buttons = new Map<string, () => unknown>(),
    workers: { terminated: boolean }[] = [];
  let textChange: ((value: string) => void) | undefined;
  const channels: Channel[] = [];
  class HarnessChannel extends Channel {
    constructor() { super(); channels.push(this); }
  }
  const logger = Object.fromEntries(
    ["log", "info", "debug", "warn", "error"].map((k) => [
      k,
      (...v: unknown[]) => {
        logs.push(v);
      },
    ])
  );
  const blobURLs = new Map<string, Blob>();
  let nextURL = 0;
  class BrowserURL extends URL {
    static createObjectURL(blob: Blob) {
      const url = `blob:test-${++nextURL}`;
      blobURLs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url: string) {
      blobURLs.delete(url);
    }
  }
  class BrowserWorker {
    onerror?: () => void;
    terminated = false;
    listener?: (event: { data: unknown; ports: Port[] }) => Promise<void>;
    ready: Promise<void>;
    constructor(url: string) {
      const blob = blobURLs.get(url);
      assert.ok(blob, "worker Blob must exist at construction");
      workers.push(this);
      this.ready = blob.text().then((code) => {
        const scope: Record<string, unknown> = {
          crypto: webcrypto,
          TextEncoder,
          TextDecoder,
          ArrayBuffer,
          Uint8Array,
          Uint32Array,
          Int32Array,
          DataView,
          console: logger,
          setTimeout,
          clearTimeout,
          queueMicrotask,
          addEventListener: (name: string, fn: typeof this.listener) => {
            assert.equal(name, "message");
            this.listener = fn;
          },
        };
        scope.self = scope;
        scope.window = scope;
        runInNewContext(code, scope, { timeout: 5000 });
      });
    }
    postMessage(data: unknown, transfer: (Port | ArrayBuffer)[]) {
      if (options.workerMode === "silent") return;
      if (options.workerMode === "crash") {
        queueMicrotask(() => this.onerror?.());
        return;
      }
      const buffers = transfer.filter(
        (x) => Object.prototype.toString.call(x) === "[object ArrayBuffer]"
      ) as ArrayBuffer[];
      const copy = structuredClone(data, { transfer: buffers });
      const ports = transfer.filter((x) => x instanceof Port) as Port[];
      void this.ready.then(async () => {
        if (this.terminated) throw Error("Worker already terminated");
        assert.ok(this.listener);
        await this.listener({ data: copy, ports });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  const dirs = () => {
    const result = new Set<string>();
    for (const p of local.keys()) {
      const parts = p.split("/");
      for (let n = 1; n < parts.length; n++)
        result.add(parts.slice(0, n).join("/"));
    }
    return result;
  };
  class Plugin {
    manifest = { id: "vaultbridge" };
    app = {
      vault: {
        configDir: ".obsidian",
        adapter: {
          list: async (path: string) => {
            const prefix = path ? `${path}/` : "";
            const direct = (p: string) =>
              p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
            return {
              files: Array.from(local.keys()).filter(direct),
              folders: Array.from(dirs()).filter(direct),
            };
          },
          stat: async (p: string) =>
            local.has(p)
              ? { type: "file", size: local.get(p)!.byteLength }
              : dirs().has(p)
                ? { type: "folder", size: 0 }
                : null,
          exists: async (p: string) => local.has(p) || dirs().has(p),
          mkdir: async (_p: string) => {},
          readBinary: async (p: string) => {
            assert.ok(local.has(p), `missing local ${p}`);
            return local.get(p)!.slice(0);
          },
          writeBinary: async (p: string, b: ArrayBuffer) => {
            localWrites.push(p);
            local.set(p, b.slice(0));
          },
        },
      },
    };
    saved: unknown[] = [];
    loaded: unknown = null;
    async saveData(data: unknown) {
      this.saved.push(structuredClone(data));
    }
    async loadData() {
      return this.loaded;
    }
    addSettingTab() {}
    addCommand() {}
    addRibbonIcon() {}
  }
  const el = {
    createEl() {
      return el;
    },
    empty() {},
  };
  class Modal implements TestModal {
    plan?: Plan;
    contentEl = el;
    constructor(_app: unknown) {}
    onOpen() {}
    onClose() {}
    open() {
      modals.push(this);
      this.onOpen();
    }
    close() {
      this.onClose();
    }
  }
  class Setting {
    constructor(_el: unknown) {}
    setName(_s: string) {
      return this;
    }
    setDesc(_s: string) {
      return this;
    }
    addText(f: (t: any) => void) {
      const t = {
        inputEl: { type: "text" },
        onChange(fn: (v: string) => void) {
          textChange = fn;
          return t;
        },
      };
      f(t);
      return this;
    }
    addDropdown(f: (d: any) => void) {
      const d = {
        addOptions() {
          return d;
        },
        setValue() {
          return d;
        },
        onChange() {
          return d;
        },
      };
      f(d);
      return this;
    }
    addButton(f: (b: any) => void) {
      let label = "";
      const b = {
        setButtonText(s: string) {
          label = s;
          return b;
        },
        setCta() {
          return b;
        },
        setDisabled() {
          return b;
        },
        onClick(fn: () => unknown) {
          buttons.set(label, fn);
          return b;
        },
      };
      f(b);
      return this;
    }
  }
  const obsidian = {
    Plugin,
    PluginSettingTab: class {},
    Modal,
    Setting,
    Notice: class {
      constructor(s: string) {
        notices.push(s);
      }
    },
    Platform: { isDesktopApp: desktop, isAndroidApp: !desktop },
    requireApiVersion: () => true,
    requestUrl: async (r: {
      url: string;
      method?: string;
      body?: ArrayBuffer;
      headers?: Record<string, string>;
    }) => {
      const url = new URL(r.url);
      assert.equal(url.hostname, "s3.example.test");
      await options.beforeRequest?.(r);
      const method = r.method ?? "GET";
      if (url.searchParams.get("list-type") === "2") {
        calls.push({ method });
        assert.equal(method, "GET");
        assert.equal(url.searchParams.get("prefix"), "existing/");
        const contents = Array.from(
          remote,
          ([key, b]) =>
            `<Contents><Key>existing/${xml(key)}</Key><LastModified>2024-01-01T00:00:00Z</LastModified><Size>${b.byteLength}</Size></Contents>`
        ).join("");
        return {
          status: 200,
          headers: { "content-type": "application/xml" },
          arrayBuffer: encode(
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`
          ),
        };
      }
      const path = decodeURIComponent(url.pathname);
      assert.ok(path.startsWith("/bucket/existing/"));
      const key = path.slice("/bucket/existing/".length);
      calls.push({ method, key });
      if (method === "PUT") {
        assert.ok(r.body);
        remote.set(key, r.body.slice(0));
      } else assert.ok(["GET", "HEAD"].includes(method));
      assert.ok(remote.has(key), "remote object must exist");
      return {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(remote.get(key)!.byteLength),
          etag: '"test-etag"',
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
          "x-amz-meta-mtime": "1704067200",
          "x-amz-meta-ctime": "1704067200",
        },
        arrayBuffer:
          method === "GET" ? remote.get(key)!.slice(0) : new ArrayBuffer(0),
      };
    },
  };
  const dom = new JSDOM().window;
  const module = {
    exports: {} as {
      default: new () => Plugin & {
        state: { settings: Settings; histories: Record<string, unknown> };
        sessionPassword: string;
        busy: boolean;
        start(): Promise<void>;
        onload(): Promise<void>;
        onunload(): void;
      };
    },
  };
  const context: Record<string, unknown> = {
    module,
    exports: module.exports,
    require: (name: string) => {
      assert.equal(name, "obsidian");
      return obsidian;
    },
    crypto: webcrypto,
    structuredClone,
    ArrayBuffer,
    Uint8Array,
    Uint32Array,
    Int32Array,
    DataView,
    DOMParser: dom.DOMParser,
    Node: dom.Node,
    TextEncoder,
    TextDecoder,
    URL: BrowserURL,
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
    Worker: BrowserWorker,
    MessageChannel: HarnessChannel,
    console: logger,
    setTimeout: (fn: (...args: any[]) => void, ms: number, ...args: any[]) =>
      setTimeout(fn, options.workerMode && ms === 120000 ? 15 : ms, ...args),
    clearTimeout,
    queueMicrotask,
    fetch: () => {
      throw Error("Real network access is forbidden in this test.");
    },
  };
  context.window = context;
  // Execute the exact candidate bytes, including its safe error notices.
  const bundle = readFileSync("dist/personal/main.js", "utf8");
  runInNewContext(bundle, context, { timeout: 5000 });
  const plugin = new module.exports.default();
  plugin.sessionPassword = password;
  plugin.state.settings = {
    ...plugin.state.settings,
    provider: "s3",
    encryption: "rclone-base64",
    password: "",
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
  };
  return {
    plugin,
    local,
    remote,
    calls,
    localWrites,
    notices,
    logs,
    workers,
    channels,
    cancel() { const cancel = buttons.get("Cancel"); assert.ok(cancel); return cancel(); },
    async preview() {
      modals.length = 0;
      buttons.clear();
      await plugin.start();
      return modals.at(-1)?.plan;
    },
    async apply() {
      const fn = buttons.get("Apply reviewed plan");
      assert.ok(fn);
      try {
        await fn();
      } catch (e) {
        throw new Error(
          `${String(e)}; worker diagnostics: ${logs.flat().map(String).join(" | ")}`
        );
      }
    },
    async unlock(password: string) {
      assert.ok(textChange);
      textChange(password);
      const fn = buttons.get("Unlock");
      assert.ok(fn);
      await fn();
    },
    close() {
      modals.at(-1)?.close();
    },
  };
}
