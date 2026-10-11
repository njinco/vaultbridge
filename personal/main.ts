// SPDX-License-Identifier: Apache-2.0
import {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";
import { supportedProvider, type Credentials, type Provider, type Transport } from "./cloud";
import {
  apply,
  digest,
  included,
  preview,
  type History,
  type Plan,
  type Store,
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

const transport: Transport = async (r) => {
  // Obsidian's native HTTP API avoids browser CORS on both desktop and mobile.
  const response = await requestUrl({ ...r, throw: false });
  return {
    status: response.status,
    headers: response.headers,
    body: response.arrayBuffer,
  };
};
interface Saved {
  settings: Settings;
  histories: Record<string, History>;
}

export default class PersonalSync extends Plugin {
  state: Saved = { settings: defaults(), histories: {} };
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
    const saved = (await this.loadData()) as Saved | null;
    if (saved?.settings) this.state = saved;
    // Upgrade the preliminary build without leaving a password on disk. Keep
    // its existing password in this session only, then scrub the saved setting.
    if (this.state.settings.password) {
      this.sessionPassword = this.state.settings.password;
      this.state.settings.password = "";
      await this.persist();
    }
    this.addSettingTab(new PersonalSettings(this));
    this.addCommand({
      id: "preview-sync",
      name: "Preview VaultBridge sync",
      callback: () => {
        void this.start();
      },
    });
    this.addRibbonIcon("refresh-cw", "Preview VaultBridge sync", () => {
      void this.start();
    });
    // No cloud requests, automatic sync, URI handlers or listeners at load time.
  }
  async persist() {
    await this.saveData({
      ...this.state,
      settings: { ...this.state.settings, password: "" },
    });
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
  async start() {
    if (this.unloaded) return;
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
      try { await remote?.close(); }
      finally {
        this.activeModal = undefined;
        this.connection = undefined;
        this.run = undefined;
        this.busy = false;
      }
    };
    try {
      const config = structuredClone(this.state.settings);
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
      this.activeModal = new ProgressModal(this, () => run.cancel());
      this.activeModal.open();
      remote = await openRemote(config, (request) => run.step(() => transport(request)), async () => {
        run.check();
        if (config.provider !== "s3")
          this.state.settings[config.provider] = config[config.provider];
        await run.step(() => this.persist());
      }, () => run.check());
      this.connection = remote;
      run.check();
      const local = run.store(new VaultStore(this.app.vault, () => run.check()));
      const configDir = this.app.vault.configDir;
      const permitted = (path: string) =>
        included(path) &&
        path !== configDir &&
        !path.startsWith(`${configDir}/`);
      const cloud = remote;
      const protectedRemote: Store = run.store({
        list: async () => (await cloud.list()).filter((x) => permitted(x.path)),
        read: async (path) => {
          if (!permitted(path)) throw new Error("Excluded path.");
          return cloud.read(path);
        },
        write: async (path, bytes) => {
          if (!permitted(path)) throw new Error("Excluded path.");
          await cloud.write(path, bytes);
        },
      });
      // Namespace history by target, credential identity and encryption. Refreshes
      // do not reset it; selecting another account/folder/password does.
      const identity =
        config.provider === "s3"
          ? [
              config.s3.s3Endpoint,
              config.s3.s3Region,
              config.s3.s3BucketName,
              config.s3.remotePrefix,
              config.s3.s3AccessKeyID,
            ]
          : [
              config[config.provider].clientId,
              config[config.provider].root,
              config[config.provider].refreshToken,
            ];
      const namespace = await digest(
        new TextEncoder().encode(
          JSON.stringify([
            config.provider,
            identity,
            config.encryption,
            config.password,
          ])
        ).buffer
      );
      const history =
        this.state.histories[namespace] ?? (Object.create(null) as History);
      new Notice("Reading local and remote files for preview…");
      const plan = await preview(local, protectedRemote, history);
      run.check();
      // Replace the progress dialog without treating this transition as Cancel.
      (this.activeModal as ProgressModal).finish();
      this.activeModal = new PreviewModal(
        this,
        plan,
        async () => {
          const runId = `${Date.now()}-${crypto.randomUUID()}`;
          const base = `_personal_sync_backups/${runId}`;
          const conflicts = await apply(plan, local, protectedRemote, history, {
            backup: async (path, side, bytes) => {
              run.check();
              const target = `${base}/${side}/${path}`;
              await ensureParents(this.app.vault, target, () => run.check());
              await run.step(() => this.app.vault.adapter.writeBinary(target, bytes));
            },
            checkpoint: async (h) => {
              run.check();
              this.state.histories[namespace] = h;
              await run.step(() => this.persist());
            },
          });
          run.check();
          this.notice(
            conflicts
              ? `Sync applied. ${conflicts} conflict(s) preserved; originals unchanged. Backups: ${base}`
              : "VaultBridge sync applied and verified.",
            12000
          );
        },
        release,
        () => run.cancel()
      );
      this.activeModal.open();
    } catch (error) {
      this.activeModal?.close();
      await release();
      // A mistaken passphrase must not leave the user stuck with repeated
      // failures. Ask again next time; never expose the provider's raw error.
      this.sessionPassword = "";
      // Provider exceptions can include signed URLs or secrets. Never log them.
      if (!this.unloaded) new Notice(
        `Preview stopped: ${publicError(error)} No sync writes were attempted.`,
        12000
      );
    }
  }
}
class ProgressModal extends Modal {
  private completed = false;
  constructor(readonly plugin: PersonalSync, readonly cancel: () => void) { super(plugin.app); }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Preparing VaultBridge preview" });
    this.contentEl.createEl("p", { text: "Reading files. Cancel stops further work after the current operation settles." });
    new Setting(this.contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
  }
  finish() { this.completed = true; this.close(); }
  onClose() { if (!this.completed) this.cancel(); this.contentEl.empty(); }
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
  constructor(
    readonly plugin: PersonalSync,
    readonly plan: Plan,
    readonly perform: () => Promise<void>,
    readonly release: () => Promise<void>,
    readonly cancel: () => void
  ) {
    super(plugin.app);
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Review VaultBridge sync" });
    this.contentEl.createEl("p", {
      text: "Files are read for this preview. Apply copies changes and backs up overwritten/conflicting content. Missing files are restored; deletions are not propagated.",
    });
    const counts = this.plan.changes.reduce<Record<string, number>>((a, c) => {
      a[c.action] = (a[c.action] ?? 0) + 1;
      return a;
    }, {});
    this.contentEl.createEl("p", {
      text:
        Object.entries(counts)
          .map(([k, v]) => `${k}: ${v}`)
          .join(" · ") || "No files to sync.",
    });
    const list = this.contentEl.createEl("div", {
      cls: "personal-sync-preview",
    });
    for (const c of this.plan.changes.filter((x) => x.action !== "equal")) {
      if (c.action !== "conflict") {
        list.createEl("p", { text: `${c.action}: ${c.path}` });
        continue;
      }
      new Setting(list)
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
            })
        );
    }
    new Setting(this.contentEl)
      .addButton((b) =>
        b.setButtonText("Cancel").onClick(() => {
          this.close();
        })
      )
      .addButton((b) =>
        b
          .setButtonText("Apply reviewed plan")
          .setCta()
          .onClick(async () => {
            if (this.applying || this.finished) return;
            this.applying = true;
            b.setDisabled(true);
            try {
              await this.perform();
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
          })
      );
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
    if (this.plugin.busy) {
      el.createEl("p", {
        text: "Close or finish the current preview before changing settings.",
      });
      return;
    }
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
            await persistAuthorization(this.credentials, candidate, () => this.plugin.persist());
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
