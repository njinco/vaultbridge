import { strict as assert } from "node:assert";
import { WorkerRequests } from "../src/workerRequests";
import { SyncRun } from "../personal/run";
import { apply, preview, type Store } from "../personal/engine";
import { harness, encode } from "./helpers/vaultBridgeHarness";

function fakeWorker(reply?: (port: MessagePort) => void) {
  const worker = {
    terminated: false,
    onerror: null as null | (() => void),
    onmessageerror: null as null | (() => void),
    postMessage(_message: unknown, ports: Transferable[]) {
      reply?.(ports[0] as MessagePort);
    },
    terminate() {
      this.terminated = true;
    },
  };
  return worker;
}
describe("Encryption worker lifecycle", () => {
  it("times out a silent worker, terminates it and rejects future requests", async () => {
    const worker = fakeWorker();
    const requests = new WorkerRequests([worker as unknown as Worker], 15);
    await assert.rejects(
      requests.request(worker as unknown as Worker, {}, () => 1),
      /timed out/
    );
    assert.equal(worker.terminated, true);
    assert.throws(
      () => requests.request(worker as unknown as Worker, {}, () => 1),
      /closed/
    );
  });
  it("rejects every outstanding request on close and tolerates repeated close", async () => {
    const worker = fakeWorker();
    const requests = new WorkerRequests([worker as unknown as Worker]);
    const a = requests.request(worker as unknown as Worker, {}, () => 1);
    const b = requests.request(worker as unknown as Worker, {}, () => 1);
    const results = Promise.allSettled([a, b]);
    requests.close();
    requests.close();
    assert.ok((await results).every((r) => r.status === "rejected"));
    assert.equal(worker.terminated, true);
  });
  it("handles worker crashes and postMessage failures without exposing raw details", async () => {
    for (const mode of ["crash", "send", "message"]) {
      const worker = fakeWorker();
      if (mode === "send")
        worker.postMessage = () => {
          throw Error("private payload");
        };
      const requests = new WorkerRequests([worker as unknown as Worker]);
      const result = requests.request(worker as unknown as Worker, {}, () => 1);
      if (mode === "crash") worker.onerror!();
      if (mode === "message") worker.onmessageerror!();
      await assert.rejects(
        result,
        (error: Error) => !error.message.includes("private")
      );
      assert.equal(worker.terminated, true);
    }
  });
  it("settles successful replies and rejects malformed replies", async () => {
    for (const valid of [true, false]) {
      const worker = fakeWorker((port) => {
        port.postMessage(valid ? "ok" : null);
        port.close();
      });
      const requests = new WorkerRequests([worker as unknown as Worker], 100);
      const result = requests.request(
        worker as unknown as Worker,
        {},
        (value) => {
          if (typeof value !== "string") throw Error("private value");
          return value;
        }
      );
      if (valid) assert.equal(await result, "ok");
      else await assert.rejects(result, /invalid result/);
      requests.close();
    }
  });
});

