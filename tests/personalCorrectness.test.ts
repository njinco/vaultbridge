import { strict as assert } from "node:assert";
import { harness, encode, decode } from "./helpers/vaultBridgeHarness";
import { parseJournal, newJournal } from "../personal/journal";
import { loadState } from "../personal/state";
import { defaults } from "../personal/settings";

const journal = (h: ReturnType<typeof harness>) =>
  Object.values(h.plugin.state.journals ?? {})[0];
describe("Conditional S3 writes in the actual bundle", () => {
  it("signs creates with If-None-Match and preserves a concurrently created object", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness("", false, {
      beforeRequest: async (request) => {
        if (request.method === "PUT")
          h.remote.set("note.md", encode("another device"));
      },
    });
    h.plugin.state.settings.encryption = "none";
    h.local.set("note.md", encode("local"));
    assert.ok(await h.preview());
    await h.apply();
    assert.equal(decode(h.remote.get("note.md")!), "another device");
    const writes = h.calls.filter((c) => c.method === "PUT");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].headers?.["if-none-match"], "*");
    assert.ok(writes[0].headers?.authorization.includes("if-none-match"));
    assert.equal(Object.keys(h.plugin.state.histories).length, 0);
    assert.equal(journal(h).files[0].phase, "write-remote");
    assert.ok(h.notices.some((n) => n.includes("S3 object changed")));
    assert.ok(!JSON.stringify(h.notices).includes("private provider detail"));
  });
  it("signs overwrites with If-Match and preserves a last-moment remote edit and its backup", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness("", false, {
      beforeRequest: async (request) => {
        if (request.method === "PUT")
          h.remote.set("note.md", encode("new remote edit"));
      },
    });
    h.plugin.state.settings.encryption = "none";
    h.local.set("note.md", encode("local"));
    h.remote.set("note.md", encode("remote"));
    assert.equal((await h.preview())!.changes[0].action, "conflict");
    h.changeDropdown("note.md", "local");
    await h.apply();
    assert.equal(decode(h.remote.get("note.md")!), "new remote edit");
    const write = h.calls.find((c) => c.method === "PUT")!;
    assert.ok(write.headers?.["if-match"]?.startsWith('"'));
    assert.ok(write.headers?.authorization.includes("if-match"));
    assert.ok(
      [...h.local].some(
        ([path, content]) =>
          path.includes("/remote/note.md") && decode(content) === "remote"
      )
    );
    assert.equal(Object.keys(h.plugin.state.histories).length, 0);
  });
  it("rejects an object changed between listing and the conditional GET before any sync writes", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness("", false, {
      beforeRequest: async (request) => {
        if (
          (request.method ?? "GET") === "GET" &&
          !request.url.includes("list-type=")
        )
          h.remote.set("note.md", encode("changed"));
      },
    });
    h.plugin.state.settings.encryption = "none";
    h.remote.set("note.md", encode("old"));
    assert.equal(await h.preview(), undefined);
    assert.equal(h.localWrites.length, 0);
    assert.equal(h.calls.filter((c) => c.method === "PUT").length, 0);
  });
  it("stops on missing ETags or unsupported conditional writes without an unconditional retry", async () => {
    const missing = harness("", false, { omitETags: true });
    missing.plugin.state.settings.encryption = "none";
    missing.remote.set("note.md", encode("remote"));
    assert.equal(await missing.preview(), undefined);
    assert.equal(missing.localWrites.length, 0);
    assert.ok(missing.notices.some((n) => n.includes("usable object version")));
    const unsupported = harness("", false, { putStatus: 501 });
    unsupported.plugin.state.settings.encryption = "none";
    unsupported.local.set("note.md", encode("local"));
    assert.ok(await unsupported.preview());
    await unsupported.apply();
    assert.equal(unsupported.calls.filter((c) => c.method === "PUT").length, 1);
    assert.equal(unsupported.remote.size, 0);
    assert.ok(
      unsupported.notices.some((n) => n.includes("no unconditional retry"))
    );
  });
  it("uses one conditional PUT for files larger than the old multipart threshold", async () => {
    const h = harness("");
    h.plugin.state.settings.encryption = "none";
    h.local.set(
      "large.bin",
      new Uint8Array(5 * 1024 * 1024 + 1).fill(42).buffer
    );
    assert.ok(await h.preview());
    await h.apply();
    assert.equal(h.calls.filter((c) => c.method === "PUT").length, 1);
    assert.deepEqual(h.remote.get("large.bin"), h.local.get("large.bin"));
    assert.equal(Object.keys(h.plugin.state.journals ?? {}).length, 0);
  });
});

