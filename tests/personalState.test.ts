import { strict as assert } from "node:assert";
import { loadState } from "../personal/state";
import { defaults } from "../personal/settings";
import { digest } from "../personal/engine";
import { harness } from "./helpers/vaultBridgeHarness";

const valid = () => ({ settings: defaults(), histories: {} });
describe("VaultBridge saved state recovery", () => {
  it("blocks unreadable saved JSON without exposing storage errors or saving defaults", async () => {
    const h = harness("");
    h.plugin.loadData = async () => {
      throw Error("private-storage-detail");
    };
    await h.plugin.onload();
    await h.plugin.start();
    assert.equal(h.plugin.saved.length, 0);
    assert.equal(h.calls.length, 0);
    assert.ok(h.notices.some((n) => n.includes("could not be read")));
    assert.ok(h.notices.every((n) => !n.includes("private-storage-detail")));
  });
  it("blocks sync if the saved-password migration cannot be persisted", async () => {
    const h = harness("");
    const raw = valid();
    raw.settings.password = "session-only";
    h.plugin.loaded = raw;
    h.plugin.saveData = async () => {
      throw Error("private-storage-detail");
    };
    await h.plugin.onload();
    await h.plugin.start();
    assert.equal(h.plugin.sessionPassword, "session-only");
    assert.equal(h.plugin.state.settings.password, "");
    assert.equal(h.calls.length, 0);
    assert.ok(h.notices.every((n) => !n.includes("private-storage-detail")));
  });
  it("migrates unversioned valid state and fills optional S3 defaults", () => {
    const raw = valid();
    delete raw.settings.s3.partsConcurrency;
    const loaded = loadState(raw);
    assert.equal(loaded.state.schemaVersion, 3);
    assert.equal(loaded.state.settings.s3.partsConcurrency, 4);
    assert.equal(loaded.recovered, false);
  });
  it("retains valid credentials while requiring review of missing or malformed fields", () => {
    const raw = {
      settings: {
        ...defaults(),
        google: {
          ...defaults().google,
          expiresAt: "invalid",
          refreshToken: "private",
        },
        s3: null,
      },
      histories: {},
    };
    const loaded = loadState(raw);
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.state.settings.google.refreshToken, "private");
    assert.equal(loaded.state.settings.google.expiresAt, 0);
    assert.equal(loaded.state.settings.s3.s3AccessKeyID, "");
  });
  it("does not silently switch an unsupported provider to unencrypted S3", () => {
    const loaded = loadState({
      ...valid(),
      settings: { ...defaults(), provider: "box", encryption: "none" },
    });
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.state.settings.encryption, "unset");
  });
  it("rejects invalid containers and future schema versions", () => {
    for (const raw of [
      [],
      "bad",
      { settings: [] },
      { ...valid(), schemaVersion: 4 },
      { ...valid(), schemaVersion: "1" },
    ])
      assert.throws(() => loadState(raw), /settings|version/);
  });
  it("discards unsafe history without losing verified well-formed baselines", async () => {
    const namespace = "a".repeat(64);
    const hash = await digest(new TextEncoder().encode("note").buffer);
    const raw = JSON.parse(
      JSON.stringify({
        ...valid(),
        histories: {
          [namespace]: {
            "note.md": { hash, text: "note" },
            "../escape": { hash },
            "bad.md": { hash: "bad" },
            __proto__: { hash },
          },
          constructor: {},
        },
      })
    );
    const loaded = loadState(raw);
    assert.equal(loaded.recovered, true);
    assert.deepEqual(Object.keys(loaded.state.histories), [namespace]);
    assert.deepEqual(Object.keys(loaded.state.histories[namespace]), [
      "note.md",
    ]);
    assert.equal(
      Object.getPrototypeOf(loaded.state.histories[namespace]),
      null
    );
  });
  it("blocks sync and saving after recovery or unsupported-version startup without any cloud access", async () => {
    for (const raw of [
      { settings: { provider: "s3" }, histories: {} },
      { ...valid(), schemaVersion: 4 },
    ]) {
      const h = harness("");
      h.plugin.loaded = raw;
      await h.plugin.onload();
      await h.plugin.start();
      assert.equal(h.calls.length, 0);
      assert.equal(h.plugin.saved.length, 0);
      assert.equal(h.localWrites.length, 0);
      assert.ok(h.notices.length > 0);
    }
  });
});
