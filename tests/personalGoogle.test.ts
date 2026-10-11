import { strict as assert } from "node:assert";
import { CloudSession, GoogleStore, type Credentials, type Request, type Response } from "../personal/cloud";
import { authorize, complete, persistAuthorization } from "../personal/oauth";
import { publicError } from "../personal/errors";

const encoder = new TextEncoder();
const reply = (body: unknown, status = 200, headers = {}): Response => ({
  status, headers, body: encoder.encode(JSON.stringify(body)).buffer,
});
const credentials = (): Credentials => ({
  clientId: "own-client", clientSecret: "own-secret", accessToken: "old-access",
  refreshToken: "own-refresh", expiresAt: Date.now() + 3600000, root: "test-folder",
});
const url = "https://www.googleapis.com/upload/drive/v3/files?upload_id=test-session";
const file = { id: "file-1", name: "large.bin", mimeType: "application/octet-stream", size: "5000001" };
const testBytes = new Uint8Array(5000001).fill(42).buffer;
const bytes = () => testBytes;
function uploadFixture(responses: (Response | Error)[]) {
  const calls: Request[] = [];
  const session = new CloudSession("google", credentials(), async (request) => {
    calls.push(request);
    const response = responses.shift();
    if (!response) throw Error("Unexpected request");
    if (response instanceof Error) throw response;
    return response;
  }, async () => {});
  return { store: new GoogleStore(session), calls, responses };
}
const start = () => [reply({ files: [] }), reply({}, 200, { Location: url })];

describe("Google upload recovery", function () {
  this.timeout(15000);
  it("continues from the server's acknowledged byte range", async () => {
    const f = uploadFixture([...start(), reply({}, 308, { Range: "bytes=0-262143" }), reply(file)]);
    const data = bytes();
    await f.store.list();
    await f.store.write("large.bin", data);
    assert.equal(f.calls[3].url, url);
    assert.equal(f.calls[3].headers?.["Content-Range"], "bytes 262144-5000000/5000001");
    assert.deepEqual(f.calls[3].body, data.slice(262144));
    assert.equal(f.calls[3].headers?.["Content-Length"], "4737857");
  });
  it("queries a lost response and avoids re-uploading an already completed file", async () => {
    const f = uploadFixture([...start(), Error("private transport URL"), reply(file)]);
    await f.store.list();
    await f.store.write("large.bin", bytes());
    assert.equal(f.calls.length, 4);
    assert.equal(f.calls[3].headers?.["Content-Range"], "bytes */5000001");
    assert.equal((f.calls[3].body as ArrayBuffer).byteLength, 0);
  });
  it("queries a server failure and resumes only remaining bytes", async () => {
    const f = uploadFixture([...start(), reply({}, 503), reply({}, 308, { range: "bytes=0-524287" }), reply(file, 201)]);
    await f.store.list();
    await f.store.write("large.bin", bytes());
    assert.equal(f.calls[4].headers?.["Content-Range"], "bytes 524288-5000000/5000001");
    assert.equal(f.calls.filter((r) => r.method === "POST").length, 1);
  });
  it("accepts a missing Range as zero bytes after an interrupted request", async () => {
    const f = uploadFixture([...start(), Error("lost"), reply({}, 308), reply(file)]);
    await f.store.list();
    await f.store.write("large.bin", bytes());
    assert.equal(f.calls[4].headers?.["Content-Range"], "bytes 0-5000000/5000001");
  });
  it("stops expired sessions without initiating another potentially duplicate file", async () => {
    const f = uploadFixture([...start(), reply({}, 404)]);
    await f.store.list();
    await assert.rejects(f.store.write("large.bin", bytes()), /expired.*Preview again/);
    assert.equal(f.calls.length, 3);
    await assert.rejects(f.store.read("large.bin"), /missing/);
  });
  it("rejects malformed, overflowing or fully acknowledged incomplete ranges", async () => {
    for (const range of ["bytes=1-42", "bytes=0-5000001", "bytes=0-9007199254740993", "secret URL"]) {
      const f = uploadFixture([...start(), reply({}, 308, { Range: range })]);
      await f.store.list();
      await assert.rejects(f.store.write("large.bin", bytes()), /Invalid or stalled/);
      assert.equal(f.calls.length, 3);
    }
  });
  it("bounds repeated non-progress and never retries multipart create failures", async () => {
    const stalled = uploadFixture([...start(), reply({}, 308), reply({}, 308)]);
    await stalled.store.list();
    await assert.rejects(stalled.store.write("large.bin", bytes()), /stalled/);
    assert.equal(stalled.calls.length, 4);
    const small = uploadFixture([reply({ files: [] }), Error("ambiguous create")]);
    await small.store.list();
    await assert.rejects(small.store.write("small.md", encoder.encode("note").buffer));
    assert.equal(small.calls.length, 2);
  });
  it("caps recovery even when the server keeps reporting small progress", async () => {
    const progress = [0, 1, 2, 3].map((n) => reply({}, 308, { Range: `bytes=0-${n}` }));
    const f = uploadFixture([...start(), ...progress]);
    await f.store.list();
    await assert.rejects(f.store.write("large.bin", bytes()), /recovery limit/);
    assert.equal(f.calls.length, 6);
  });
  it("rejects mismatched upload results without adding them to inventory", async () => {
    for (const metadata of [{ ...file, name: "other.bin" }, { ...file, size: "2" }, null]) {
      const f = uploadFixture([...start(), reply(metadata)]);
      await f.store.list();
      await assert.rejects(f.store.write("large.bin", bytes()), /metadata/);
      await assert.rejects(f.store.read("large.bin"), /missing/);
    }
  });
});

