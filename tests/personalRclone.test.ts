import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { Cipher } from "@fyears/rclone-crypt";
import { harness, encode, decode } from "./helpers/vaultBridgeHarness";

const password = "test-only-rclone-passphrase";
async function legacyCipher() {
  const c = new Cipher("base64");
  await c.key(password, "");
  return c;
}
async function seed(
  h: ReturnType<typeof harness>,
  c: Cipher,
  path: string,
  bytes: ArrayBuffer
) {
  const key = await c.encryptFileName(path);
  h.remote.set(
    key,
    (await c.encryptData(new Uint8Array(bytes), undefined))
      .buffer as ArrayBuffer
  );
  return key;
}
describe("VaultBridge rclone encrypted sync integration", function () {
  this.timeout(15000);
  before(function () {
    assert.ok(
      existsSync("dist/personal/main.js"),
      "Build VaultBridge before running rclone integration tests."
    );
  });
  it("reads legacy rclone names and content using the bundled encryption workers", async () => {
    const h = harness(password),
      c = await legacyCipher();
    const path = "日本/secret note.md",
      bytes = encode("private note\r\n");
    h.local.set(path, bytes);
    await seed(h, c, path, bytes);
    const plan = await h.preview();
    assert.ok(plan, h.notices.join(" | "));
    assert.equal(plan.changes[0].path, path);
    assert.equal(plan.changes[0].action, "equal");
    assert.equal(h.localWrites.length, 0);
    assert.ok(h.calls.every((x) => x.method === "GET"));
    h.close();
    assert.ok(h.workers.every((w) => w.terminated));
  });
  it("uploads encrypted names and bytes and downloads them on another simulated device", async () => {
    const a = harness(password, true),
      c = await legacyCipher();
    const path = "attachments/private.bin",
      bytes = new Uint8Array(65537).map((_, i) => i % 251).buffer;
    a.local.set(path, bytes);
    assert.equal((await a.preview())?.changes[0].action, "upload");
    await a.apply();
    assert.ok(
      a.notices.includes("VaultBridge sync applied and verified."),
      a.notices.join(" | ")
    );
    const key = await c.encryptFileName(path);
    assert.ok(a.remote.has(key));
    assert.ok(!key.includes("private"));
    assert.notDeepEqual(
      new Uint8Array(a.remote.get(key)!),
      new Uint8Array(bytes)
    );
    assert.deepEqual(
      await c.decryptData(new Uint8Array(a.remote.get(key)!)),
      new Uint8Array(bytes)
    );
    assert.ok(a.workers.every((w) => w.terminated));
    assert.ok(
      a.plugin.saved.every((v) => !JSON.stringify(v).includes(password)),
      "The passphrase must never be serialized with settings."
    );
    const b = harness(password);
    for (const [k, v] of a.remote) b.remote.set(k, v.slice(0));
    assert.equal((await b.preview())?.changes[0].action, "download");
    await b.apply();
    assert.deepEqual(new Uint8Array(b.local.get(path)!), new Uint8Array(bytes));
    assert.ok(b.workers.every((w) => w.terminated));
  });
  it("merges separate Markdown edits locally, backs up originals, and re-encrypts the result", async () => {
    const h = harness(password),
      c = await legacyCipher(),
      path = "note.md";
    const base = "one\ntwo\nthree\nfour\n";
    h.local.set(path, encode(base));
    const key = await seed(h, c, path, encode(base));
    await h.preview();
    await h.apply();
    h.local.set(path, encode("ONE\ntwo\nthree\nfour\n"));
    await seed(h, c, path, encode("one\ntwo\nthree\nFOUR\n"));
    assert.equal((await h.preview())?.changes[0].action, "merge");
    await h.apply();
    const expected = "ONE\ntwo\nthree\nFOUR\n";
    assert.equal(decode(h.local.get(path)!), expected);
    assert.equal(
      decode(
        (await c.decryptData(new Uint8Array(h.remote.get(key)!)))
          .buffer as ArrayBuffer
      ),
      expected
    );
    const backups = Array.from(h.local).filter(([p]) =>
      p.startsWith("_personal_sync_backups/")
    );
    assert.equal(backups.length, 2);
    assert.ok(backups.some(([, v]) => decode(v).startsWith("one\n")));
    assert.ok(h.workers.every((w) => w.terminated));
  });
  it("preserves both overlapping encrypted note versions without overwriting either", async () => {
    const h = harness(password),
      c = await legacyCipher();
    h.local.set("note.md", encode("local edit\n"));
    const key = await seed(h, c, "note.md", encode("remote edit\n")),
      original = h.remote.get(key)!.slice(0);
    assert.equal((await h.preview())?.changes[0].action, "conflict");
    await h.apply();
    assert.equal(decode(h.local.get("note.md")!), "local edit\n");
    assert.deepEqual(
      new Uint8Array(h.remote.get(key)!),
      new Uint8Array(original)
    );
    assert.equal(
      Array.from(h.local.keys()).filter((p) =>
        p.startsWith("_personal_sync_backups/")
      ).length,
      2
    );
    assert.ok(h.calls.every((x) => x.method === "GET"));
  });
  it("rejects the wrong password before any sync write and releases workers", async () => {
    const h = harness("incorrect-test-password"),
      c = await legacyCipher();
    await seed(h, c, "secret.md", encode("private content"));
    assert.equal(await h.preview(), undefined);
    assert.equal(h.localWrites.length, 0);
    assert.ok(h.calls.every((x) => x.method === "GET"));
    assert.equal(h.plugin.busy, false);
    assert.ok(h.workers.every((w) => w.terminated));
    assert.equal(h.plugin.sessionPassword, "");
    assert.equal(h.logs.length, 0);
  });
  it("rejects ciphertext modification and short truncation before any write", async () => {
    for (const mutation of ["flip", "truncate"]) {
      const h = harness(password),
        c = await legacyCipher();
      const key = await seed(h, c, "secret.md", encode("private content"));
      const encrypted = new Uint8Array(h.remote.get(key)!);
      if (mutation === "flip") {
        encrypted[encrypted.length - 1] ^= 1;
        h.remote.set(key, encrypted.buffer);
      } else h.remote.set(key, encrypted.slice(0, -1).buffer);
      assert.equal(await h.preview(), undefined);
      assert.equal(h.localWrites.length, 0);
      assert.ok(h.calls.every((x) => x.method === "GET"));
      assert.ok(h.workers.every((w) => w.terminated));
      assert.equal(h.logs.length, 0);
    }
  });
  it("round-trips empty files and randomizes content encryption on repeated uploads", async () => {
    const c = await legacyCipher(),
      h = harness(password);
    h.local.set("empty", new ArrayBuffer(0));
    h.local.set("note.md", encode("private content"));
    await h.preview();
    await h.apply();
    const key = await c.encryptFileName("note.md"),
      first = h.remote.get(key)!.slice(0);
    const other = harness(password);
    other.local.set("note.md", encode("private content"));
    await other.preview();
    await other.apply();
    assert.notDeepEqual(
      new Uint8Array(first),
      new Uint8Array(other.remote.get(key)!)
    );
    assert.equal(
      (
        await c.decryptData(
          new Uint8Array(h.remote.get(await c.encryptFileName("empty"))!)
        )
      ).byteLength,
      0
    );
  });
  it("requests a session password before making any cloud request", async () => {
    const h = harness(""),
      c = await legacyCipher();
    await seed(h, c, "note.md", encode("note"));
    const pending = h.preview();
    assert.equal(h.calls.length, 0);
    assert.equal(h.workers.length, 0);
    await h.unlock(password);
    assert.ok(await pending);
    assert.equal(h.plugin.sessionPassword, password);
    await h.apply();
    assert.ok(
      h.plugin.saved.every((v) => !JSON.stringify(v).includes(password))
    );
    h.plugin.onunload();
    assert.equal(h.plugin.sessionPassword, "");
  });
  it("cancels unlocking without accessing storage or leaving sync locked", async () => {
    const h = harness("");
    const pending = h.preview();
    h.close();
    assert.equal(await pending, undefined);
    assert.equal(h.calls.length, 0);
    assert.equal(h.workers.length, 0);
    assert.equal(h.plugin.busy, false);
  });
  it("documents the legacy format's inability to authenticate whole-block truncation", async () => {
    const c = await legacyCipher(),
      original = new Uint8Array(65537).fill(7);
    const encrypted = await c.encryptData(original, undefined);
    // 32-byte file header, followed by a 16-byte tag and 65,536-byte block.
    // The remaining block can be removed without invalidating the first tag.
    const shortened = encrypted.slice(0, 32 + 16 + 65536);
    const decrypted = await c.decryptData(shortened);
    assert.equal(decrypted.byteLength, 65536);
    assert.deepEqual(decrypted, original.slice(0, 65536));
  });
  it("scrubs an old saved password while retaining it only for the current session", async () => {
    const h = harness("");
    h.plugin.state.settings.password = password;
    h.plugin.loaded = structuredClone(h.plugin.state);
    await h.plugin.onload();
    assert.equal(h.plugin.sessionPassword, password);
    assert.equal(h.plugin.state.settings.password, "");
    assert.equal(h.plugin.saved.length, 1);
    assert.ok(!JSON.stringify(h.plugin.saved).includes(password));
    assert.equal(h.calls.length, 0);
    assert.equal(h.workers.length, 0);
  });
});
