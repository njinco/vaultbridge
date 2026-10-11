// SPDX-License-Identifier: Apache-2.0
import {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import {
  supportedProvider,
  type Credentials,
  type Provider,
  type Transport,
} from "./cloud";
import {
  apply,
  included,
  preview,
  type Plan,
  type Store,
  type Progress,
  type Change,
  textOf,
} from "./engine";
import { authorize, complete, persistAuthorization } from "./oauth";
import {
  defaults,
  ensureParents,
  openRemote,
  type Settings,
  VaultStore,
} from "./storage";
import { PersonalSyncError, publicError } from "./errors";
import { SyncRun } from "./run";
import { loadState, type Saved } from "./state";
import { SaveQueue } from "./saveQueue";
import { historyNamespace, selectHistory } from "./identity";
import { newJournal, type SyncJournal } from "./journal";
import { compareMarkdown, mergedMarkdown } from "./review";
import { compileExclusions } from "./exclusions";
import { setupIssues } from "./setup";
import { countActions, diagnostics, type SyncReport } from "./reports";
import {
  listBackups,
  prepareRestore,
  restoreBackup,
  prepareCleanup,
  cleanupBackups,
  type Backup,
} from "./backups";

const transport: Transport = async (r) => {
  // Obsidian's native HTTP API avoids browser CORS on both desktop and mobile.
  const response = await requestUrl({ ...r, throw: false });
  return {
    status: response.status,
    headers: response.headers,
    body: response.arrayBuffer,
  };
};
export default class PersonalSync extends Plugin {
  state: Saved = {
    schemaVersion: 3,
    settings: defaults(),
    histories: {},
    journals: {},
    reports: [],
  };
  private saves = new SaveQueue();
  recoveryNeeded = false;
  loadBlocked = "";
  sessionPassword = "";
  busy = false;
  private unloaded = false;
  private run?: SyncRun;
  private activeModal?: Modal;
  private connection?: Awaited<ReturnType<typeof openRemote>>;
  notice(message: string, duration = 4000) {
    if (!this.unloaded) new Notice(message, duration);
  }
  async onload() {
    try {
      const loaded = loadState(await this.loadData());
      this.state = loaded.state;
      this.recoveryNeeded = loaded.recovered;
    } catch (error) {
      this.loadBlocked =
        error instanceof PersonalSyncError
          ? error.message
          : "Saved settings could not be read. Keep a copy of data.json and repair it before syncing.";
      this.notice(this.loadBlocked, 12000);
    }
    // Upgrade the preliminary build without leaving a password on disk. Keep
    // its existing password in this session only, then scrub the saved setting.
    if (this.state.settings.password) {
      this.sessionPassword = this.state.settings.password;
      this.state.settings.password = "";
      if (!this.recoveryNeeded && !this.loadBlocked) {
        try {
          await this.persist();
        } catch {
          this.recoveryNeeded = true;
        }
      }
    }
    if (this.recoveryNeeded)
      this.notice(
        "Saved settings need review. Open VaultBridge settings before syncing; the saved file has not been replaced.",
        12000
      );
    if (Object.keys(this.state.journals ?? {}).length)
      this.notice(
        "An interrupted VaultBridge sync was recorded. Review affected files in settings and create a fresh preview; no operations will be replayed automatically.",
        16000
      );
    this.addSettingTab(new PersonalSettings(this));
    this.addCommand({
      id: "preview-sync",
      name: "Preview VaultBridge sync",
      callback: () => {
        void this.start();
      },
    });
    this.addCommand({
      id: "browse-backups",
      name: "Browse VaultBridge backups",
      callback: () => {
        void this.browseBackups();
      },
    });
    this.addCommand({
      id: "sync-results",
      name: "View VaultBridge sync results",
      callback: () => new ReportsModal(this).open(),
    });
    this.addCommand({
      id: "check-connection",
      name: "Check VaultBridge connection",
      callback: () => {
        void this.start(true);
      },
    });
    this.addRibbonIcon("refresh-cw", "Preview VaultBridge sync", () => {
      void this.start();
    });
    // No cloud requests, automatic sync, URI handlers or listeners at load time.
  }
  async persist() {
    if (this.loadBlocked || this.recoveryNeeded)
      throw new PersonalSyncError(
        "Review or repair saved settings before saving changes."
      );
    try {
      await this.saves.enqueue(
        {
          ...this.state,
          schemaVersion: 3,
          journals: this.state.journals ?? {},
          reports: this.state.reports ?? [],
          settings: { ...this.state.settings, password: "" },
        },
        (snapshot) => this.saveData(snapshot)
      );
    } catch {
      throw new PersonalSyncError(
        "VaultBridge settings could not be saved. Sync stopped; review again after fixing local storage access."
      );
    }
  }
  onunload() {
    this.unloaded = true;
    this.sessionPassword = "";
    this.run?.cancel();
    this.activeModal?.close();
    // Closing encryption resources rejects outstanding worker requests. Native
    // HTTP/file writes may still settle; guarded operations cannot follow them.
    void this.connection?.close().catch(() => {});
  }
  async exportDiagnostics(reports: SyncReport[]): Promise<string> {
    if (this.unloaded || this.busy)
      throw new PersonalSyncError(
        "Finish the current VaultBridge operation before exporting."
      );
    this.busy = true;
    const run = new SyncRun();
    this.run = run;
    try {
      const report = diagnostics(
        reports,
        this.manifest?.version ?? "development"
      );
      const path = `.vaultbridge-diagnostics/${Date.now()}-${crypto.randomUUID()}.json`;
      await run.step(() =>
        ensureParents(this.app.vault, path, () => run.check())
      );
      if (await run.step(() => this.app.vault.adapter.exists(path)))
        throw new PersonalSyncError("Diagnostic destination already exists.");
      await run.step(() =>
        this.app.vault.adapter.writeBinary(
          path,
          new TextEncoder().encode(report).buffer
        )
      );
      return path;
    } finally {
      this.run = undefined;
      this.busy = false;
    }
  }
  async browseBackups(runId?: string) {
    if (this.unloaded) return;
    if (this.busy) {
      this.notice("Finish the current VaultBridge operation first.");
      return;
    }
    this.busy = true;
    const run = new SyncRun();
    this.run = run;
    const release = () => {
      this.activeModal = undefined;
      this.run = undefined;
      this.busy = false;
    };
    try {
      const backups = (
        await listBackups(this.app.vault, () => run.check())
      ).filter(
        (backup) =>
          !runId || backup.path.startsWith(`_personal_sync_backups/${runId}/`)
      );
      run.check();
      this.activeModal = new BackupModal(this, backups, run, release);
      this.activeModal.open();
    } catch (error) {
      release();
      this.notice(
        error instanceof PersonalSyncError
          ? error.message
          : "Backups could not be read. Check vault storage access.",
        12000
      );
    }
  }
  async start(checkOnly = false) {
    if (this.unloaded) return;
    if (this.loadBlocked || this.recoveryNeeded) {
      this.notice(
        this.loadBlocked ||
          "Open VaultBridge settings and review recovered settings before syncing.",
        12000
      );
      return;
    }
    if (this.busy) {
      new Notice("A VaultBridge sync preview is already open.");
      return;
    }
    this.busy = true;
    const run = new SyncRun();
    this.run = run;
    let remote: Awaited<ReturnType<typeof openRemote>> | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await remote?.close();
      } finally {
        this.activeModal = undefined;
        this.connection = undefined;
        this.run = undefined;
        this.busy = false;
      }
    };
    try {
      const config = structuredClone(this.state.settings);
      const issues = setupIssues(config);
      if (issues.length) throw new PersonalSyncError(issues.join(" "));
      const excluded = compileExclusions(config.exclusions);
      const excludedFiles = new Set<string>();
      if (!supportedProvider(config.provider))
        throw new PersonalSyncError(
          "Choose S3, Google Drive or Dropbox in settings."
        );
      if (config.encryption !== "none" && config.encryption !== "unset") {
        if (!this.sessionPassword) {
          const password = await new Promise<string | undefined>((resolve) => {
            this.activeModal = new UnlockModal(this, resolve);
            this.activeModal.open();
          });
          run.check();
          if (password === undefined) {
            await release();
            return;
          }
          this.sessionPassword = password;
        }
        config.password = this.sessionPassword;
      } else config.password = "";
      // Capture the old token-based key before identity lookup can rotate tokens.
      const legacyNamespace = await historyNamespace(config);
      this.activeModal = new ProgressModal(this, () => run.cancel());
      this.activeModal.open();
      remote = await openRemote(
        config,
        (request) => run.step(() => transport(request)),
        async () => {
          run.check();
          if (config.provider !== "s3")
            this.state.settings[config.provider] = config[config.provider];
          await run.step(() => this.persist());
        },
        () => run.check()
      );
      this.connection = remote;
      run.check();
      const vault = new VaultStore(this.app.vault, () => run.check());
      const local = run.store({
        list: async () =>
          (await vault.list()).filter((entry) => {
            if (excluded(entry.path)) {
              excludedFiles.add(`Local: ${entry.path}`);
              return false;
            }
            return true;
          }),
        read: (path) => vault.read(path),
        write: (path, bytes, expected) => vault.write(path, bytes, expected),
      });
      const configDir = this.app.vault.configDir;
      const permitted = (path: string) =>
        included(path) &&
        path !== configDir &&
        !path.startsWith(`${configDir}/`) &&
        !excluded(path);
      const cloud = remote;
      const protectedRemote: Store = run.store({
        list: async () =>
          (await cloud.list()).filter((x) => {
            if (included(x.path) && excluded(x.path))
              excludedFiles.add(`Remote: ${x.path}`);
            return permitted(x.path);
          }),
        read: async (path) => {
          if (!permitted(path)) throw new Error("Excluded path.");
          return cloud.read(path);
        },
        write: async (path, bytes) => {
          if (!permitted(path)) throw new Error("Excluded path.");
          await cloud.write(path, bytes);
        },
      });
      if (checkOnly) {
        const [localEntries, remoteEntries] = await Promise.all([
          local.list(),
          protectedRemote.list(),
        ]);
        run.check();
        // A bounded sample proves content can be read/decrypted, not every file.
        const sample = remoteEntries.find(
          (entry) => entry.size !== undefined && entry.size <= 50 * 1024 * 1024
        );
        if (sample) {
          const bytes = await protectedRemote.read(sample.path);
          if (bytes.byteLength > 50 * 1024 * 1024)
            throw new PersonalSyncError(
              "Connection sample exceeded the file safety limit."
            );
        }
        run.check();
        (this.activeModal as ProgressModal).finish();
        await release();
        new ConnectionModal(
          this,
          config.provider === "s3"
            ? `S3 bucket: ${config.s3.s3BucketName}; prefix: ${config.s3.remotePrefix || "bucket root"}.`
            : `${config.provider === "google" ? "Google Drive" : "Dropbox"}: account identity confirmed; folder: ${config[config.provider].root}.`,
          config.encryption,
          localEntries.length,
          remoteEntries.length,
          !!sample,
          [...excludedFiles].sort()
        ).open();
        return;
      }
      const namespace = await historyNamespace(config, remote.accountId);
      const selected = selectHistory(
        this.state.histories,
        namespace,
        legacyNamespace
      );
      const history = selected.history;
      new Notice("Reading local and remote files for preview…");
      const plan = await preview(
        local,
        protectedRemote,
        history,
        (progress) => {
          (this.activeModal as ProgressModal).update(progress);
        }
      );
      run.check();
      // Replace the progress dialog without treating this transition as Cancel.
      if (selected.migrated) {
        this.state.histories[namespace] = history;
        try {
          await run.step(() => this.persist());
        } catch (error) {
          delete this.state.histories[namespace];
          throw error;
        }
      }
      (this.activeModal as ProgressModal).finish();
      this.activeModal = new PreviewModal(
        this,
        plan,
        async (selectedPlan) => {
          const startedAt = Date.now();
          const runId = `${Date.now()}-${crypto.randomUUID()}`;
          const base = `_personal_sync_backups/${runId}`;
          let verified = 0,
            preserved = 0;
          let outcome: SyncReport["status"] = "failed";
          try {
            const journals = (this.state.journals ??= {});
            const previousJournal = journals[namespace];
            const reviewedPaths = new Set(
              selectedPlan.changes.map((change) => change.path)
            );
            if (
              previousJournal?.files.some(
                (file) =>
                  !["verified", "preserved"].includes(file.phase) &&
                  !reviewedPaths.has(file.path)
              )
            )
              throw new PersonalSyncError(
                "An interrupted run has unfinished files outside this selection. Include those files and remove any exclusion hiding them before applying; its journal was retained."
              );
            const journal = newJournal(selectedPlan, runId, startedAt);
            const journalFiles = new Map(
              journal.files.map((file) => [file.path, file])
            );
            journals[namespace] = journal;
            try {
              await run.step(() => this.persist());
            } catch (error) {
              if (previousJournal) journals[namespace] = previousJournal;
              else delete journals[namespace];
              throw error;
            }
            const conflicts = await apply(
              selectedPlan,
              local,
              protectedRemote,
              history,
              {
                record: async (path, phase) => {
                  run.check();
                  const file = journalFiles.get(path);
                  if (!file)
                    throw new PersonalSyncError(
                      "Sync journal did not contain the reviewed file."
                    );
                  file.phase = phase;
                  if (phase === "verified") verified++;
                  if (phase === "preserved") preserved++;
                  await run.step(() => this.persist());
                },
                progress: (progress) =>
                  (this.activeModal as PreviewModal).update(progress),
                backup: async (path, side, bytes) => {
                  run.check();
                  const target = `${base}/${side}/${path}`;
                  await ensureParents(this.app.vault, target, () =>
                    run.check()
                  );
                  await run.step(() =>
                    this.app.vault.adapter.writeBinary(target, bytes)
                  );
                },
                checkpoint: async (h) => {
                  run.check();
                  this.state.histories[namespace] = h;
                  await run.step(() => this.persist());
                },
              }
            );
            run.check();
            delete journals[namespace];
            try {
              await run.step(() => this.persist());
            } catch (error) {
              journals[namespace] = journal;
              throw error;
            }
            outcome = "completed";
            this.notice(
              conflicts
                ? `Sync applied. ${conflicts} conflict(s) preserved; originals unchanged. Backups: ${base}`
                : "VaultBridge sync applied and verified.",
              12000
            );
          } catch (error) {
            outcome = run.cancelled ? "cancelled" : "failed";
            throw error;
          } finally {
            const counts = countActions(selectedPlan);
            const report: SyncReport = {
              id: runId,
              startedAt,
              endedAt: Math.max(startedAt, Date.now()),
              provider: config.provider,
              status: outcome,
              counts,
              selected: selectedPlan.changes.filter((c) => c.action !== "equal")
                .length,
              skipped:
                plan.changes.filter((c) => c.action !== "equal").length -
                selectedPlan.changes.filter((c) => c.action !== "equal").length,
              verified,
              preserved,
            };
            this.state.reports = [report, ...(this.state.reports ?? [])].slice(
              0,
              20
            );
            try {
              await this.persist();
            } catch {
              this.notice(
                "Sync result could not be saved locally. Inspect the files and journal before continuing.",
                12000
              );
            }
          }
        },
        release,
        () => run.cancel(),
        this.state.journals?.[namespace],
        [...excludedFiles].sort()
      );
      this.activeModal.open();
    } catch (error) {
      this.activeModal?.close();
      await release();
      // A mistaken passphrase must not leave the user stuck with repeated
      // failures. Ask again next time; never expose the provider's raw error.
      this.sessionPassword = "";
      // Provider exceptions can include signed URLs or secrets. Never log them.
      if (!this.unloaded)
        new Notice(
          `${checkOnly ? "Connection check" : "Preview"} stopped: ${publicError(error)} No sync writes were attempted.`,
          12000
        );
    }
  }
}
class ProgressModal extends Modal {
  private completed = false;
  private status?: HTMLElement;
  constructor(
    readonly plugin: PersonalSync,
    readonly cancel: () => void
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Preparing VaultBridge preview" });
    this.contentEl.createEl("p", {
      text: "Reading files. Cancel stops further work after the current operation settles.",
    });
    this.status = this.contentEl.createEl("p", {
      attr: { "aria-live": "polite" },
    });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Cancel").onClick(() => this.close())
    );
  }
  finish() {
    this.completed = true;
    this.close();
  }
  update(progress: Progress) {
    if (this.status)
      this.status.textContent = `Reading ${progress.completed}/${progress.total} files`;
  }
  onClose() {
    if (!this.completed) this.cancel();
    this.contentEl.empty();
  }
}
class UnlockModal extends Modal {
  private completed = false;
  constructor(
    readonly plugin: PersonalSync,
    readonly resolve: (password?: string) => void
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Unlock VaultBridge encryption" });
    this.contentEl.createEl("p", {
      text: "Enter the password used for your existing encrypted storage. It stays in memory for this session and is not saved in plugin settings.",
    });
    let password = "";
    new Setting(this.contentEl).setName("Encryption password").addText((t) => {
      t.inputEl.type = "password";
      t.onChange((v) => {
        password = v;
      });
    });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText("Unlock")
          .setCta()
          .onClick(() => {
            if (this.completed || !password) return;
            this.completed = true;
            this.resolve(password);
            password = "";
            this.close();
          })
      );
  }
  onClose() {
    if (!this.completed) {
      this.completed = true;
      this.resolve(undefined);
    }
    this.contentEl.empty();
  }
}
class PreviewModal extends Modal {
  private applying = false;
  private finished = false;
  private released?: Promise<void>;
  private status?: HTMLElement;
  update(progress: Progress) {
    if (this.status)
      this.status.textContent = `${progress.phase === "validate" ? "Validating" : "Applying"} ${progress.completed}/${progress.total} files`;
  }
  constructor(
    readonly plugin: PersonalSync,
    readonly plan: Plan,
    readonly perform: (selected: Plan) => Promise<void>,
    readonly release: () => Promise<void>,
    readonly cancel: () => void,
    readonly interrupted?: SyncJournal,
    readonly exclusions: string[] = []
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Review VaultBridge sync" });
    if (this.interrupted) {
      this.contentEl.createEl("p", {
        text: `Interrupted run ${this.interrupted.id}: inspect backups and the fresh plan below. Apply starts a new reviewed run; it does not replay saved operations.`,
      });
      for (const file of this.interrupted.files.slice(0, 100))
        this.contentEl.createEl("p", { text: `${file.phase}: ${file.path}` });
      if (this.interrupted.files.length > 100)
        this.contentEl.createEl("p", {
          text: "More affected files are listed in VaultBridge settings.",
        });
    }
    this.contentEl.createEl("p", {
      text: "Files are read for this preview. Apply copies changes and backs up overwritten/conflicting content. Missing files are restored; deletions are not propagated.",
    });
    const selected = new Set(
      this.plan.changes.filter((c) => c.action !== "equal").map((c) => c.path)
    );
    const canApply = () =>
      selected.size > 0 || this.plan.changes.every((c) => c.action === "equal");
    const summary = this.contentEl.createEl("p");
    const selectionSummary = this.contentEl.createEl("p", {
      attr: { "aria-live": "polite" },
    });
    let applyButton: { setDisabled(value: boolean): unknown } | undefined;
    const updateSelection = () => {
      selectionSummary.textContent = `${selected.size} of ${this.plan.changes.filter((c) => c.action !== "equal").length} changed file(s) selected. Hidden checked files are included; unchecked files are skipped. Equal files are validated for common history.`;
      applyButton?.setDisabled(!canApply() || this.applying || this.finished);
    };
    updateSelection();
    const updateSummary = () => {
      const counts = this.plan.changes.reduce<Record<string, number>>(
        (a, c) => {
          a[c.action] = (a[c.action] ?? 0) + 1;
          return a;
        },
        {}
      );
      summary.textContent =
        Object.entries(counts)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ") || "No files to sync.";
    };
    updateSummary();
    this.contentEl.createEl("p", {
      text: "Filters only change this view. Apply includes selected files, including checked files hidden by a filter.",
    });
    showExcluded(this.contentEl, this.exclusions);
    let query = "",
      action = "all";
    const rows: { change: Plan["changes"][number]; element: HTMLElement }[] =
      [];
    const filter = () => {
      for (const row of rows)
        row.element.hidden =
          !row.change.path.toLowerCase().includes(query.toLowerCase()) ||
          (action !== "all" && row.change.action !== action);
    };
    new Setting(this.contentEl).setName("Find files").addText((t) =>
      t.onChange((value) => {
        query = value;
        filter();
      })
    );
    new Setting(this.contentEl).setName("Show changes").addDropdown((d) =>
      d
        .addOptions({
          all: "All changes",
          conflict: "Conflicts",
          merge: "Merges",
          upload: "Uploads",
          download: "Downloads",
        })
        .setValue("all")
        .onChange((value) => {
          action = value;
          filter();
        })
    );
    this.status = this.contentEl.createEl("p", {
      attr: { "aria-live": "polite" },
    });
    const list = this.contentEl.createEl("div", {
      cls: "personal-sync-preview",
    });
    for (const c of this.plan.changes.filter((x) => x.action !== "equal")) {
      const row = list.createEl("div", { cls: "personal-sync-row" });
      rows.push({ change: c, element: row });
      const checkbox = row.createEl("input", {
        attr: { type: "checkbox", "aria-label": `Include ${c.path}` },
      }) as HTMLInputElement;
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        if (this.applying || this.finished) {
          checkbox.checked = selected.has(c.path);
          return;
        }
        if (checkbox.checked) selected.add(c.path);
        else selected.delete(c.path);
        updateSelection();
      });
      if (c.action === "merge") {
        new Setting(row).addButton((b) =>
          b.setButtonText(`Preview merged result: ${c.path}`).onClick(() => {
            new MergedModal(this.plugin, c).open();
          })
        );
      }
      if (c.action !== "conflict") {
        row.createEl("p", { text: `${c.action}: ${c.path}` });
        continue;
      }
      new Setting(row)
        .setName(c.path)
        .setDesc(c.reason ?? "Conflicting versions")
        .addDropdown((d) =>
          d
            .addOptions({
              preserve: "Preserve both; leave originals",
              local: "Use local; back up remote",
              remote: "Use remote; back up local",
            })
            .setValue("preserve")
            .onChange((v) => {
              if (this.applying || this.finished) return;
              c.action =
                v === "local"
                  ? "upload"
                  : v === "remote"
                    ? "download"
                    : "conflict";
              c.result =
                v === "local" ? c.local : v === "remote" ? c.remote : undefined;
              updateSummary();
              filter();
            })
        );
      let shown = false;
      new Setting(row).addButton((b) =>
        b.setButtonText("Compare versions").onClick(() => {
          if (shown) return;
          shown = true;
          b.setDisabled(true);
          const comparison = compareMarkdown(c.path, c.local, c.remote);
          if (!comparison) {
            row.createEl("p", {
              text: "Inline comparison is available for UTF-8 Markdown up to 128 KiB combined and 2,000 lines. Inspect larger or binary versions through their preserved backups.",
            });
            return;
          }
          row.createEl("p", {
            text: "− Local only · + Remote only · Unmarked lines match",
          });
          const diff = row.createEl("pre", {
            cls: "personal-sync-diff",
            attr: { "aria-label": `Local and remote comparison for ${c.path}` },
          });
          for (const line of comparison)
            diff.createEl("span", {
              cls: `personal-sync-diff-${line.kind}`,
              text: `${line.kind === "local" ? "− " : line.kind === "remote" ? "+ " : "  "}${line.text.endsWith("\n") ? line.text : `${line.text}\n[No final newline]\n`}`,
            });
        })
      );
    }
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((b) => {
        applyButton = b;
        b.setDisabled(!canApply())
          .setButtonText("Apply reviewed plan")
          .setCta()
          .onClick(async () => {
            if (this.applying || this.finished || !canApply()) return;
            this.applying = true;
            b.setDisabled(true);
            try {
              await this.perform({
                changes: this.plan.changes.filter(
                  (c) => c.action === "equal" || selected.has(c.path)
                ),
              });
            } catch (error) {
              this.plugin.notice(
                `Sync stopped: ${publicError(error)} Some changes may have applied; backups were retained. Preview again before continuing.`,
                12000
              );
            } finally {
              this.applying = false;
              this.finished = true;
              this.close();
              await this.releaseOnce();
            }
          });
      });
  }
  onClose() {
    this.cancel();
    // Keep the connection locked until an in-flight write has settled.
    if (this.applying) return;
    void this.releaseOnce().catch(() => {});
  }
  private async releaseOnce() {
    this.released ??= this.release();
    await this.released;
  }
}
function showExcluded(el: HTMLElement, files: string[]) {
  const details = el.createEl("details");
  details.createEl("summary", {
    text: `${files.length} file(s) excluded by custom rules`,
  });
  const list = details.createEl("div");
  let limit = 100;
  const render = () => {
    list.empty();
    for (const path of files.slice(0, limit))
      list.createEl("p", { text: path });
    if (files.length > limit)
      new Setting(list).addButton((b) =>
        b.setButtonText("Show more excluded files").onClick(() => {
          limit += 100;
          render();
        })
      );
  };
  render();
}
class ConnectionModal extends Modal {
  constructor(
    readonly plugin: PersonalSync,
    readonly target: string,
    readonly encryption: Settings["encryption"],
    readonly localCount: number,
    readonly remoteCount: number,
    readonly sampled: boolean,
    readonly exclusions: string[]
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Connection check results" });
    this.contentEl.createEl("p", {
      text: this.target,
    });
    this.contentEl.createEl("p", {
      text: `${this.localCount} eligible local file(s); ${this.remoteCount} eligible remote file(s). Encryption: ${this.encryption}.`,
    });
    this.contentEl.createEl("p", {
      text: this.sampled
        ? "One remote sample was read and decrypted. A full preview validates the remaining files."
        : "No eligible remote sample was available. The password and remote content could not be confirmed by a sample read.",
    });
    this.contentEl.createEl("p", {
      text: "No uploads or note changes were made. Write permissions and provider enforcement of conditional writes still require a disposable trial. OAuth refresh may have saved updated credentials.",
    });
    showExcluded(this.contentEl, this.exclusions);
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Close").onClick(() => this.close())
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}
class MergedModal extends Modal {
  constructor(
    readonly plugin: PersonalSync,
    readonly change: Change
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", {
      text: `Merged result: ${this.change.path}`,
    });
    const text = mergedMarkdown(this.change);
    if (!text)
      this.contentEl.createEl("p", {
        text: "Inline merge preview is limited to UTF-8 Markdown with 128 KiB combined and 2,000 lines across the three versions. Deselect this file if you need to inspect it outside the app before applying.",
      });
    else
      for (const [label, value] of [
        ["Local version", text.local],
        ["Remote version", text.remote],
        ["Proposed merged result", text.result],
      ]) {
        this.contentEl.createEl("h3", { text: label });
        this.contentEl.createEl("pre", {
          cls: "personal-sync-diff",
          text: value,
          attr: { "aria-label": label },
        });
        this.contentEl.createEl("p", {
          text: value.endsWith("\n")
            ? "Ends with a newline."
            : "No final newline.",
        });
      }
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Close merge preview").onClick(() => this.close())
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}
class ReportsModal extends Modal {
  constructor(readonly plugin: PersonalSync) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "VaultBridge sync results" });
    this.contentEl.createEl("p", {
      text: "Last 20 Apply attempts on this device. A failed or cancelled write may have completed. Counts reflect verified files and preserved conflicts; confirm current files using a fresh preview.",
    });
    const reports = structuredClone(this.plugin.state.reports ?? []);
    if (!reports.length)
      this.contentEl.createEl("p", { text: "No Apply attempts recorded yet." });
    for (const report of reports) {
      const details = this.contentEl.createEl("details");
      details.createEl("summary", {
        text: `${new Date(report.startedAt).toLocaleString()}: ${report.provider} — ${report.status}`,
      });
      details.createEl("p", {
        text: `${report.selected} selected · ${report.skipped} skipped · ${report.verified} verified · ${report.preserved} conflicts preserved. Upload: ${report.counts.upload}, download: ${report.counts.download}, merge: ${report.counts.merge}, conflict: ${report.counts.conflict}, equal: ${report.counts.equal}. Duration: ${Math.max(0, report.endedAt - report.startedAt)} ms.`,
      });
      new Setting(details).addButton((b) =>
        b
          .setButtonText(`Browse backups: ${report.id}`)
          .setDisabled(this.plugin.busy)
          .onClick(() => {
            this.close();
            void this.plugin.browseBackups(report.id);
          })
      );
    }
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Export redacted diagnostics")
        .setDisabled(this.plugin.busy)
        .onClick(async () => {
          if (this.plugin.busy) return;
          b.setDisabled(true);
          try {
            const path = await this.plugin.exportDiagnostics(reports);
            this.contentEl.createEl("p", {
              text: `Exported to ${path}. This hidden folder is excluded from sync. The report includes timestamps, statuses and counts; no credentials, targets, filenames or note contents.`,
            });
          } catch {
            this.plugin.notice(
              "Diagnostics could not be exported. Check local vault storage access.",
              12000
            );
          } finally {
            b.setDisabled(false);
          }
        })
    );
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Close results").onClick(() => this.close())
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}
class PersonalSettings extends PluginSettingTab {
  constructor(readonly plugin: PersonalSync) {
    super(plugin.app, plugin);
  }
  display() {
    const el = this.containerEl;
    el.empty();
    const s = this.plugin.state.settings;
    el.createEl("h2", { text: "VaultBridge" });
    el.createEl("p", {
      text: "Manual sync for S3, Google Drive and Dropbox. Disable other sync plugins for this vault. Settings contain credentials; keep this plugin folder private.",
    });
    new Setting(el)
      .setName("Local backups")
      .setDesc(
        "Browse, restore or review retention cleanup. No cloud requests."
      )
      .addButton((b) =>
        b
          .setButtonText("Browse backups")
          .setDisabled(this.plugin.busy)
          .onClick(() => {
            void this.plugin.browseBackups();
          })
      );
    for (const journal of Object.values(this.plugin.state.journals ?? {})) {
      const details = el.createEl("details");
      details.createEl("summary", {
        text: `Interrupted sync ${new Date(journal.startedAt).toLocaleString()}: ${journal.files.length} affected file(s)`,
      });
      details.createEl("p", {
        text: "A pending write may have completed. Inspect backups and create a fresh preview for this target; saved operations are never replayed automatically.",
      });
      for (const file of journal.files)
        details.createEl("p", { text: `${file.phase}: ${file.path}` });
    }
    if (this.plugin.loadBlocked) {
      el.createEl("p", { text: this.plugin.loadBlocked });
      return;
    }
    if (this.plugin.recoveryNeeded) {
      el.createEl("p", {
        text: "Some saved fields were missing or invalid. Valid credentials were retained and invalid fields use defaults. Copy data.json before accepting recovery. Review the recovered provider and encryption below; accepting replaces the saved settings.",
      });
      el.createEl("p", {
        text: `Recovered provider: ${s.provider}; encryption: ${s.encryption}.`,
      });
      el.createEl("p", {
        text:
          s.provider === "s3"
            ? `Recovered S3 target: ${s.s3.s3Endpoint || "AWS default endpoint"}; region: ${s.s3.s3Region || "unset"}; bucket: ${s.s3.s3BucketName || "unset"}; prefix: ${s.s3.remotePrefix || "bucket root"}.`
            : `Recovered vault folder: ${s[s.provider].root || "unset"}.`,
      });
      new Setting(el).addButton((b) =>
        b.setButtonText("Use recovered settings").onClick(async () => {
          this.plugin.recoveryNeeded = false;
          try {
            await this.plugin.persist();
            this.display();
          } catch {
            this.plugin.recoveryNeeded = true;
            this.plugin.notice(
              "Recovered settings could not be saved. Original saved settings were not intentionally replaced."
            );
          }
        })
      );
      return;
    }
    if (this.plugin.busy) {
      el.createEl("p", {
        text: "Close or finish the current preview before changing settings.",
      });
      return;
    }
    el.createEl("h3", { text: "Setup checklist" });
    el.createEl("p", {
      text: "1. Choose your service and a dedicated remote target. 2. Match its encryption and authorize your own app. 3. Check connection and exclusions. 4. Preview, select files and Apply.",
    });
    const issues = setupIssues(s);
    for (const issue of issues) el.createEl("p", { text: issue });
    if (!issues.length)
      el.createEl("p", {
        text: "Required setup fields are complete. Check connection to verify listing and a bounded remote content sample.",
      });
    new Setting(el)
      .setName("Connection and exclusions")
      .setDesc(
        "Lists files and reads one eligible remote sample; no uploads or note changes. OAuth token refresh can save updated credentials. Does not prove write permissions or validate every file."
      )
      .addButton((b) =>
        b.setButtonText("Check connection").onClick(() => {
          void this.plugin.start(true);
        })
      );
    new Setting(el)
      .setName("Exclude paths and patterns")
      .setDesc(
        "One case-sensitive rule per line: Archive/, **/cache/, *.pdf or attachments/**. # starts a comment. Rules apply to both sides; excluded files are untouched."
      )
      .addTextArea((t) =>
        t.setValue(s.exclusions).onChange(async (value) => {
          if (this.plugin.busy) return;
          try {
            compileExclusions(value);
            s.exclusions = value;
            await this.plugin.persist();
          } catch (error) {
            this.plugin.notice(publicError(error), 12000);
          }
        })
      );
    new Setting(el)
      .setName("Sync results")
      .setDesc(
        "Last 20 Apply attempts, stored locally. Export omits credentials, targets, filenames and note contents."
      )
      .addButton((b) =>
        b
          .setButtonText("View sync results")
          .onClick(() => new ReportsModal(this.plugin).open())
      );
    new Setting(el).setName("Cloud service").addDropdown((d) =>
      d
        .addOptions({
          s3: "S3",
          dropbox: "Dropbox",
          google: "Google Drive",
        })
        .setValue(s.provider)
        .onChange(async (v) => {
          if (this.plugin.busy) return;
          s.provider = v as Provider;
          this.plugin.sessionPassword = "";
          await this.plugin.persist();
          this.display();
        })
    );
    if (!supportedProvider(s.provider)) {
      el.createEl("p", {
        text: "This saved cloud service is no longer supported. Choose S3, Google Drive or Dropbox above before syncing.",
      });
      return;
    }
    new Setting(el)
      .setName("Existing remote encryption")
      .setDesc(
        "Match the format already used on your remote. Do not change this to migrate existing files."
      )
      .addDropdown((d) =>
        d
          .addOptions({
            unset: "Choose explicitly…",
            none: "Unencrypted",
            "openssl-base64": "OpenSSL (legacy compatible)",
            "rclone-base64": "rclone (legacy compatible)",
          })
          .setValue(s.encryption)
          .onChange(async (v) => {
            if (this.plugin.busy) return;
            s.encryption = v as Settings["encryption"];
            this.plugin.sessionPassword = "";
            await this.plugin.persist();
            this.display();
          })
      );
    if (s.encryption !== "none" && s.encryption !== "unset") {
      new Setting(el)
        .setName("Encryption password")
        .setDesc(
          "Requested when you preview; held in memory for this session only."
        )
        .addButton((b) =>
          b
            .setButtonText("Lock encryption")
            .setDisabled(!this.plugin.sessionPassword)
            .onClick(() => {
              if (this.plugin.busy) return;
              this.plugin.sessionPassword = "";
              new Notice(
                "Encryption locked. The next preview will request your password."
              );
              this.display();
            })
        );
    }
    if (s.provider === "s3") {
      for (const [name, key, secret] of [
        ["Endpoint (HTTPS; blank for AWS)", "s3Endpoint", false],
        ["Region", "s3Region", false],
        ["Bucket", "s3BucketName", false],
        ["Existing remote prefix", "remotePrefix", false],
        ["Access key ID", "s3AccessKeyID", true],
        ["Secret access key", "s3SecretAccessKey", true],
      ] as const)
        this.field(
          name,
          s.s3[key] ?? "",
          (v) => {
            s.s3[key] = v;
          },
          secret
        );
      new Setting(el).setName("Path-style S3 URLs").addToggle((t) =>
        t.setValue(s.s3.forcePathStyle ?? false).onChange(async (v) => {
          if (this.plugin.busy) return;
          s.s3.forcePathStyle = v;
          await this.plugin.persist();
        })
      );
    } else {
      const provider = s.provider,
        c = s[provider];
      this.field(
        provider === "dropbox"
          ? "Vault folder path inside app/account root"
          : "Dedicated vault folder ID",
        c.root,
        (v) => {
          c.root = v;
        }
      );
      this.field("Your OAuth client ID", c.clientId, (v) => {
        c.clientId = v;
      });
      this.field(
        "Your OAuth client secret",
        c.clientSecret,
        (v) => {
          c.clientSecret = v;
        },
        true
      );
      el.createEl("p", {
        text: "Use an OAuth app you own. Authorize on desktop, or use a registered HTTPS redirect you control. Google desktop loopback authorization is not supported on mobile. Tokens can be entered locally below.",
      });
      let redirect = provider === "google" ? "http://127.0.0.1:42813/" : "";
      new Setting(el).setName("Registered OAuth redirect URI").addText((t) =>
        t.setValue(redirect).onChange((v) => {
          redirect = v;
        })
      );
      new Setting(el).setName("Authorize your app").addButton((b) =>
        b.setButtonText("Open authorization").onClick(async () => {
          if (this.plugin.busy) return;
          try {
            const pending = await authorize(provider, c.clientId, redirect);
            new OAuthModal(this.plugin, provider, c, pending).open();
            window.open(pending.url);
          } catch {
            new Notice("Check your app client ID and registered redirect URI.");
          }
        })
      );
      this.field(
        "Access token",
        c.accessToken,
        (v) => {
          c.accessToken = v;
          c.expiresAt = 0;
        },
        true
      );
      this.field(
        "Refresh token",
        c.refreshToken,
        (v) => {
          c.refreshToken = v;
          c.expiresAt = 0;
        },
        true
      );
    }
    new Setting(el)
      .setName("Preview manual sync")
      .setDesc("Reads files without uploading or changing vault notes.")
      .addButton((b) =>
        b
          .setButtonText("Preview")
          .setCta()
          .onClick(() => {
            void this.plugin.start();
          })
      );
  }
  private field(
    name: string,
    value: string,
    update: (v: string) => void,
    secret = false
  ) {
    new Setting(this.containerEl).setName(name).addText((t) => {
      t.setValue(value);
      if (secret) t.inputEl.type = "password";
      t.onChange(async (v) => {
        if (this.plugin.busy) return;
        update(v);
        await this.plugin.persist();
      });
    });
  }
}
class BackupModal extends Modal {
  private working = false;
  private closed = false;
  constructor(
    readonly plugin: PersonalSync,
    readonly backups: Backup[],
    readonly run: SyncRun,
    readonly release: () => void
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.browse();
  }
  onClose() {
    this.closed = true;
    this.run.cancel();
    if (!this.working) this.release();
  }
  private async task(operation: () => Promise<void>) {
    if (this.working || this.closed) return;
    this.working = true;
    try {
      await operation();
    } catch (error) {
      this.plugin.notice(
        error instanceof PersonalSyncError
          ? error.message
          : "Backup operation failed. Existing copies were retained; review again.",
        12000
      );
    } finally {
      this.working = false;
      if (this.closed) this.release();
    }
  }
  private browse() {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "VaultBridge backups" });
    this.contentEl.createEl("p", {
      text: "Restore changes the local file only. Its current version is backed up first. Preview sync afterward to review any cloud changes.",
    });
    let query = "",
      limit = 100;
    let list: HTMLElement;
    const render = () => {
      list.empty();
      const matches = this.backups.filter((b) =>
        b.path.toLowerCase().includes(query.toLowerCase())
      );
      list.createEl("p", {
        text: `${matches.length} backup file(s); showing up to ${limit}.`,
      });
      for (const backup of matches.slice(0, limit)) {
        new Setting(list)
          .setName(backup.path)
          .setDesc(
            `${new Date(backup.created).toLocaleString()} · ${backup.side} · ${backup.size} bytes`
          )
          .addButton((b) =>
            b.setButtonText("Review restore").onClick(() =>
              this.task(async () => {
                const plan = await prepareRestore(this.app.vault, backup, () =>
                  this.run.check()
                );
                this.run.check();
                this.contentEl.empty();
                this.contentEl.createEl("h2", {
                  text: `Restore ${backup.path}`,
                });
                this.contentEl.createEl("p", {
                  text: `Source: ${backup.source}. ${plan.currentHash === undefined ? "Creates a missing local file." : "Replaces the local file after saving a verified undo backup."}`,
                });
                const text =
                  backup.path.toLowerCase().endsWith(".md") &&
                  plan.bytes.byteLength <= 64 * 1024
                    ? textOf(plan.bytes)
                    : undefined;
                if (text !== undefined)
                  this.contentEl.createEl("pre", {
                    cls: "personal-sync-diff",
                    text,
                  });
                new Setting(this.contentEl)
                  .addButton((button) =>
                    button.setButtonText("Back").onClick(() => {
                      if (!this.working) this.browse();
                    })
                  )
                  .addButton((button) =>
                    button
                      .setButtonText("Restore reviewed file")
                      .setCta()
                      .onClick(() =>
                        this.task(async () => {
                          await restoreBackup(
                            this.app.vault,
                            plan,
                            `${Date.now()}-${crypto.randomUUID()}`,
                            () => this.run.check()
                          );
                          this.run.check();
                          this.plugin.notice(
                            "Local file restored and verified. Preview sync to review cloud changes.",
                            12000
                          );
                          this.close();
                        })
                      )
                  );
              })
            )
          );
      }
      if (matches.length > limit)
        new Setting(list).addButton((b) =>
          b.setButtonText("Show next 100").onClick(() => {
            limit += 100;
            render();
          })
        );
    };
    new Setting(this.contentEl).setName("Find backups").addText((t) =>
      t.onChange((v) => {
        query = v;
        limit = 100;
        render();
      })
    );
    list = this.contentEl.createEl("div", { cls: "personal-sync-preview" });
    render();
    let keep = "10";
    new Setting(this.contentEl)
      .setName("Keep newest backup runs")
      .setDesc(
        "Optional manual cleanup. Reviewed older files move to .trash; nothing is removed automatically."
      )
      .addText((t) =>
        t.setValue(keep).onChange((v) => {
          keep = v;
        })
      )
      .addButton((b) =>
        b.setButtonText("Review cleanup").onClick(() =>
          this.task(async () => {
            const plan = await prepareCleanup(
              this.app.vault,
              Number(keep),
              () => this.run.check()
            );
            this.run.check();
            this.contentEl.empty();
            this.contentEl.createEl("h2", { text: "Review backup cleanup" });
            this.contentEl.createEl("p", {
              text: `Keep the newest ${Number(keep)} runs. Move ${plan.files.length} older file(s) (${plan.files.reduce((sum, f) => sum + f.backup.size, 0)} bytes) to the vault's .trash folder. Empty backup directories may remain.`,
            });
            const files = this.contentEl.createEl("div", {
              cls: "personal-sync-preview",
            });
            for (const file of plan.files)
              files.createEl("p", { text: file.backup.source });
            new Setting(this.contentEl)
              .addButton((button) =>
                button.setButtonText("Back").onClick(() => {
                  if (!this.working) this.browse();
                })
              )
              .addButton((button) =>
                button
                  .setButtonText("Move reviewed backups to trash")
                  .setDisabled(plan.files.length === 0)
                  .onClick(() =>
                    this.task(async () => {
                      await cleanupBackups(this.app.vault, plan, () =>
                        this.run.check()
                      );
                      this.run.check();
                      this.plugin.notice("Reviewed backups moved to .trash.");
                      this.close();
                    })
                  )
              );
          })
        )
      );
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Close").onClick(() => this.close())
    );
  }
}
class OAuthModal extends Modal {
  private consumed = false;
  constructor(
    readonly plugin: PersonalSync,
    readonly provider: "google" | "dropbox",
    readonly credentials: Credentials,
    readonly pending: Awaited<ReturnType<typeof authorize>>
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", {
      text: "Complete your cloud authorization",
    });
    this.contentEl.createEl("p", {
      text: "After granting access, copy the full redirect URL from your browser address bar. A desktop loopback page may fail to load because this plugin does not start a server. Paste the URL here; keep it private.",
    });
    let callback = "";
    new Setting(this.contentEl).setName("Full callback URL").addTextArea((t) =>
      t.onChange((v) => {
        callback = v;
      })
    );
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Finish authorization")
        .setCta()
        .onClick(async () => {
          if (this.consumed || this.plugin.busy) return;
          b.setDisabled(true);
          this.plugin.busy = true;
          const previous = { ...this.credentials };
          try {
            const candidate = { ...previous };
            await complete(
              this.provider,
              candidate,
              this.pending,
              callback,
              transport
            );
            this.consumed = true;
            await persistAuthorization(this.credentials, candidate, () =>
              this.plugin.persist()
            );
            new Notice(
              "Your cloud app is authorized. Select its vault folder before previewing."
            );
            this.close();
          } catch {
            new Notice(
              "Authorization failed. Check your own app settings and callback URL; start a new authorization if the code was already used."
            );
            b.setDisabled(false);
          } finally {
            this.plugin.busy = false;
          }
        })
    );
  }
}
