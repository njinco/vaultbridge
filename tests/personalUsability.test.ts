import { strict as assert } from "node:assert";
import { harness, encode, decode } from "./helpers/vaultBridgeHarness";
import { compileExclusions } from "../personal/exclusions";
import { setupIssues } from "../personal/setup";
import { defaults } from "../personal/settings";
import { loadState } from "../personal/state";
import { diagnostics, parseReports } from "../personal/reports";
import { mergedMarkdown } from "../personal/review";

function select(
  h: ReturnType<typeof harness>,
  path: string,
  included: boolean
) {
  const input = h.modals
    .at(-1)!
    .contentEl.querySelector<HTMLInputElement>(
      `input[aria-label="Include ${path}"]`
    )!;
  assert.ok(input);
  input.checked = included;
  input.dispatchEvent(new input.ownerDocument.defaultView!.Event("change"));
}
const plain = () => {
  const h = harness("");
  h.plugin.state.settings.encryption = "none";
  return h;
};

describe("VaultBridge guided setup and review", () => {
  it("matches relative folder and file globs without widening single-star rules", () => {
    const excluded = compileExclusions(
      "# comment\nArchive/\n**/cache/\n*.pdf\nattachments/*.png\nfile?.md"
    );
    for (const path of [
      "Archive/a.md",
      "cache/a.md",
      "notes/cache/sub/b.md",
      "notes/a.pdf",
      "attachments/a.png",
      "file1.md",
    ])
      assert.equal(excluded(path), true, path);
    for (const path of [
      "notes/Archive/a.md",
      "notes/a.PDF",
      "attachments/nested/a.png",
      "file12.md",
      "cached/a.md",
    ])
      assert.equal(excluded(path), false, path);
    assert.equal(
      compileExclusions("**/cache/")("a/b/cache/deep/note.md"),
      true
    );
    assert.equal(compileExclusions("a+b.md")("a+b.md"), true);
    assert.equal(compileExclusions("a+b.md")("aaab.md"), false);
  });
  it("rejects traversal, unsupported syntax and oversized rule sets", () => {
    assert.throws(() => compileExclusions("界".repeat(3000)), /8 KiB/);
    for (const source of [
      "../a",
      "/absolute",
      "folder/../a",
      "!include",
      "a\\b",
      "***",
      "[a]",
      "a//b",
      "x".repeat(8193),
      Array(101).fill("*.md").join("\n"),
    ])
      assert.throws(() => compileExclusions(source), /exclusion|Exclusion/);
    assert.equal(
      compileExclusions("*a".repeat(80) + "z")("a".repeat(2000)),
      false
    );
  });
  it("checks missing or malformed setup without exposing configured secrets", () => {
    const s = defaults();
    s.s3.s3SecretAccessKey = "secret-value";
    s.s3.s3Endpoint = "https://user:password@example.test/?secret=1";
    const issues = setupIssues(s).join(" ");
    assert.ok(issues.includes("encryption"));
    assert.ok(issues.includes("HTTPS"));
    assert.ok(!/secret-value|password@example|secret=1/.test(issues));
  });
  it("checks connection and exclusions without writes or baseline changes", async () => {
    const h = plain();
    h.local.set("private.md", encode("local private"));
    h.remote.set("private.md", encode("remote private"));
    h.remote.set("note.md", encode("sample"));
    h.plugin.state.settings.exclusions = "private.md";
    await h.plugin.start(true);
    assert.equal(h.calls.filter((c) => c.method === "PUT").length, 0);
    assert.equal(h.localWrites.length, 0);
    assert.equal(Object.keys(h.plugin.state.histories).length, 0);
    assert.equal(h.plugin.busy, false);
    const text = h.modals.at(-1)!.contentEl.textContent!;
    assert.ok(text.includes("remote sample was read"));
    assert.ok(text.includes("Local: private.md"));
    assert.ok(text.includes("Remote: private.md"));
    assert.ok(
      h.calls
        .filter((c) => c.method === "GET" && c.key)
        .every((c) => c.key !== "existing/private.md")
    );
  });
  it("explains an empty target cannot confirm content or a password", async () => {
    const h = plain();
    await h.plugin.start(true);
    assert.ok(
      h.modals.at(-1)!.contentEl.textContent!.includes("could not be confirmed")
    );
    assert.equal(h.localWrites.length, 0);
  });
  it("never uploads or downloads excluded files and leaves their baselines alone", async () => {
    const h = plain();
    h.plugin.state.settings.exclusions = "Archive/\n*.pdf";
    h.local.set("Archive/local.md", encode("private local"));
    h.remote.set("remote.pdf", encode("private remote"));
    h.local.set("note.md", encode("shared"));
    const plan = await h.preview();
    assert.deepEqual(
      Array.from(plan!.changes, (c) => c.path),
      ["note.md"]
    );
    await h.apply();
    assert.ok(!h.remote.has("Archive/local.md"));
    assert.ok(!h.local.has("remote.pdf"));
    assert.ok(
      Object.values(h.plugin.state.histories).every(
        (history) => !history["remote.pdf"] && !history["Archive/local.md"]
      )
    );
  });
  it("applies only checked files, including filtered files, without checkpointing unchecked files", async () => {
    const h = plain();
    for (const path of ["a.md", "b.md", "c.md"])
      h.local.set(path, encode(path));
    await h.preview();
    select(h, "b.md", false);
    h.changeText("Find files", "a.md");
    h.local.set("b.md", encode("unselected edit after preview"));
    await h.apply();
    assert.ok(h.remote.has("a.md"));
    assert.ok(h.remote.has("c.md"));
    assert.ok(!h.remote.has("b.md"));
    assert.ok(
      Object.values(h.plugin.state.histories).every(
        (history) => !history["b.md"]
      )
    );
    const report = h.plugin.state.reports![0];
    assert.equal(report.selected, 2);
    assert.equal(report.skipped, 1);
    assert.equal(report.verified, 2);
    assert.equal(report.status, "completed");
  });
  it("disables Apply when every changed file is unchecked", async () => {
    const h = plain();
    h.local.set("a.md", encode("a"));
    await h.preview();
    select(h, "a.md", false);
    const el = h.modals.at(-1)!.contentEl;
    assert.ok(el.textContent!.includes("0 of 1"));
    assert.ok(
      [...el.querySelectorAll("button")].find(
        (b) => b.textContent === "Apply reviewed plan"
      )!.disabled
    );
    await h.apply();
    assert.equal(h.remote.size, 0);
    assert.equal(h.plugin.state.reports!.length, 0);
    h.close();
  });
  it("retains interrupted work when selection would leave unfinished files out", async () => {
    const h = plain();
    h.local.set("a.md", encode("a"));
    h.local.set("b.md", encode("b"));
    const namespace = await import("../personal/identity").then((m) =>
      m.historyNamespace(h.plugin.state.settings)
    );
    h.plugin.state.journals![namespace] = {
      id: "1700000000000-00000000-0000-4000-8000-000000000000",
      startedAt: 1700000000000,
      files: [{ path: "b.md", action: "upload", phase: "write-remote" }],
    };
    await h.preview();
    select(h, "b.md", false);
    await h.apply();
    assert.equal(h.remote.size, 0);
    assert.equal(
      h.plugin.state.journals![namespace].id,
      "1700000000000-00000000-0000-4000-8000-000000000000"
    );
    assert.ok(
      h.notices.some((n) =>
        n.includes("unfinished files outside this selection")
      )
    );
  });
  it("shows all three Markdown versions as text and preserves final newline information", async () => {
    const h = plain();
    h.local.set("note.md", encode("one\ntwo\nthree\n"));
    await h.preview();
    await h.apply();
    h.local.set("note.md", encode("<script>LOCAL</script>\ntwo\nthree\n"));
    h.remote.set("note.md", encode("one\ntwo\nREMOTE\n"));
    const plan = await h.preview();
    assert.equal(plan!.changes[0].action, "merge");
    await h.click("Preview merged result: note.md");
    const el = h.modals.at(-1)!.contentEl;
    assert.equal(el.querySelectorAll("pre").length, 3);
    const merged = el.querySelector('pre[aria-label="Proposed merged result"]')!
      .textContent!;
    assert.ok(merged.includes("<script>LOCAL</script>"));
    assert.ok(merged.includes("REMOTE"));
    assert.equal(el.querySelectorAll("script").length, 0);
    assert.equal(
      mergedMarkdown({
        path: "n.md",
        action: "merge",
        local: encode("a".repeat(140000)),
        remote: encode("b"),
        result: encode("c"),
      }),
      undefined
    );
    h.close();
    h.modals.at(-2)!.close();
  });
  it("records failed and cancelled Apply attempts with bounded results", async () => {
    const fail = harness("", false, { putStatus: 501 });
    fail.plugin.state.settings.encryption = "none";
    fail.local.set("note.md", encode("local"));
    await fail.preview();
    await fail.apply();
    assert.equal(fail.plugin.state.reports![0].status, "failed");
    const h = harness("", false, {
      beforeRequest: async (r) => {
        if (r.method === "PUT") h.cancel();
      },
    });
    h.plugin.state.settings.encryption = "none";
    h.local.set("note.md", encode("local"));
    await h.preview();
    await h.apply();
    assert.equal(h.plugin.state.reports![0].status, "cancelled");
    assert.equal(h.plugin.state.reports![0].verified, 0);
    assert.ok(Object.keys(h.plugin.state.journals!).length);
    const report = fail.plugin.state.reports![0];
    h.plugin.state.reports = Array.from({ length: 20 }, (_, n) => ({
      ...report,
      id: `${1700000000000 + n}-00000000-0000-4000-8000-000000000000`,
    }));
    await h.preview();
    await h.apply();
    assert.equal(h.plugin.state.reports.length, 20);
    assert.equal(parseReports(h.plugin.state.reports).length, 20);
  });
  it("exports only allowed diagnostics fields to an excluded local folder", async () => {
    const h = plain();
    h.plugin.loaded = structuredClone(h.plugin.state);
    await h.plugin.onload();
    h.local.set("private-name.md", encode("private-note-content"));
    await h.preview();
    await h.apply();
    const report = h.plugin.state.reports![0];
    const decorated = {
      ...report,
      token: "secret-token",
      endpoint: "private-endpoint",
      filenames: ["private-name.md"],
      counts: { ...report.counts, secret: "secret-counter" },
    };
    const exported = diagnostics([decorated], "0.1.0");
    assert.ok(
      !/secret-token|private-endpoint|private-name|secret-counter/.test(
        exported
      )
    );
    h.displaySettings();
    await h.click("View sync results");
    await h.click("Export redacted diagnostics");
    const file = [...h.local.keys()].find((path) =>
      path.startsWith(".vaultbridge-diagnostics/")
    )!;
    assert.ok(file);
    const data = decode(h.local.get(file)!);
    assert.ok(data.includes('"completed"'));
    assert.ok(
      !/private-name|private-note|dummy-secret|dummy-id|existing\//.test(data)
    );
    assert.equal(
      (await h.plugin.app.vault.adapter.list(".vaultbridge-diagnostics")).files
        .length,
      1
    );
  });
  it("migrates old state and blocks invalid reports or exclusion rules", () => {
    const s = defaults();
    const { exclusions, ...legacy } = s;
    const migrated = loadState({
      schemaVersion: 2,
      settings: legacy,
      histories: {},
      journals: {},
    });
    assert.equal(migrated.recovered, false);
    assert.equal(migrated.state.settings.exclusions, "");
    assert.equal(migrated.state.schemaVersion, 3);
    assert.throws(
      () =>
        loadState({
          settings: { ...s, exclusions: "../escape" },
          histories: {},
        }),
      /exclusion/
    );
    assert.throws(
      () =>
        loadState({
          schemaVersion: 3,
          settings: s,
          histories: {},
          journals: {},
          reports: [{ token: "secret" }],
        }),
      /reports/
    );
  });
  it("stops diagnostic export on unload before the file write", async () => {
    const h = plain();
    h.plugin.loaded = structuredClone(h.plugin.state);
    await h.plugin.onload();
    h.displaySettings();
    await h.click("View sync results");
    h.plugin.app.vault.adapter.mkdir = async () => {
      h.plugin.onunload();
    };
    await h.click("Export redacted diagnostics");
    assert.equal(h.localWrites.length, 0);
    assert.equal(h.plugin.busy, false);
  });
});