describe("Google authorization failures", () => {
  it("restores previous in-memory credentials if authorization cannot be saved", async () => {
    const c = credentials(), before = { ...c };
    await assert.rejects(persistAuthorization(c, { ...c, accessToken: "new-token" }, async () => {
      assert.equal(c.accessToken, "new-token");
      throw Error("private settings path or credentials");
    }), /could not be saved/);
    assert.deepEqual(c, before);
    let saved = false;
    await persistAuthorization(c, { ...c, accessToken: "new-token" }, async () => { saved = true; });
    assert.equal(saved, true);
    assert.equal(c.accessToken, "new-token");
  });
  it("refreshes a rejected access token once before retrying the request", async () => {
    const c = credentials(), calls: Request[] = [];
    const responses = [reply({}, 401), reply({ access_token: "new-access", expires_in: 3600 }), reply({ files: [] })];
    let saves = 0;
    const session = new CloudSession("google", c, async (r) => { calls.push(r); return responses.shift()!; }, async () => { saves++; });
    await session.api("https://www.googleapis.com/drive/v3/files");
    assert.equal(calls.length, 3);
    assert.equal(calls[2].headers?.Authorization, "Bearer new-access");
    assert.equal(c.refreshToken, "own-refresh");
    assert.equal(saves, 1);
  });
  it("does not loop when refreshed credentials are also rejected", async () => {
    const responses = [reply({}, 401), reply({ access_token: "new-access", expires_in: 3600 }), reply({}, 401)];
    let calls = 0;
    const session = new CloudSession("google", credentials(), async () => { calls++; return responses.shift()!; }, async () => {});
    await assert.rejects(session.api("https://www.googleapis.com/drive/v3/files"), /401/);
    assert.equal(calls, 3);
  });
  it("shares a single refresh across concurrent reads", async () => {
    const c = credentials(); c.expiresAt = 0;
    let refreshes = 0, saves = 0;
    const session = new CloudSession("google", c, async (r) => {
      if (r.url.includes("oauth2")) { refreshes++; await Promise.resolve(); return reply({ access_token: "new-access", expires_in: 3600 }); }
      return reply({ files: [] });
    }, async () => { saves++; });
    await Promise.all([session.api("https://www.googleapis.com/drive/v3/files"), session.api("https://www.googleapis.com/drive/v3/files")]);
    assert.equal(refreshes, 1); assert.equal(saves, 1);
  });
  it("reports revoked authorization without displaying provider details or mutating credentials", async () => {
    const c = credentials(); c.expiresAt = 0;
    const before = { ...c };
    const session = new CloudSession("google", c, async () => reply({ error: "invalid_grant", error_description: "private refresh token" }, 400), async () => { assert.fail("no save"); });
    await assert.rejects(session.token(), (e: unknown) => {
      assert.match(publicError(e), /Authorize your own app again/);
      assert.ok(!publicError(e).includes("private")); return true;
    });
    assert.deepEqual(c, before);
  });
  it("rejects malformed token success responses before modifying saved credentials", async () => {
    for (const body of [null, { access_token: 12, expires_in: 3600 }, { access_token: "bad\r\nheader", expires_in: 3600 },
      { access_token: "new", expires_in: 1e300 }, { access_token: "new", refresh_token: {}, expires_in: 3600 },
      { access_token: "new", expires_in: 3600, token_type: "MAC" }]) {
      const c = credentials(); c.expiresAt = 0;
      const before = { ...c };
      const session = new CloudSession("google", c, async () => reply(body), async () => { assert.fail("no save"); });
      await assert.rejects(session.token(), /token response/);
      assert.deepEqual(c, before);
    }
  });
  it("binds callbacks to the original app/provider and rejects ambiguous or denied callbacks", async () => {
    const p = await authorize("google", "own-client", "http://127.0.0.1:42813/");
    const callback = `${p.redirect}?code=x&state=${p.state}`;
    const c = credentials();
    const noRequest = async () => { assert.fail("no HTTP before callback validation"); return reply({}); };
    await assert.rejects(complete("dropbox", c, p, callback, noRequest));
    await assert.rejects(complete("google", { ...c, clientId: "changed-app" }, p, callback, noRequest));
    for (const suffix of ["&code=y", "&state=other", "&error=access_denied", "#fragment"])
      await assert.rejects(complete("google", c, p, callback + suffix, noRequest));
    await assert.rejects(complete("google", c, { ...p, createdAt: Date.now() + 60000 }, callback, noRequest));
  });
  it("preserves old credentials when an authorization response lacks a refresh token", async () => {
    const p = await authorize("google", "own-client", "http://127.0.0.1:42813/");
    const c = credentials(), before = { ...c };
    await assert.rejects(complete("google", c, p, `${p.redirect}?code=x&state=${p.state}`,
      async () => reply({ access_token: "new", expires_in: 3600 })), /incomplete token/);
    assert.deepEqual(c, before);
  });
});
