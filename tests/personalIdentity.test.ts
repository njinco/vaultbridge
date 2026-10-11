import { strict as assert } from "node:assert";
import { historyNamespace, selectHistory } from "../personal/identity";
import { defaults } from "../personal/settings";
import { CloudSession, type Response } from "../personal/cloud";
import { digest } from "../personal/engine";
import {
  harness,
  encode,
  type NativeReply,
} from "./helpers/vaultBridgeHarness";

const reply = (body: unknown): Response => ({
  status: 200,
  headers: {},
  body: encode(JSON.stringify(body)),
});
const native = (body: unknown): NativeReply => ({
  status: 200,
  headers: {},
  arrayBuffer: encode(JSON.stringify(body)),
});
describe("Stable cloud account history", () => {
  it("explains Dropbox's account-identity scope requirement without exposing provider details", async () => {
    const c = defaults().dropbox;
    c.accessToken = "access";
    c.expiresAt = Date.now() + 3600000;
    const session = new CloudSession(
      "dropbox",
      c,
      async () => ({ ...reply({ private: "credential" }), status: 403 }),
      async () => {}
    );
    await assert.rejects(
      session.accountIdentity(),
      (error: Error) =>
        error.message.includes("account_info.read") &&
        !error.message.includes("credential")
    );
  });
  it("keeps the namespace across token rotation and separates accounts, folders and encryption", async () => {
    const s = defaults();
    s.provider = "google";
    s.encryption = "none";
    s.google.clientId = "own-app";
    s.google.root = "folder";
    s.google.refreshToken = "old";
    const key = await historyNamespace(s, "account-1");
    s.google.refreshToken = "rotated";
    assert.equal(await historyNamespace(s, "account-1"), key);
    assert.notEqual(await historyNamespace(s, "account-2"), key);
    s.google.root = "another-folder";
    assert.notEqual(await historyNamespace(s, "account-1"), key);
    s.google.root = "folder";
    s.encryption = "rclone-base64";
    s.password = "test-pass";
    assert.notEqual(await historyNamespace(s, "account-1"), key);
  });
  it("migrates only the matching old namespace and retains the original copy", async () => {
    const histories = {
      legacy: {
        "note.md": { hash: await digest(encode("base")), text: "base" },
      },
    };
    const selected = selectHistory(histories, "stable", "legacy");
    assert.equal(selected.migrated, true);
    selected.history["note.md"].text = "changed";
    assert.equal(histories.legacy["note.md"].text, "base");
    assert.equal(
      selectHistory(histories, "other-account", "unknown").migrated,
      false
    );
  });
  it("obtains provider IDs and rejects absent or malformed account metadata", async () => {
    for (const provider of ["google", "dropbox"] as const) {
      const credentials = defaults()[provider];
      credentials.accessToken = "access";
      credentials.expiresAt = Date.now() + 3600000;
      const session = new CloudSession(
        provider,
        credentials,
        async () =>
          reply(
            provider === "google"
              ? { user: { permissionId: "account-1" } }
              : { account_id: "dbid:account-1" }
          ),
        async () => {}
      );
      assert.equal(
        await session.accountIdentity(),
        provider === "google" ? "account-1" : "dbid:account-1"
      );
      for (const metadata of [
        {},
        null,
        { user: { permissionId: [] }, account_id: "bad\nidentity" },
      ]) {
        const bad = new CloudSession(
          provider,
          credentials,
          async () => reply(metadata),
          async () => {}
        );
        await assert.rejects(bad.accountIdentity(), /identity/);
      }
    }
  });
  it("uses the old pre-refresh baseline when a real bundled preview rotates the token", async () => {
    let current = "one\ntwo\nthree\n",
      rotations = 0,
      account = "account-1";
    const h = harness("", false, {
      cloudResponse: async (request) => {
        const u = new URL(request.url);
        if (u.pathname === "/token") {
          rotations++;
          return native({
            access_token: `access-${rotations}`,
            refresh_token: `rotated-${rotations}`,
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (u.pathname.endsWith("/about"))
          return native({ user: { permissionId: account } });
        if (u.searchParams.get("alt") === "media")
          return { status: 200, headers: {}, arrayBuffer: encode(current) };
        return native({
          files: [
            {
              id: "file-1",
              name: "note.md",
              mimeType: "text/plain",
              size: String(encode(current).byteLength),
            },
          ],
        });
      },
    });
    const s = h.plugin.state.settings;
    s.provider = "google";
    s.encryption = "none";
    Object.assign(s.google, {
      clientId: "own-app",
      root: "folder",
      refreshToken: "original-refresh",
      expiresAt: 0,
    });
    const base = "one\ntwo\nthree\n";
    const legacy = await historyNamespace(s);
    h.plugin.state.histories[legacy] = {
      "note.md": { hash: await digest(encode(base)), text: base },
    };
    h.local.set("note.md", encode("ONE\ntwo\nthree\n"));
    current = "one\ntwo\nTHREE\n";
    assert.equal((await h.preview())!.changes[0].action, "merge");
    const stable = await historyNamespace(h.plugin.state.settings, "account-1");
    assert.ok(h.plugin.state.histories[stable]);
    assert.ok(h.plugin.state.histories[legacy]);
    h.close();
    await Promise.resolve();
    await Promise.resolve();
    s.google.expiresAt = 0;
    assert.equal((await h.preview())!.changes[0].action, "merge");
    assert.equal(rotations, 2);
    assert.equal(
      await historyNamespace(h.plugin.state.settings, "account-1"),
      stable
    );
    assert.ok(h.plugin.saved.some((v: any) => v.histories[stable]));
    h.close();
    await Promise.resolve();
    await Promise.resolve();
    account = "account-2";
    assert.equal((await h.preview())!.changes[0].action, "conflict");
    h.close();
  });
});