describe("Interrupted sync recovery and final local checks", () => {
  it("does not replace a destination created during parent-folder creation", async () => {
    const h = harness("");
    h.plugin.state.settings.encryption = "none";
    h.remote.set("nested/note.md", encode("remote"));
    assert.ok(await h.preview());
    h.plugin.app.vault.adapter.mkdir = async () => {
      h.local.set("nested/note.md", encode("new local file"));
    };
    await h.apply();
    assert.equal(decode(h.local.get("nested/note.md")!), "new local file");
    assert.equal(h.localWrites.length, 0);
    assert.equal(Object.keys(h.plugin.state.histories).length, 0);
    assert.equal(journal(h).files[0].phase, "write-local");
  });
  it("retains a local edit during a real bundled merge upload without advancing the baseline", async () => {
    let editDuringUpload = false,
      h!: ReturnType<typeof harness>;
    h = harness("", false, {
      beforeRequest: async (request) => {
        if (editDuringUpload && request.method === "PUT")
          h.local.set("note.md", encode("new local edit"));
      },
    });
    h.plugin.state.settings.encryption = "none";
    const original = "one\ntwo\nthree\n";
    h.local.set("note.md", encode(original));
    await h.preview();
    await h.apply();
    h.local.set("note.md", encode("ONE\ntwo\nthree\n"));
    h.remote.set("note.md", encode("one\ntwo\nTHREE\n"));
    assert.equal((await h.preview())!.changes[0].action, "merge");
    editDuringUpload = true;
    await h.apply();
    assert.equal(decode(h.local.get("note.md")!), "new local edit");
    assert.equal(
      Object.values(h.plugin.state.histories)[0]["note.md"].text,
      original
    );
    assert.equal(journal(h).files[0].phase, "write-local");
  });
  it("requires a durable journal before a sync write and survives a lost write response on restart", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness("", false, {
      beforeRequest: async (request) => {
        if (request.method === "PUT") {
          const saved = h.plugin.saved.at(-1) as any;
          assert.equal(
            Object.values<any>(saved.journals)[0].files[0].phase,
            "write-remote"
          );
          assert.ok(request.body instanceof ArrayBuffer);
          h.remote.set("note.md", request.body.slice(0));
          throw Error("private signed URL: lost response after write");
        }
      },
    });
    h.plugin.state.settings.encryption = "none";
    h.local.set("note.md", encode("local"));
    assert.ok(await h.preview());
    await h.apply();
    assert.equal(decode(h.remote.get("note.md")!), "local");
    assert.equal(Object.keys(h.plugin.state.histories).length, 0);
    assert.ok(!JSON.stringify(h.notices).includes("private signed URL"));
    const restarted = harness("");
    restarted.plugin.loaded = structuredClone(h.plugin.saved.at(-1));
    for (const [path, bytes] of h.local)
      restarted.local.set(path, bytes.slice(0));
    for (const [path, bytes] of h.remote)
      restarted.remote.set(path, bytes.slice(0));
    await restarted.plugin.onload();
    assert.equal(restarted.calls.length, 0);
    assert.ok(restarted.notices.some((n) => n.includes("interrupted")));
    assert.ok(
      restarted.displaySettings().textContent!.includes("write-remote: note.md")
    );
    assert.equal((await restarted.preview())!.changes[0].action, "equal");
    restarted.close();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(Object.keys(restarted.plugin.state.journals ?? {}).length, 1);
    assert.ok(await restarted.preview());
    await restarted.apply();
    assert.equal(restarted.calls.filter((c) => c.method === "PUT").length, 0);
    assert.equal(Object.keys(restarted.plugin.state.journals ?? {}).length, 0);
  });
  it("performs no sync writes when initial journal persistence fails", async () => {
    const h = harness("");
    h.plugin.state.settings.encryption = "none";
    h.local.set("note.md", encode("local"));
    assert.ok(await h.preview());
    h.plugin.saveData = async () => {
      throw Error("save failed");
    };
    await h.apply();
    assert.equal(h.calls.filter((c) => c.method === "PUT").length, 0);
    assert.equal(h.localWrites.length, 0);
  });
  it("retains a verified journal if clearing the completed marker cannot be saved", async () => {
    const h = harness("");
    h.plugin.state.settings.encryption = "none";
    h.local.set("note.md", encode("local"));
    const save = h.plugin.saveData.bind(h.plugin);
    h.plugin.saveData = async (value) => {
      if (!Object.keys((value as any).journals).length)
        throw Error("clear failed");
      await save(value);
    };
    assert.ok(await h.preview());
    await h.apply();
    assert.equal(decode(h.remote.get("note.md")!), "local");
    assert.equal(journal(h).files[0].phase, "verified");
    assert.ok(journal(h));
  });
  it("rejects invalid journals and migrates schema 1 without inventing recovery actions", () => {
    const raw = { schemaVersion: 1, settings: defaults(), histories: {} };
    const migrated = loadState(raw);
    assert.equal(migrated.state.schemaVersion, 3);
    assert.equal(migrated.recovered, false);
    assert.equal(Object.keys(migrated.state.journals ?? {}).length, 0);
    const valid = newJournal(
      { changes: [{ path: "note.md", action: "upload" }] },
      "1700000000000-00000000-0000-4000-8000-000000000000",
      1700000000000
    );
    for (const file of [
      { path: "../escape", action: "upload", phase: "queued" },
      { path: "note.md", action: "delete", phase: "queued" },
      { path: "note.md", action: "upload", phase: "replay" },
    ])
      assert.throws(() => parseJournal({ ...valid, files: [file] }), /journal/);
    assert.throws(
      () => parseJournal({ ...valid, files: [valid.files[0], valid.files[0]] }),
      /journal/
    );
    assert.throws(
      () =>
        loadState({
          ...raw,
          schemaVersion: 2,
          journals: { ["a".repeat(64)]: { ...valid, id: "bad" } },
        }),
      /journal/
    );
  });
});
