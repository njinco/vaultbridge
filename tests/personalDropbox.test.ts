import { strict as assert } from "node:assert";
import { CloudSession, DropboxStore, type Credentials, type Request, type Response } from "../personal/cloud";
import { authorize, complete } from "../personal/oauth";
import { publicError } from "../personal/errors";
import { apply, digest, preview, type History, type Store } from "../personal/engine";

const enc = new TextEncoder();
const response = (value: unknown, status = 200): Response => ({
  status, headers: {}, body: enc.encode(JSON.stringify(value)).buffer,
});
const creds = (): Credentials => ({
  clientId: "own-app", clientSecret: "", accessToken: "own-access",
  refreshToken: "own-refresh", expiresAt: Date.now() + 3600000, root: "vault-folder",
});
const file = (name = "note.md", rev = "123456789", size = 3) => ({
  ".tag": "file", id: "id:test-file", name, rev, size,
  path_display: `/vault-folder/${name}`, path_lower: `/vault-folder/${name.toLowerCase()}`,
});
const listing = (entries: unknown[] = [], has_more = false, cursor = "cursor-1") => response({ entries, has_more, cursor });
const download = (metadata: unknown, value = "one"): Response => ({
  status: 200, headers: { "Dropbox-API-Result": JSON.stringify(metadata) }, body: enc.encode(value).buffer,
});
function fixture(replies: (Response | Error)[]) {
  const calls: Request[] = [], c = creds();
  let saves = 0;
  const session = new CloudSession("dropbox", c, async (r) => {
    calls.push(r);
    const reply = replies.shift();
    if (!reply) throw Error("Unexpected HTTP request");
    if (reply instanceof Error) throw reply;
    return reply;
  }, async () => { saves++; });
  return { calls, c, session, store: new DropboxStore(session), saves: () => saves };
}
const args = (request: Request) => JSON.parse(request.headers!["Dropbox-API-Arg"]);

describe("Dropbox listing safety", () => {
  it("reads all pages, including empty pages and Unicode subfolders", async () => {
    const f = fixture([
      listing([], true),
      listing([{ ".tag": "folder", id: "id:folder", name: "日本", path_display: "/vault-folder/日本" }], true, "cursor-2"),
      listing([{ ...file("日本/メモ.md"), name: "メモ.md" }], false, "cursor-3"),
    ]);
    assert.deepEqual(await f.store.list(), [{ path: "日本/メモ.md", size: 3 }]);
    assert.equal(f.calls.length, 3);
    assert.equal(JSON.parse(f.calls[0].body as string).include_non_downloadable_files, true);
    assert.deepEqual(JSON.parse(f.calls[2].body as string), { cursor: "cursor-2" });
  });
  it("rejects repeated or malformed cursors before completing inventory", async () => {
    for (const replies of [[listing([], true), listing([], true)], [response({ entries: [], has_more: false, cursor: 42 })]]) {
      const f = fixture(replies);
      await assert.rejects(f.store.list(), /cursor|listing/);
      await assert.rejects(f.store.write("note.md", enc.encode("one").buffer), /inventory/);
    }
  });
  it("rejects duplicate or case-colliding file paths across pages", async () => {
    const f = fixture([listing([file()], true), listing([file("NOTE.md")], false, "cursor-2")]);
    await assert.rejects(f.store.list(), /Duplicate/);
    await assert.rejects(f.store.read("note.md"), /inventory/);
  });
  it("rejects out-of-root folders, traversal and unsupported entries", async () => {
    for (const entry of [
      { ".tag": "folder", id: "id:folder", name: "outside", path_display: "/outside" },
      { ...file("../note.md"), name: "note.md" },
      { ...file(), ".tag": "deleted" }, null,
      { ...file(), is_downloadable: false }, { ...file(), symlink_info: { target: "outside" } },
      { ...file(), rev: "bad" }, { ...file(), size: -1 },
      { ...file(), path_lower: "/other/note.md" },
    ]) {
      const f = fixture([listing([entry])]);
      await assert.rejects(f.store.list());
      await assert.rejects(f.store.write("note.md", enc.encode("one").buffer), /inventory/);
      assert.equal(f.calls.length, 1);
    }
  });
  it("discards a previous complete inventory after a later listing fails", async () => {
    const f = fixture([listing([file()]), response({}, 409)]);
    await f.store.list();
    await assert.rejects(f.store.list(), /409/);
    await assert.rejects(f.store.read("note.md"), /inventory/);
    assert.equal(f.calls.length, 2);
  });
});