describe("Cooperative sync cancellation", () => {
  it("cancels after a read settles and performs no later reads or writes", async () => {
    const run = new SyncRun();
    let reads = 0,
      writes = 0;
    const store: Store = {
      async list() {
        return [{ path: "a.md" }, { path: "b.md" }];
      },
      async read() {
        reads++;
        run.cancel();
        return encode("a");
      },
      async write() {
        writes++;
      },
    };
    await assert.rejects(
      preview(run.store(store), run.store(store), {}),
      /cancelled/
    );
    assert.equal(reads, 1);
    assert.equal(writes, 0);
  });
  it("waits for an in-flight write, then stops before the next write or checkpoint", async () => {
    const run = new SyncRun();
    const files = new Map([
      ["a.md", encode("a")],
      ["b.md", encode("b")],
    ]);
    let writes = 0,
      checkpoints = 0;
    const local: Store = {
      async list() {
        return [...files.keys()].map((path) => ({ path }));
      },
      async read(path) {
        return files.get(path)!;
      },
      async write() {
        throw Error("unexpected local write");
      },
    };
    const remoteFiles = new Map<string, ArrayBuffer>();
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const remote: Store = {
      async list() {
        return [...remoteFiles.keys()].map((path) => ({ path }));
      },
      async read(path) {
        return remoteFiles.get(path)!;
      },
      async write(path, bytes) {
        writes++;
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        remoteFiles.set(path, bytes);
      },
    };
    const plan = await preview(local, remote, {});
    let settled = false;
    const applying = apply(
      plan,
      run.store(local),
      run.store(remote),
      {},
      {
        async backup() {},
        async checkpoint() {
          checkpoints++;
        },
      }
    ).finally(() => {
      settled = true;
    });
    const rejected = assert.rejects(applying, /cancelled/);
    await writing;
    run.cancel();
    await Promise.resolve();
    assert.equal(settled, false);
    finish();
    await rejected;
    assert.equal(writes, 1);
    assert.equal(checkpoints, 0);
    assert.ok(remoteFiles.has("a.md"));
    assert.ok(!remoteFiles.has("b.md"));
  });
  it("unloads a reviewed preview, releases workers and prevents another start", async () => {
    const h = harness("test-passphrase");
    h.local.set("a.md", encode("a"));
    assert.ok(await h.preview());
    h.plugin.onunload();
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(h.workers.every((w) => w.terminated));
    assert.equal(h.plugin.sessionPassword, "");
    const calls = h.calls.length;
    await h.plugin.start();
    assert.equal(h.calls.length, calls);
    assert.equal(h.localWrites.length, 0);
  });
  it("stops a bundled preview on a silent or crashed encryption worker", async () => {
    for (const workerMode of ["silent", "crash"] as const) {
      const h = harness("test-passphrase", false, { workerMode });
      h.local.set("a.md", encode("a"));
      // A remote name requires worker preparation during listing.
      h.remote.set("encrypted-name", encode("encrypted-content"));
      assert.equal(await h.preview(), undefined);
      assert.equal(h.plugin.busy, false);
      assert.equal(h.localWrites.length, 0);
      assert.ok(h.workers.every((w) => w.terminated));
      assert.ok(h.channels.length > 0);
      assert.ok(h.channels.every((c) => c.port1.closed && c.port2.closed));
      assert.equal(h.logs.length, 0);
    }
  });
  it("cancels a bundled preview waiting for native HTTP without unlocking early", async () => {
    let finish!: () => void, started!: () => void;
    const requested = new Promise<void>((resolve) => {
      started = resolve;
    });
    const h = harness("test-passphrase", false, {
      async beforeRequest() {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    const previewing = h.preview();
    await requested;
    h.cancel();
    assert.equal(h.plugin.busy, true);
    finish();
    assert.equal(await previewing, undefined);
    assert.equal(h.plugin.busy, false);
    assert.equal(h.localWrites.length, 0);
    assert.ok(h.workers.every((w) => w.terminated));
    assert.equal(h.calls.length, 1);
  });
  it("unloads during the password prompt without making cloud requests", async () => {
    const h = harness("");
    const starting = h.plugin.start();
    h.plugin.onunload();
    await starting;
    assert.equal(h.calls.length, 0);
    assert.equal(h.localWrites.length, 0);
    assert.equal(h.plugin.busy, false);
    assert.equal(h.plugin.sessionPassword, "");
  });
  it("cancels or unloads during a bundled S3 upload without starting the next file", async () => {
    for (const unload of [false, true]) {
      let finish!: () => void, started!: () => void;
      const requested = new Promise<void>((resolve) => {
        started = resolve;
      });
      const h = harness("test-passphrase", false, {
        async beforeRequest(request) {
          if (request.method === "PUT") {
            started();
            await new Promise<void>((resolve) => {
              finish = resolve;
            });
          }
        },
      });
      h.local.set("a.md", encode("a"));
      h.local.set("b.md", encode("b"));
      assert.ok(await h.preview());
      const applying = h.apply();
      await requested;
      if (unload) h.plugin.onunload();
      else h.cancel();
      assert.equal(h.plugin.busy, true);
      finish();
      await applying;
      if (!unload)
        assert.ok(h.notices.some((n) => n.startsWith("Sync stopped:")));
      else assert.ok(!h.notices.some((n) => n.startsWith("Sync stopped:")));
      await Promise.resolve();
      assert.equal(h.plugin.busy, false);
      assert.equal(h.calls.filter((r) => r.method === "PUT").length, 1);
      assert.equal(h.remote.size, 1);
      assert.equal(Object.keys(h.plugin.state.histories).length, 0);
      const journal = Object.values(h.plugin.state.journals ?? {})[0];
      assert.equal(journal.files[0].phase, "write-remote");
      assert.equal(journal.files[1].phase, "queued");
      assert.equal(h.localWrites.length, 0);
      assert.ok(h.workers.every((w) => w.terminated));
    }
  });
});
