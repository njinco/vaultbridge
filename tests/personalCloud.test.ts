import { strict as assert } from "node:assert";
import {
  asciiJSON,
  CloudSession,
  DropboxStore,
  GoogleStore,
  type Credentials,
  type Request,
  type Response,
  type Transport,
} from "../personal/cloud";
import { authorize, complete } from "../personal/oauth";
const enc = new TextEncoder();
const response = (value: unknown, status = 200, headers = {}): Response => ({
  status,
  headers,
  body: enc.encode(JSON.stringify(value)).buffer,
});
const creds = (): Credentials => ({
  clientId: "own-app",
  clientSecret: "local-secret",
  accessToken: "private-token",
  refreshToken: "private-refresh",
  expiresAt: Date.now() + 3600000,
  root: "vault-folder",
});
function fixture(provider: "google" | "dropbox", replies: Response[]) {
  const calls: Request[] = [],
    c = creds();
  let saves = 0;
  const session = new CloudSession(
    provider,
    c,
    async (r) => {
      calls.push(r);
      const reply = replies.shift();
      if (!reply) throw Error("unexpected request");
      return reply;
    },
    async () => {
      saves++;
    }
  );
  return { session, calls, c, saves: () => saves };
}
describe("Independent cloud adapters", () => {
  it("continues Google pagination through empty pages", async () => {
    const f = fixture("google", [
      response({ files: [], nextPageToken: "next" }),
      response({
        files: [
          { id: "1", name: "a.md", mimeType: "text/markdown", size: "5" },
        ],
      }),
    ]);
    assert.deepEqual(await new GoogleStore(f.session).list(), [
      { path: "a.md", size: 5 },
    ]);
    assert.ok(f.calls[1].url.includes("pageToken=next"));
    assert.equal(f.calls.length, 2);
  });
  it("fails closed on incomplete Drive search", async () => {
    const f = fixture("google", [
      response({ files: [], incompleteSearch: true }),
    ]);
    await assert.rejects(new GoogleStore(f.session).list(), /Incomplete/);
  });
  it("rejects duplicate Drive names across pages", async () => {
    const file = { id: "1", name: "a.md", mimeType: "text/plain" };
    const f = fixture("google", [
      response({ files: [file], nextPageToken: "next" }),
      response({ files: [{ ...file, id: "2" }] }),
    ]);
    await assert.rejects(new GoogleStore(f.session).list(), /Duplicate/);
  });
  it("rejects repeated pagination tokens", async () => {
    const f = fixture("google", [
      response({ files: [], nextPageToken: "same" }),
      response({ files: [], nextPageToken: "same" }),
    ]);
    await assert.rejects(new GoogleStore(f.session).list(), /Repeated/);
  });
  it("rejects Google-native documents rather than inventing byte content", async () => {
    const f = fixture("google", [
      response({
        files: [
          {
            id: "1",
            name: "doc",
            mimeType: "application/vnd.google-apps.document",
          },
        ],
      }),
    ]);
    await assert.rejects(new GoogleStore(f.session).list(), /Google-native/);
  });
  it("builds a complete nested Drive inventory", async () => {
    const f = fixture("google", [
      response({
        files: [
          {
            id: "sub",
            name: "notes",
            mimeType: "application/vnd.google-apps.folder",
          },
        ],
      }),
      response({
        files: [{ id: "1", name: "a.md", mimeType: "text/plain", size: "3" }],
      }),
    ]);
    assert.deepEqual(await new GoogleStore(f.session).list(), [
      { path: "notes/a.md", size: 3 },
    ]);
  });
  it("uploads new Drive bytes in multipart and updates existing file IDs", async () => {
    const item = { id: "1", name: "a.md", mimeType: "text/plain", size: "3" };
    const f = fixture("google", [
        response({ files: [] }),
        response(item),
        response(item),
      ]),
      s = new GoogleStore(f.session);
    await s.list();
    await s.write("a.md", enc.encode("one").buffer);
    await s.write("a.md", enc.encode("two").buffer);
    assert.equal(f.calls[1].method, "POST");
    assert.equal(f.calls[2].method, "PATCH");
    assert.ok(f.calls[2].url.includes("files/1?"));
    assert.ok(
      new TextDecoder()
        .decode(f.calls[1].body as ArrayBuffer)
        .includes('"parents":["vault-folder"]')
    );
  });
  it("uses a resumable session for large Drive uploads", async () => {
    const item = {
      id: "1",
      name: "large.bin",
      mimeType: "application/octet-stream",
    };
    const f = fixture("google", [
        response({ files: [] }),
        response({}, 200, {
          Location:
            "https://www.googleapis.com/upload/drive/v3/files?upload_id=own-session",
        }),
        response(item),
      ]),
      s = new GoogleStore(f.session);
    await s.list();
    await s.write("large.bin", new ArrayBuffer(5000001));
    assert.ok(f.calls[1].url.includes("uploadType=resumable"));
    assert.equal(f.calls[2].method, "PUT");
  });
  it("rejects malicious upload-session hosts before sending tokens", async () => {
    const f = fixture("google", [
        response({ files: [] }),
        response({}, 200, { location: "https://attacker.test/upload" }),
      ]),
      s = new GoogleStore(f.session);
    await s.list();
    await assert.rejects(
      s.write("large.bin", new ArrayBuffer(5000001)),
      /unexpected host/
    );
    assert.equal(f.calls.length, 2);
  });
  it("continues Dropbox cursor pagination and scopes returned paths", async () => {
    const f = fixture("dropbox", [
      response({ entries: [], has_more: true, cursor: "next" }),
      response({
        entries: [
          { ".tag": "file", id: "id:test", name: "日本.md", rev: "123456789", path_display: "/vault-folder/日本.md", size: 3 },
        ],
        has_more: false,
        cursor: "last",
      }),
    ]);
    assert.deepEqual(await new DropboxStore(f.session).list(), [
      { path: "日本.md", size: 3 },
    ]);
    assert.ok(f.calls[1].url.endsWith("/continue"));
  });
  it("encodes Dropbox Unicode API header arguments as ASCII", () => {
    assert.ok(!/[^\x00-\x7f]/.test(asciiJSON({ path: "/日本/😀.md" })));
    assert.equal(
      JSON.parse(asciiJSON({ path: "/日本/😀.md" })).path,
      "/日本/😀.md"
    );
  });
  it("does not create missing Dropbox roots during preview", async () => {
    const f = fixture("dropbox", [response({ error: "path/not_found" }, 409)]);
    await assert.rejects(new DropboxStore(f.session).list(), /409/);
    assert.equal(f.calls.length, 1);
  });
  it("persists refreshed Google credentials before any file request", async () => {
    const c = creds();
    c.expiresAt = 0;
    const order: string[] = [];
    const s = new CloudSession(
      "google",
      c,
      async (r) => {
        order.push(r.url);
        return r.url.includes("oauth2")
          ? response({
              access_token: "next-token",
              refresh_token: "next-refresh",
              expires_in: 3600,
            })
          : response({ entries: [] });
      },
      async () => {
        order.push("saved");
      }
    );
    await s.api("https://www.googleapis.com/drive/v3/files");
    assert.equal(c.refreshToken, "next-refresh");
    assert.equal(order[1], "saved");
  });
  it("blocks file requests until token persistence recovers", async () => {
    const c = creds();
    c.expiresAt = 0;
    let calls = 0,
      saves = 0;
    const s = new CloudSession(
      "google",
      c,
      async () => {
        calls++;
        return response({
          access_token: "next-token",
          refresh_token: "next-refresh",
          expires_in: 3600,
        });
      },
      async () => {
        saves++;
        throw Error("disk full");
      }
    );
    await assert.rejects(s.request({ url: "https://www.googleapis.com/drive/v3/files/1" }));
    await assert.rejects(s.request({ url: "https://www.googleapis.com/drive/v3/files/1" }));
    assert.equal(calls, 1);
    assert.equal(saves, 2);
  });
  it("never sends provider tokens to unrelated hosts", async () => {
    const f = fixture("google", []);
    await assert.rejects(
      f.session.request({
        url: "https://www.googleapis.com.attacker.test/file",
      })
    );
    assert.equal(f.calls.length, 0);
  });
  it("requires a dedicated cloud folder", async () => {
    const f = fixture("google", []);
    f.c.root = "root";
    await assert.rejects(new GoogleStore(f.session).list(), /dedicated/);
    assert.equal(f.calls.length, 0);
  });
});
describe("Independent OAuth", () => {
  it("uses own app credentials and PKCE without an upstream service", async () => {
    const p = await authorize(
      "google",
      "own-client",
      "http://127.0.0.1:42813/"
    );
    const url = new URL(p.url);
    assert.equal(url.hostname, "accounts.google.com");
    assert.equal(url.searchParams.get("client_id"), "own-client");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(!p.url.includes(p.verifier));
  });
  it("rejects callback state, origin, path, and expiry mismatches before requests", async () => {
    const p = await authorize(
      "dropbox",
      "own-client",
      "https://owned.example/callback"
    );
    let calls = 0;
    const t: Transport = async () => {
      calls++;
      return response({});
    };
    for (const url of [
      `https://owned.example/callback?code=x&state=wrong`,
      `https://attacker.test/callback?code=x&state=${p.state}`,
      `https://owned.example/other?code=x&state=${p.state}`,
    ])
      await assert.rejects(complete("dropbox", creds(), p, url, t));
    await assert.rejects(
      complete(
        "dropbox",
        creds(),
        { ...p, createdAt: Date.now() - 16 * 60000 },
        `https://owned.example/callback?code=x&state=${p.state}`,
        t
      )
    );
    assert.equal(calls, 0);
  });
  it("exchanges a validated callback only at the provider token endpoint", async () => {
    const p = await authorize(
      "google",
      "own-client",
      "http://127.0.0.1:42813/"
    );
    const c = creds();
    c.clientId = "own-client";
    await complete(
      "google",
      c,
      p,
      `${p.redirect}?state=${p.state}&code=private-code`,
      async (r) => {
        assert.equal(r.url, "https://oauth2.googleapis.com/token");
        const form = new URLSearchParams(r.body as string);
        assert.equal(form.get("code_verifier"), p.verifier);
        assert.equal(form.get("code"), "private-code");
        return response({
          access_token: "a",
          refresh_token: "r",
          expires_in: 3600,
        });
      }
    );
    assert.equal(c.refreshToken, "r");
  });
});