describe("Dropbox conditional uploads and downloads", () => {
  it("preserves a last-moment remote edit and the engine's backup and baseline", async () => {
    let remoteText = "one", revision = "123456789";
    const metadata = () => file("note.md", revision, enc.encode(remoteText).byteLength);
    const local: Store = {
      list: async () => [{ path: "note.md", size: 3 }],
      read: async () => enc.encode("two").buffer,
      write: async () => { assert.fail("Local original must remain unchanged"); },
    };
    const remote = new DropboxStore(new CloudSession("dropbox", creds(), async (request) => {
      if (request.url.endsWith("/list_folder")) return listing([metadata()]);
      if (request.url.endsWith("/download")) return download(metadata(), remoteText);
      assert.ok(request.url.endsWith("/upload"));
      // Another writer commits after the engine's final content check.
      remoteText = "concurrent edit"; revision = "987654321";
      const mode = args(request).mode;
      assert.equal(mode[".tag"], "update");
      assert.equal(mode.update, "123456789");
      assert.equal(args(request).strict_conflict, true);
      assert.notEqual(mode.update, revision);
      return response({}, 409);
    }, async () => {}));
    const history: History = { "note.md": { hash: await digest(enc.encode("one").buffer), text: "one" } };
    const before = structuredClone(history), backups: string[] = [];
    const plan = await preview(local, remote, history);
    assert.equal(plan.changes[0].action, "upload");
    await assert.rejects(apply(plan, local, remote, history, {
      backup: async (_path, side, bytes) => { backups.push(`${side}:${new TextDecoder().decode(bytes)}`); },
      checkpoint: async () => { assert.fail("Do not checkpoint a rejected upload"); },
    }), /conflict/);
    assert.equal(remoteText, "concurrent edit");
    assert.deepEqual(history, before);
    assert.deepEqual(backups, ["remote:one"]);
  });
  it("requires a complete inventory before reads or writes", async () => {
    const f = fixture([]);
    await assert.rejects(f.store.read("note.md"), /inventory/);
    await assert.rejects(f.store.write("note.md", new ArrayBuffer(0)), /inventory/);
    assert.equal(f.calls.length, 0);
  });
  it("creates a new file with strict add and no automatic rename", async () => {
    const metadata = file("日本.md");
    const f = fixture([listing(), response(metadata), download(metadata)]);
    await f.store.list();
    await f.store.write("日本.md", enc.encode("one").buffer);
    assert.deepEqual(args(f.calls[1]), {
      path: "/vault-folder/日本.md", mode: { ".tag": "add" },
      autorename: false, strict_conflict: true, mute: true,
    });
    assert.ok(!/[^\x00-\x7f]/.test(f.calls[1].headers!["Dropbox-API-Arg"]));
    assert.equal(new TextDecoder().decode(await f.store.read("日本.md")), "one");
  });
  it("updates only the listed revision and adopts the successful returned revision", async () => {
    const next = file("note.md", "987654321");
    const f = fixture([listing([file()]), download(file()), response(next), download(next)]);
    await f.store.list();
    await f.store.read("note.md");
    await f.store.write("note.md", enc.encode("two").buffer);
    assert.deepEqual(args(f.calls[2]).mode, { ".tag": "update", update: "123456789" });
    assert.equal(args(f.calls[2]).strict_conflict, true);
    await f.store.read("note.md");
  });
  it("stops revision conflicts without overwriting or retrying", async () => {
    const f = fixture([listing([file()]), response({ error_summary: "private path" }, 409)]);
    await f.store.list();
    await assert.rejects(f.store.write("note.md", enc.encode("two").buffer), (error: unknown) => {
      assert.match(publicError(error), /conflict/);
      assert.ok(!publicError(error).includes("private")); return true;
    });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(args(f.calls[1]).mode, { ".tag": "update", update: "123456789" });
  });
  it("does not replay ambiguous upload failures or rate-limited requests", async () => {
    for (const failure of [Error("private transport URL"), response({}, 503), response({}, 429)]) {
      const f = fixture([listing(), failure]);
      await f.store.list();
      await assert.rejects(f.store.write("note.md", enc.encode("one").buffer));
      assert.equal(f.calls.length, 2);
      await assert.rejects(f.store.read("note.md"), /inventory/);
    }
  });
  it("rejects downloads with changed revisions, wrong identity/path or truncated content", async () => {
    for (const metadata of [file("note.md", "987654321"), { ...file(), id: "id:other" }, file("other.md"), { ...file(), size: 7 }]) {
      const f = fixture([listing([file()]), download(metadata)]);
      await f.store.list();
      await assert.rejects(f.store.read("note.md"), /changed|incomplete/);
      assert.equal(f.calls.length, 2);
    }
  });
  it("requires valid download metadata and permits zero-byte files", async () => {
    const malformedHeaders: Record<string, string>[] = [{}, { "dropbox-api-result": "not JSON" }];
    for (const headers of malformedHeaders) {
      const f = fixture([listing([file()]), { status: 200, headers, body: enc.encode("one").buffer }]);
      await f.store.list();
      await assert.rejects(f.store.read("note.md"), /download metadata/);
    }
    const empty = file("empty.txt", "123456789", 0);
    const f = fixture([listing([empty]), download(empty, "")]);
    await f.store.list();
    assert.equal((await f.store.read("empty.txt")).byteLength, 0);
  });
  it("does not adopt mismatched upload metadata", async () => {
    for (const metadata of [file("other.md"), { ...file(), size: 7 }, { ...file(), rev: "bad" }]) {
      const f = fixture([listing(), response(metadata)]);
      await f.store.list();
      await assert.rejects(f.store.write("note.md", enc.encode("one").buffer), /metadata/);
      await assert.rejects(f.store.read("note.md"), /inventory/);
    }
  });
});

