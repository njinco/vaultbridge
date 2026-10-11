import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { JSDOM } from "jsdom";
import type { Plan } from "../../personal/engine";
import type { Settings } from "../../personal/storage";
import type { Saved } from "../../personal/state";
export interface NativeRequest {
  url: string;
  method?: string;
  body?: ArrayBuffer | string;
  headers?: Record<string, string>;
}
export interface NativeReply {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

export const encode = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer;
export const decode = (b: ArrayBuffer): string => new TextDecoder().decode(b);
export interface TestModal {
  plan?: Plan;
  contentEl: HTMLElement;
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
export function harness(
  password: string,
  desktop = false,
  options: {
    workerMode?: "silent" | "crash";
    beforeRequest?: (request: NativeRequest) => Promise<void>;
    cloudResponse?: (request: NativeRequest) => Promise<NativeReply>;
    omitETags?: boolean;
    putStatus?: number;
  } = {}
) {
  const local = new Map<string, ArrayBuffer>(),
    remote = new Map<string, ArrayBuffer>();
  const localWrites: string[] = [],
    calls: {
      method: string;
      key?: string;
      url?: string;
      headers?: Record<string, string>;
    }[] = [],
    notices: string[] = [],
    logs: unknown[][] = [];
  const modals: TestModal[] = [],
    buttons = new Map<string, () => unknown>(),
    workers: { terminated: boolean }[] = [];
  const textChanges = new Map<string, (value: string) => unknown>();
  const dropdownChanges = new Map<string, (value: string) => unknown>();
  const dom = new JSDOM().window;
  Object.assign(dom.HTMLElement.prototype, {
    createEl(
      this: HTMLElement,
      tag: string,
      options: {
        text?: string;
        cls?: string;
        attr?: Record<string, string>;
      } = {}
    ) {
      const child = dom.document.createElement(tag);
      if (options.text !== undefined) child.textContent = options.text;
      if (options.cls) child.className = options.cls;
      for (const [name, value] of Object.entries(options.attr ?? {}))
        child.setAttribute(name, value);
      this.appendChild(child);
      return child;
    },
    empty(this: HTMLElement) {
      this.replaceChildren();
    },
  });
  let settingsTab: { display(): void; containerEl: HTMLElement } | undefined;
  let textChange: ((value: string) => void) | undefined;
  const channels: Channel[] = [];
  class HarnessChannel extends Channel {
    constructor() {
      super();
      channels.push(this);
    }
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
          trashLocal: async (p: string) => {
            assert.ok(local.has(p));
            local.set(`.trash/${p}`, local.get(p)!);
            local.delete(p);
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
    addSettingTab(tab: typeof settingsTab) {
      settingsTab = tab;
    }
    addCommand() {}
    addRibbonIcon() {}
  }
  class Modal implements TestModal {
    plan?: Plan;
    contentEl = dom.document.createElement("div");
    constructor(readonly app: unknown) {}
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
    private name = "";
    constructor(readonly element: HTMLElement) {}
    setName(s: string) {
      this.name = s;
      this.element.createEl("span", { text: s });
      return this;
    }
    setDesc(s: string) {
      this.element.createEl("p", { text: s });
      return this;
    }
    addText(f: (t: any) => void) {
      const inputEl = this.element.createEl("input");
      const name = this.name;
      const t = {
        inputEl,
        setValue(value: string) {
          inputEl.value = value;
          return t;
        },
        onChange(fn: (v: string) => void) {
          textChange = fn;
          textChanges.set(name, fn);
          inputEl.addEventListener("input", () => fn(inputEl.value));
          return t;
        },
      };
      f(t);
      return this;
    }
    addTextArea(f: (t: any) => void) {
      const inputEl = this.element.createEl("textarea");
      const name = this.name;
      const t = {
        inputEl,
        setValue(value: string) {
          inputEl.value = value;
          return t;
        },
        onChange(fn: (v: string) => unknown) {
          textChanges.set(name, fn);
          inputEl.addEventListener("input", () => {
            void fn(inputEl.value);
          });
          return t;
        },
      };
      f(t);
      return this;
    }
    addDropdown(f: (d: any) => void) {
      const name = this.name;
      const d = {
        addOptions() {
          return d;
        },
        setValue() {
          return d;
        },
        onChange(fn: (value: string) => unknown) {
          dropdownChanges.set(name, fn);
          return d;
        },
      };
      f(d);
      return this;
    }
    addToggle(f: (toggle: any) => void) {
      const toggle = {
        setValue() {
          return toggle;
        },
        onChange() {
          return toggle;
        },
      };
      f(toggle);
      return this;
    }
    addButton(f: (b: any) => void) {
      let label = "";
      const button = this.element.createEl("button");
      const b = {
        setButtonText(s: string) {
          label = s;
          button.textContent = s;
          return b;
        },
        setCta() {
          return b;
        },
        setDisabled(value: boolean) {
          button.disabled = value;
          return b;
        },
        onClick(fn: () => unknown) {
          buttons.set(label, fn);
          button.addEventListener("click", () => {
            void fn();
          });
          return b;
        },
      };
      f(b);
      return this;
    }
  }
  const obsidian = {
    Plugin,
    PluginSettingTab: class {
      containerEl = dom.document.createElement("div");
      constructor(readonly app: unknown) {}
    },
    Modal,
    Setting,
    Notice: class {
      constructor(s: string) {
        notices.push(s);
      }
    },
    Platform: { isDesktopApp: desktop, isAndroidApp: !desktop },
    requireApiVersion: () => true,
    requestUrl: async (r: NativeRequest) => {
      const url = new URL(r.url);
      await options.beforeRequest?.(r);
      const method = r.method ?? "GET";
      if (url.hostname !== "s3.example.test") {
        assert.ok(options.cloudResponse, "No real cloud transport is allowed");
        calls.push({ method, url: r.url, headers: r.headers });
        return options.cloudResponse(r);
      }
      const version = (key: string) =>
        `"${createHash("md5")
          .update(new Uint8Array(remote.get(key)!))
          .digest("hex")}"`;
      const error = (status: number) => ({
        status,
        headers: { "content-type": "application/xml" },
        arrayBuffer: encode(
          `<Error><Code>${status === 412 ? "PreconditionFailed" : "NotImplemented"}</Code><Message>private provider detail</Message></Error>`
        ),
      });
      if (url.searchParams.get("list-type") === "2") {
        calls.push({ method });
        assert.equal(method, "GET");
        assert.equal(url.searchParams.get("prefix"), "existing/");
        const contents = Array.from(
          remote,
          ([key, b]) =>
            `<Contents><Key>existing/${xml(key)}</Key><LastModified>2024-01-01T00:00:00Z</LastModified><Size>${b.byteLength}</Size>${options.omitETags ? "" : `<ETag>${version(key)}</ETag>`}</Contents>`
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
      calls.push({ method, key, headers: r.headers });
      if (method === "PUT") {
        assert.ok(r.body);
        assert.ok(
          r.headers?.["if-match"] || r.headers?.["if-none-match"],
          "Every PUT must be conditional"
        );
        if (options.putStatus) return error(options.putStatus);
        if (
          (r.headers?.["if-none-match"] === "*" && remote.has(key)) ||
          (r.headers?.["if-match"] !== undefined &&
            (!remote.has(key) || r.headers["if-match"] !== version(key)))
        )
          return error(412);
        assert.ok(typeof r.body !== "string");
        remote.set(key, r.body.slice(0));
      } else assert.ok(["GET", "HEAD"].includes(method));
      if (
        method === "GET" &&
        r.headers?.["if-match"] !== undefined &&
        (!remote.has(key) || r.headers["if-match"] !== version(key))
      )
        return error(412);
      assert.ok(remote.has(key), "remote object must exist");
      return {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(remote.get(key)!.byteLength),
          ...(options.omitETags ? {} : { etag: version(key) }),
          "last-modified": "Mon, 01 Jan 2024 00:00:00 GMT",
          "x-amz-meta-mtime": "1704067200",
          "x-amz-meta-ctime": "1704067200",
        },
        arrayBuffer:
          method === "GET" ? remote.get(key)!.slice(0) : new ArrayBuffer(0),
      };
    },
  };
  const module = {
    exports: {} as {
      default: new () => Plugin & {
        state: Saved;
        sessionPassword: string;
        busy: boolean;
        start(checkOnly?: boolean): Promise<void>;
        onload(): Promise<void>;
        onunload(): void;
        browseBackups(): Promise<void>;
        persist(): Promise<void>;
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
    modals,
    async click(label: string) {
      const fn = buttons.get(label);
      assert.ok(fn, label);
      await fn();
    },
    changeText(label: string, value: string) {
      const fn = textChanges.get(label);
      assert.ok(fn, label);
      return fn(value);
    },
    changeDropdown(label: string, value: string) {
      const fn = dropdownChanges.get(label);
      assert.ok(fn, label);
      return fn(value);
    },
    displaySettings() {
      assert.ok(settingsTab);
      settingsTab.display();
      return settingsTab.containerEl;
    },
    channels,
    cancel() {
      const cancel = buttons.get("Cancel");
      assert.ok(cancel);
      return cancel();
    },
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
