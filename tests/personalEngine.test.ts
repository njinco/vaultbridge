import { strict as assert } from "node:assert";
import {
  apply,
  digest,
  mergeNote,
  preview,
  validatePath,
  type History,
  type Store,
} from "../personal/engine";
import { PersonalSyncError, publicError } from "../personal/errors";
const bytes = (s: string) => new TextEncoder().encode(s).buffer;
const str = (b: ArrayBuffer) => new TextDecoder().decode(b);
class MemoryStore implements Store {
  files = new Map<string, ArrayBuffer>();
  writes = 0;
  failWrite = false;
  failList = false;
  reads = 0;
  constructor(data: Record<string, string>) {
    for (const [k, v] of Object.entries(data)) this.files.set(k, bytes(v));
  }
  async list() {
    if (this.failList) throw Error("list failed");
    return Array.from(this.files, ([path, b]) => ({
      path,
      size: b.byteLength,
    }));
  }
  async read(path: string) {
    this.reads++;
    const b = this.files.get(path);
    if (!b) throw Error("not found");
    return b.slice(0);
  }
  async write(path: string, b: ArrayBuffer) {
    if (this.failWrite) throw Error("upload failed");
    this.writes++;
    this.files.set(path, b.slice(0));
  }
}
function hooks() {
  const backups: string[] = [],
    saved: History[] = [];
  return {
    backups,
    saved,
    backup: async (p: string, s: string, b: ArrayBuffer) => {
      backups.push(`${s}:${p}:${str(b)}`);
    },
    checkpoint: async (h: History) => {
      saved.push(structuredClone(h));
    },
  };
}
const base = async (text: string): Promise<History> => ({
  "a.md": { hash: await digest(bytes(text)), text },
});
describe("Independent personal sync engine", () => {
  it("preserves a local edit made while a merged remote upload is in flight", async () => {
    const original = "one\ntwo\nthree\n";
    const l = new MemoryStore({ "a.md": "ONE\ntwo\nthree\n" }),
      r = new MemoryStore({ "a.md": "one\ntwo\nTHREE\n" });
    const history = await base(original),
      plan = await preview(l, r, history),
      h = hooks();
    const write = r.write.bind(r);
    r.write = async (path, content) => {
      await write(path, content);
      l.files.set("a.md", bytes("new local edit"));
    };
    await assert.rejects(
      apply(plan, l, r, history, h),
      /changed after preview/
    );
    assert.equal(str(l.files.get("a.md")!), "new local edit");
    assert.equal(l.writes, 0);
    assert.equal(history["a.md"].text, original);
    assert.equal(h.backups.length, 2);
  });
  it("preserves a local edit made while the overwrite backup is saved", async () => {
    const l = new MemoryStore({ "a.md": "base" }),
      r = new MemoryStore({ "a.md": "remote edit" });
    const history = await base("base"),
      plan = await preview(l, r, history);
    await assert.rejects(
      apply(plan, l, r, history, {
        ...hooks(),
        backup: async () => {
          l.files.set("a.md", bytes("new edit"));
        },
      }),
      /changed after preview/
    );
    assert.equal(str(l.files.get("a.md")!), "new edit");
    assert.equal(l.writes, 0);
  });
  it("does not replace a missing destination that appeared after preflight", async () => {
    const l = new MemoryStore({}),
      r = new MemoryStore({ "a.md": "remote" });
    await assert.rejects(
      apply(
        await preview(l, r, {}),
        l,
        r,
        {},
        {
          ...hooks(),
          record: async (_path, phase) => {
            if (phase === "write-local")
              l.files.set("a.md", bytes("new local file"));
          },
        }
      ),
      /changed after preview/
    );
    assert.equal(str(l.files.get("a.md")!), "new local file");
    assert.equal(l.writes, 0);
  });
  it("stops before a remote write when saving its journal marker fails", async () => {
    const l = new MemoryStore({ "a.md": "local" }),
      r = new MemoryStore({});
    await assert.rejects(
      apply(
        await preview(l, r, {}),
        l,
        r,
        {},
        {
          ...hooks(),
          record: async () => {
            throw Error("journal failed");
          },
        }
      ),
      /journal failed/
    );
    assert.equal(r.writes, 0);
  });
  it("validates unchanged files once during Apply and saves their new baselines in one checkpoint", async () => {
    const l = new MemoryStore({ "a.md": "a", "b.md": "b" }),
      r = new MemoryStore({ "a.md": "a", "b.md": "b" });
    const history: History = {},
      plan = await preview(l, r, history),
      h = hooks();
    l.reads = r.reads = 0;
    await apply(plan, l, r, history, h);
    assert.equal(l.reads, 2);
    assert.equal(r.reads, 2);
    assert.equal(h.saved.length, 1);
    assert.equal(l.writes + r.writes, 0);
    const next = hooks();
    await apply(await preview(l, r, history), l, r, history, next);
    assert.equal(next.saved.length, 0);
  });
  it("still stops all writes when an unchanged file changes after preview", async () => {
    const l = new MemoryStore({ "a.md": "upload", "z.md": "same" }),
      r = new MemoryStore({ "z.md": "same" });
    const plan = await preview(l, r, {});
    r.files.set("z.md", bytes("new edit"));
    await assert.rejects(
      apply(plan, l, r, {}, hooks()),
      /changed after preview/
    );
    assert.equal(l.writes + r.writes, 0);
  });
  it("does not advance in-memory history when checkpoint persistence fails", async () => {
    for (const equal of [true, false]) {
      const l = new MemoryStore({ "a.md": "a" }),
        r = new MemoryStore(equal ? { "a.md": "a" } : {}),
        history: History = {};
      await assert.rejects(
        apply(await preview(l, r, history), l, r, history, {
          ...hooks(),
          checkpoint: async () => {
            throw Error("save failed");
          },
        }),
        /save failed/
      );
      assert.equal(history["a.md"], undefined);
    }
  });
  it("reports bounded progress for preview, validation and Apply", async () => {
    const l = new MemoryStore({ "a.md": "a" }),
      r = new MemoryStore({});
    const progress: { phase: string; completed: number; total: number }[] = [];
    const plan = await preview(l, r, {}, (p) => progress.push(p));
    await apply(
      plan,
      l,
      r,
      {},
      { ...hooks(), progress: (p) => progress.push(p) }
    );
    for (const phase of ["preview", "validate", "apply"]) {
      const entries = progress.filter((p) => p.phase === phase);
      assert.equal(entries[0].completed, 0);
      assert.equal(entries.at(-1)!.completed, 1);
      assert.ok(entries.every((p) => p.completed <= p.total));
    }
  });
  it("does not display credentials embedded in raw SDK exceptions", () => {
    assert.ok(
      !publicError(new Error("private-token signed-url")).includes(
        "private-token"
      )
    );
    assert.equal(
      publicError(new PersonalSyncError("Preview again.")),
      "Preview again."
    );
  });
  it("previews first-sync differences without any write", async () => {
    const l = new MemoryStore({ "a.md": "local" }),
      r = new MemoryStore({ "a.md": "remote" });
    const p = await preview(l, r, {});
    assert.equal(p.changes[0].action, "conflict");
    assert.equal(l.writes + r.writes, 0);
    const h = hooks();
    await apply(p, l, r, {}, h);
    assert.equal(l.writes + r.writes, 0);
    assert.equal(h.backups.length, 2);
    assert.equal(h.saved.length, 0);
  });
  it("copies disjoint files in both directions and records verified history", async () => {
    const l = new MemoryStore({ "a.md": "local" }),
      r = new MemoryStore({ "b.md": "remote" }),
      history: History = {};
    const p = await preview(l, r, history),
      h = hooks();
    await apply(p, l, r, history, h);
    assert.equal(str(await r.read("a.md")), "local");
    assert.equal(str(await l.read("b.md")), "remote");
    assert.equal(h.saved.length, 2);
    assert.equal(history["a.md"].text, "local");
  });
  it("applies an explicit conflict choice with a backup of the replaced version", async () => {
    const l = new MemoryStore({ "a.md": "chosen local" }),
      r = new MemoryStore({ "a.md": "remote" });
    const p = await preview(l, r, {}),
      c = p.changes[0],
      h = hooks();
    c.action = "upload";
    c.result = c.local;
    await apply(p, l, r, {}, h);
    assert.equal(str(await r.read("a.md")), "chosen local");
    assert.deepEqual(h.backups, ["remote:a.md:remote"]);
  });
  it("handles zero-byte files", async () => {
    const l = new MemoryStore({ empty: "" }),
      r = new MemoryStore({});
    await apply(await preview(l, r, {}), l, r, {}, hooks());
    assert.equal((await r.read("empty")).byteLength, 0);
  });
  it("uses hashes rather than timestamps to detect one-sided edits", async () => {
    const l = new MemoryStore({ "a.md": "edited" }),
      r = new MemoryStore({ "a.md": "base" });
    const p = await preview(l, r, await base("base"));
    assert.equal(p.changes[0].action, "upload");
    const h = hooks();
    await apply(p, l, r, {}, h);
    assert.deepEqual(h.backups, ["remote:a.md:base"]);
  });
  it("merges independent edits from a verified common Markdown version", async () => {
    const original = "one\ntwo\nthree\nfour\n";
    const l = new MemoryStore({ "a.md": "ONE\ntwo\nthree\nfour\n" }),
      r = new MemoryStore({ "a.md": "one\ntwo\nthree\nFOUR\n" });
    const history = await base(original),
      p = await preview(l, r, history),
      h = hooks();
    assert.equal(p.changes[0].action, "merge");
    await apply(p, l, r, history, h);
    assert.equal(str(await l.read("a.md")), "ONE\ntwo\nthree\nFOUR\n");
    assert.equal(str(await r.read("a.md")), str(await l.read("a.md")));
    assert.equal(h.backups.length, 2);
  });
  it("preserves overlapping changes as conflicts", async () => {
    const l = new MemoryStore({ "a.md": "left\n" }),
      r = new MemoryStore({ "a.md": "right\n" });
    assert.equal(
      (await preview(l, r, await base("original\n"))).changes[0].action,
      "conflict"
    );
  });
  it("keeps CRLF, BOM, and missing final newlines", () => {
    assert.equal(
      mergeNote("\ufeffa\r\nb\r\nc", "\ufeffA\r\nb\r\nc", "\ufeffa\r\nb\r\nC"),
      "\ufeffA\r\nb\r\nC"
    );
    assert.equal(mergeNote("a\nb\nc\n", "a\nb\nc", "A\nb\nc\n"), "A\nb\nc");
  });
  it("rejects a corrupted stored common version", async () => {
    const history = await base("base");
    history["a.md"].text = "tampered";
    const p = await preview(
      new MemoryStore({ "a.md": "left" }),
      new MemoryStore({ "a.md": "right" }),
      history
    );
    assert.equal(p.changes[0].action, "conflict");
  });
  it("does not auto-merge binary or non-Markdown files", async () => {
    const l = new MemoryStore({ "a.txt": "left" }),
      r = new MemoryStore({ "a.txt": "right" });
    assert.equal(
      (
        await preview(l, r, {
          "a.txt": { hash: await digest(bytes("base")), text: "base" },
        })
      ).changes[0].action,
      "conflict"
    );
  });
  it("restores missing files without propagating deletions", async () => {
    const l = new MemoryStore({}),
      r = new MemoryStore({ "a.md": "base" }),
      history = await base("base");
    const p = await preview(l, r, history);
    assert.equal(p.changes[0].action, "download");
    await apply(p, l, r, history, hooks());
    assert.equal(str(await l.read("a.md")), "base");
  });
  it("stops before any write when a later file changed after preview", async () => {
    const l = new MemoryStore({ "a.md": "first", "z.md": "last" }),
      r = new MemoryStore({});
    const p = await preview(l, r, {});
    l.files.set("z.md", bytes("changed"));
    await assert.rejects(apply(p, l, r, {}, hooks()), /changed after preview/);
    assert.equal(r.writes, 0);
  });
  it("stops before any write if a formerly absent destination was created", async () => {
    const l = new MemoryStore({ "a.md": "local" }),
      r = new MemoryStore({});
    const p = await preview(l, r, {});
    r.files.set("a.md", bytes("new remote"));
    await assert.rejects(apply(p, l, r, {}, hooks()), /changed after preview/);
    assert.equal(r.writes, 0);
  });
  it("retains backups and does not advance history on failed upload", async () => {
    const l = new MemoryStore({ "a.md": "edited" }),
      r = new MemoryStore({ "a.md": "base" }),
      history = await base("base");
    const p = await preview(l, r, history),
      h = hooks();
    r.failWrite = true;
    await assert.rejects(apply(p, l, r, history, h), /upload failed/);
    assert.equal(history["a.md"].text, "base");
    assert.equal(h.saved.length, 0);
    assert.equal(h.backups.length, 1);
  });
  it("does not advance history when remote write verification fails", async () => {
    const l = new MemoryStore({ "a.md": "edited" }),
      r = new MemoryStore({ "a.md": "base" }),
      history = await base("base");
    const p = await preview(l, r, history),
      h = hooks();
    r.write = async () => {};
    await assert.rejects(apply(p, l, r, history, h), /verification failed/);
    assert.equal(history["a.md"].text, "base");
  });
  it("does not write original notes unless required backups succeed", async () => {
    const l = new MemoryStore({ "a.md": "edited" }),
      r = new MemoryStore({ "a.md": "base" }),
      history = await base("base");
    const p = await preview(l, r, history);
    await assert.rejects(
      apply(p, l, r, history, {
        ...hooks(),
        backup: async () => {
          throw Error("disk full");
        },
      }),
      /disk full/
    );
    assert.equal(r.writes, 0);
  });
  it("fails closed on incomplete inventories", async () => {
    const l = new MemoryStore({ "a.md": "local" }),
      r = new MemoryStore({});
    r.failList = true;
    await assert.rejects(preview(l, r, {}));
    assert.equal(l.writes + r.writes, 0);
  });
  it("excludes hidden configuration files", async () => {
    const p = await preview(
      new MemoryStore({
        ".obsidian/plugins/other/data.json": "secret",
        "_personal_sync_backups/previous/a.md": "old",
        "note.md": "note",
      }),
      new MemoryStore({}),
      {}
    );
    assert.deepEqual(
      p.changes.map((x) => x.path),
      ["note.md"]
    );
  });
  it("rejects traversal and prototype-sensitive paths", () => {
    for (const p of [
      "../escape",
      "a/../b",
      "/absolute",
      "a\\b",
      "a\0b",
      "__proto__",
      "a/constructor",
      "a//b",
      "note.md ",
      "C:/x",
    ])
      assert.throws(() => validatePath(p));
  });
  it("rejects case, Unicode and file/folder collisions", async () => {
    const examples: Record<string, string>[] = [
      { "A.md": "a", "a.md": "b" },
      { "é.md": "a", "e\u0301.md": "b" },
      { a: "a", "a/b": "b" },
      { "A/x": "a", "a/y": "b" },
      { A: "a", "a/x": "b" },
    ];
    for (const data of examples) {
      await assert.rejects(
        preview(new MemoryStore(data), new MemoryStore({}), {}),
        /collision/
      );
    }
  });
  it("rejects duplicate cloud names instead of silently overwriting", async () => {
    const r = new MemoryStore({ a: "content" });
    r.list = async () => [
      { path: "a", size: 1 },
      { path: "a", size: 1 },
    ];
    await assert.rejects(preview(new MemoryStore({}), r, {}), /Duplicate/);
  });
});