describe("Dropbox own-app authentication", () => {
  it("requests PKCE and offline access and exchanges only at Dropbox", async () => {
    const p = await authorize("dropbox", "own-app", "https://owned.example/callback");
    const url = new URL(p.url);
    assert.equal(url.searchParams.get("token_access_type"), "offline");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const c = creds();
    await complete("dropbox", c, p, `${p.redirect}?code=test-code&state=${p.state}`, async (r) => {
      assert.equal(r.url, "https://api.dropboxapi.com/oauth2/token");
      const form = new URLSearchParams(r.body as string);
      assert.equal(form.get("code_verifier"), p.verifier);
      assert.equal(form.has("client_secret"), false);
      return response({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 14400 });
    });
    assert.equal(c.refreshToken, "new-refresh");
  });
  it("refreshes rejected tokens once and preserves the existing refresh token", async () => {
    const f = fixture([response({}, 401), response({ access_token: "new-access", expires_in: 14400 }), listing()]);
    await f.store.list();
    assert.equal(f.calls[1].url, "https://api.dropboxapi.com/oauth2/token");
    assert.equal(f.calls[2].headers?.Authorization, "Bearer new-access");
    assert.equal(f.c.refreshToken, "own-refresh");
    assert.equal(f.saves(), 1);
  });
  it("never sends Dropbox credentials to other providers", async () => {
    const f = fixture([]);
    await assert.rejects(f.session.request({ url: "https://www.googleapis.com/drive/v3/files" }), /unexpected host/);
    assert.equal(f.calls.length, 0);
  });
});
