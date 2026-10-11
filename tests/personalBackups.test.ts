import { strict as assert } from "node:assert";
import type { Vault } from "obsidian";
import {
  listBackups,
  prepareRestore,
  restoreBackup,
  prepareCleanup,
  cleanupBackups,
  BACKUP_ROOT,
} from "../personal/backups";
import { SyncRun } from "../personal/run";
const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const text = (value: ArrayBuffer) => new TextDecoder().decode(value);
const run = (time: number) => `${time}-00000000-0000-4000-8000-000000000000`;
const old = run(1700000000000),
  newer = run(1700000000001),
  undo = run(1700000000002);
const source = (id = old, path = "note.md", side = "remote") =>
  `${BACKUP_ROOT}/${id}/${side}/${path}`;
function fixture(data: Record<string, string>) {
  const files = new Map(
    Object.entries(data).map(([path, value]) => [path, bytes(value)])
  );
  const trashed: string[] = [];
  let failWrite = "";
  const folders = () => {
    const result = new Set<string>();
    for (const path of files.keys()) {
      const parts = path.split("/");
      for (let n = 1; n < parts.length; n++)
        result.add(parts.slice(0, n).join("/"));
    }
    return result;
  };
  const adapter = {
    async exists(path: string) {
      return files.has(path) || folders().has(path);
    },
    async stat(path: string) {
      return files.has(path)
        ? { type: "file", size: files.get(path)!.byteLength }
        : folders().has(path)
          ? { type: "folder", size: 0 }
          : null;
    },
    async list(path: string) {
      const direct = (child: string) =>
        child.startsWith(`${path}/`) &&
        !child.slice(path.length + 1).includes("/");
      return {
        files: [...files.keys()].filter(direct),
        folders: [...folders()].filter(direct),
      };
    },
    async readBinary(path: string) {
      assert.ok(files.has(path));
      return files.get(path)!.slice(0);
    },
    async writeBinary(path: string, content: ArrayBuffer) {
      if (path === failWrite) throw Error("disk full");
      files.set(path, content.slice(0));
    },
    async mkdir() {},
    async trashLocal(path: string) {
      trashed.push(path);
      files.set(`.trash/${path}`, files.get(path)!);
      files.delete(path);
    },
  };
  return {
    vault: { adapter, configDir: ".obsidian" } as unknown as Vault,
    files,
    trashed,
    adapter,
    fail(path: string) {
      failWrite = path;
    },
  };
}
describe("Backup review, restore and retention", () => {
  it("lists Unicode files by newest run without including unrelated files", async () => {
    const f = fixture({
      [source()]: "old",
      [source(newer, "日本語/メモ.md", "local")]: "new",
      "note.md": "current",
      [`${BACKUP_ROOT}/unrecognized/local/note.md`]: "legacy",
    });
    const backups = await listBackups(f.vault);
    assert.equal(backups.length, 2);
    assert.equal(backups[0].path, "日本語/メモ.md");
    assert.equal(backups[0].side, "local");
  });
  it("restores a reviewed file after preserving a verified undo copy", async () => {
    const f = fixture({ [source()]: "old", "note.md": "current" });
    const plan = await prepareRestore(f.vault, (await listBackups(f.vault))[0]);
    assert.equal(text(f.files.get("note.md")!), "current");
    await restoreBackup(f.vault, plan, undo);
    assert.equal(text(f.files.get("note.md")!), "old");
    assert.equal(
      text(f.files.get(source(undo, "note.md", "local"))!),
      "current"
    );
    assert.equal(text(f.files.get(source())!), "old");
  });
  it("restores a missing or zero-byte file", async () => {
    const f = fixture({ [source()]: "" });
    await restoreBackup(
      f.vault,
      await prepareRestore(f.vault, (await listBackups(f.vault))[0]),
      undo
    );
    assert.equal(f.files.get("note.md")!.byteLength, 0);
    assert.equal(f.files.size, 2);
  });
  it("rejects a changed backup, changed destination or newly created destination after review", async () => {
    for (const change of ["backup", "current", "created"]) {
      const f = fixture(
        change === "created"
          ? { [source()]: "old" }
          : { [source()]: "old", "note.md": "current" }
      );
      const plan = await prepareRestore(
        f.vault,
        (await listBackups(f.vault))[0]
      );
      const path = change === "backup" ? source() : "note.md";
      f.files.set(path, bytes("changed"));
      await assert.rejects(
        restoreBackup(f.vault, plan, undo),
        /changed after review/
      );
      assert.equal(text(f.files.get(path)!), "changed");
      assert.ok(!f.files.has(source(undo, "note.md", "local")));
    }
  });
  it("keeps the destination when undo backup creation fails", async () => {
    const f = fixture({ [source()]: "old", "note.md": "current" });
    const plan = await prepareRestore(f.vault, (await listBackups(f.vault))[0]);
    f.fail(source(undo, "note.md", "local"));
    await assert.rejects(restoreBackup(f.vault, plan, undo), /disk full/);
    assert.equal(text(f.files.get("note.md")!), "current");
  });
  it("detects a destination change while the undo copy is being saved", async () => {
    const f = fixture({ [source()]: "old", "note.md": "current" });
    const plan = await prepareRestore(f.vault, (await listBackups(f.vault))[0]);
    const write = f.adapter.writeBinary;
    f.adapter.writeBinary = async (path, content) => {
      await write(path, content);
      if (path.startsWith(`${BACKUP_ROOT}/${undo}/`))
        f.files.set("note.md", bytes("new edit"));
    };
    await assert.rejects(
      restoreBackup(f.vault, plan, undo),
      /changed after review/
    );
    assert.equal(text(f.files.get("note.md")!), "new edit");
  });
  it("rejects forged source paths and configuration destinations", async () => {
    const f = fixture({ [source()]: "old" });
    const backup = (await listBackups(f.vault))[0];
    for (const altered of [
      { ...backup, source: "note.md" },
      { ...backup, path: "../escape" },
      { ...backup, path: ".obsidian/data.json" },
    ])
      await assert.rejects(prepareRestore(f.vault, altered));
  });
  it("reviews cleanup without writes and moves only reviewed older files to local trash", async () => {
    const f = fixture({
      [source()]: "old",
      [source(newer)]: "new",
      "note.md": "current",
    });
    const plan = await prepareCleanup(f.vault, 1);
    assert.deepEqual(
      plan.files.map((x) => x.backup.source),
      [source()]
    );
    assert.equal(f.trashed.length, 0);
    f.files.set(source(old, "added-later.md"), bytes("new backup"));
    await cleanupBackups(f.vault, plan);
    assert.deepEqual(f.trashed, [source()]);
    assert.ok(f.files.has(source(newer)));
    assert.ok(f.files.has(source(old, "added-later.md")));
    assert.equal(text(f.files.get("note.md")!), "current");
    assert.equal(text(f.files.get(`.trash/${source()}`)!), "old");
  });
  it("stops cleanup before any move when a reviewed backup changed", async () => {
    const f = fixture({ [source()]: "old", [source(newer)]: "new" });
    const plan = await prepareCleanup(f.vault, 1);
    f.files.set(source(), bytes("changed"));
    await assert.rejects(
      cleanupBackups(f.vault, plan),
      /changed after cleanup review/
    );
    assert.equal(f.trashed.length, 0);
    for (const keep of [0, -1, 1.5, NaN])
      await assert.rejects(prepareCleanup(f.vault, keep));
  });
  it("stops further cleanup after cancellation during a trash move", async () => {
    const f = fixture({
      [source()]: "old",
      [source(old, "second.md")]: "old2",
      [source(newer)]: "new",
    });
    const plan = await prepareCleanup(f.vault, 1),
      run = new SyncRun();
    const trash = f.adapter.trashLocal;
    f.adapter.trashLocal = async (path) => {
      await trash(path);
      run.cancel();
    };
    await assert.rejects(
      cleanupBackups(f.vault, plan, () => run.check()),
      /cancelled/
    );
    assert.equal(f.trashed.length, 1);
  });
});
