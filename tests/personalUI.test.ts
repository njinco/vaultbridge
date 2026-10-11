import { strict as assert } from "node:assert";
import { harness, encode, decode } from "./helpers/vaultBridgeHarness";

describe("Bundled VaultBridge review UI", () => {
  it("filters files without modifying the plan and renders conflict content as text", async () => {
    const h = harness("");
    h.plugin.state.settings.encryption = "none";
    h.local.set("a.md", encode("same\n<script>local</script>\n"));
    h.remote.set("a.md", encode("same\n<img src=x onerror=bad>\n"));
    h.local.set("b.md", encode("upload"));
    const plan = await h.preview();
    assert.ok(plan);
    const el = h.modals.at(-1)!.contentEl;
    const rows = [...el.querySelectorAll<HTMLElement>(".personal-sync-row")];
    assert.equal(rows.length, 2);
    h.changeText("Find files", "a.md");
    assert.equal(rows[0].hidden, false);
    assert.equal(rows[1].hidden, true);
    assert.equal(plan.changes.length, 2);
    await h.click("Compare versions");
    assert.ok(
      el.querySelector("pre")!.textContent!.includes("<script>local</script>")
    );
    assert.equal(el.querySelectorAll("script,img").length, 0);
    h.changeDropdown("a.md", "local");
    assert.equal(plan.changes.find((c) => c.path === "a.md")!.action, "upload");
    assert.ok(el.textContent!.includes("upload: 2"));
    h.changeDropdown("a.md", "preserve");
    assert.equal(
      plan.changes.find((c) => c.path === "a.md")!.action,
      "conflict"
    );
    h.close();
  });
  it("shows validation/Apply counts and applies hidden files too", async () => {
    const h = harness("");
    h.plugin.state.settings.encryption = "none";
    h.local.set("a.md", encode("a"));
    h.local.set("b.md", encode("b"));
    assert.ok(await h.preview());
    const el = h.modals.at(-1)!.contentEl;
    h.changeText("Find files", "a.md");
    await h.apply();
    assert.equal(decode(h.remote.get("a.md")!), "a");
    assert.equal(decode(h.remote.get("b.md")!), "b");
    assert.ok(el.textContent!.includes("Applying 2/2 files"));
  });
  it("requires explicit settings recovery before allowing persistence", async () => {
    const h = harness("");
    h.plugin.loaded = {
      settings: { provider: "box", encryption: "none" },
      histories: {},
    };
    await h.plugin.onload();
    const el = h.displaySettings();
    assert.ok(el.textContent!.includes("encryption: unset"));
    assert.equal(h.plugin.saved.length, 0);
    await h.click("Use recovered settings");
    assert.equal(h.plugin.saved.length, 1);
    assert.equal(h.plugin.state.settings.encryption, "unset");
    assert.equal(h.calls.length, 0);
  });
  it("browses and restores backups without contacting a provider", async () => {
    const h = harness("");
    const source =
      "_personal_sync_backups/1700000000000-00000000-0000-4000-8000-000000000000/remote/note.md";
    h.local.set(source, encode("old"));
    h.local.set("note.md", encode("current"));
    await h.plugin.browseBackups();
    assert.equal(h.plugin.busy, true);
    await h.click("Review restore");
    assert.equal(decode(h.local.get("note.md")!), "current");
    await h.click("Restore reviewed file");
    assert.equal(decode(h.local.get("note.md")!), "old");
    assert.ok(
      [...h.local].some(
        ([path, content]) =>
          path.includes("/local/note.md") && decode(content) === "current"
      )
    );
    assert.equal(h.plugin.busy, false);
    assert.equal(h.calls.length, 0);
  });
  it("requires cleanup review before moving older backup files to trash", async () => {
    const h = harness("");
    const old =
      "_personal_sync_backups/1700000000000-00000000-0000-4000-8000-000000000000/local/note.md";
    const recent = old.replace("1700000000000", "1700000000001");
    h.local.set(old, encode("old"));
    h.local.set(recent, encode("new"));
    await h.plugin.browseBackups();
    h.changeText("Keep newest backup runs", "1");
    await h.click("Review cleanup");
    assert.ok(h.local.has(old));
    assert.ok(h.modals.at(-1)!.contentEl.textContent!.includes(old));
    await h.click("Move reviewed backups to trash");
    assert.ok(!h.local.has(old));
    assert.ok(h.local.has(`.trash/${old}`));
    assert.ok(h.local.has(recent));
    assert.equal(h.calls.length, 0);
    assert.equal(h.plugin.busy, false);
  });
});
