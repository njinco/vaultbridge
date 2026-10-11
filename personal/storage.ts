// SPDX-License-Identifier: Apache-2.0
import { PersonalSyncError } from "./errors";
import type { Vault } from "obsidian";
import type { Entity, S3Config } from "../src/baseTypes";
import { FakeFs } from "../src/fsAll";
import { FakeFsEncrypt } from "../src/fsEncrypt";
import { FakeFsS3 } from "../src/fsS3";
import {
  CloudSession,
  type Credentials,
  DropboxStore,
  GoogleStore,
  type Provider,
  type Transport,
  supportedProvider,
} from "./cloud";
import { type Entry, type Store, included, validatePath } from "./engine";

export type Encryption = "unset" | "none" | "openssl-base64" | "rclone-base64";
export interface Settings {
  provider: Provider;
  encryption: Encryption;
  password: string;
  s3: S3Config;
  dropbox: Credentials;
  google: Credentials;
}
const credentials = (): Credentials => ({
  clientId: "",
  clientSecret: "",
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  root: "",
});
export const defaults = (): Settings => ({
  provider: "s3",
  encryption: "unset",
  password: "",
  s3: {
    s3Endpoint: "",
    s3Region: "",
    s3AccessKeyID: "",
    s3SecretAccessKey: "",
    s3BucketName: "",
    remotePrefix: "",
    forcePathStyle: false,
    partsConcurrency: 4,
    useAccurateMTime: false,
    reverseProxyNoSignUrl: "",
    generateFolderObject: false,
    bypassCorsLocally: true,
  },
  dropbox: credentials(),
  google: credentials(),
});
export class VaultStore implements Store {
  constructor(readonly vault: Vault, readonly checkRun: () => void = () => {}) {}
  async list(): Promise<Entry[]> {
    const result: Entry[] = [],
      folders = [""];
    for (let n = 0; n < folders.length; n++) {
      this.checkRun();
      const page = await this.vault.adapter.list(folders[n]);
      this.checkRun();
      for (const folder of page.folders) {
        if (
          included(folder) &&
          folder !== this.vault.configDir &&
          !folder.startsWith(`${this.vault.configDir}/`)
        )
          folders.push(folder);
      }
      for (const path of page.files) {
        this.checkRun();
        if (
          included(path) &&
          path !== this.vault.configDir &&
          !path.startsWith(`${this.vault.configDir}/`)
        ) {
          const stat = await this.vault.adapter.stat(path);
          if (!stat || stat.type !== "file")
            throw new PersonalSyncError(
              "Vault changed during listing. Preview again."
            );
          result.push({ path, size: stat.size });
        }
      }
    }
    return result;
  }
  private check(path: string) {
    validatePath(path);
    if (
      !included(path) ||
      path === this.vault.configDir ||
      path.startsWith(`${this.vault.configDir}/`)
    )
      throw new PersonalSyncError(
        "Plugin and vault configuration files are excluded."
      );
  }
  async read(path: string): Promise<ArrayBuffer> {
    this.check(path);
    return this.vault.adapter.readBinary(path);
  }
  async write(path: string, bytes: ArrayBuffer): Promise<void> {
    this.check(path);
    await ensureParents(this.vault, path, this.checkRun);
    this.checkRun();
    await this.vault.adapter.writeBinary(path, bytes);
  }
}
export async function ensureParents(vault: Vault, path: string, check: () => void = () => {}) {
  const parts = path.split("/");
  parts.pop();
  for (let i = 1; i <= parts.length; i++) {
    check();
    const folder = parts.slice(0, i).join("/");
    const exists = await vault.adapter.exists(folder);
    check();
    if (!exists)
      await vault.adapter.mkdir(folder);
    else if ((await vault.adapter.stat(folder))?.type !== "folder")
      throw new PersonalSyncError("File blocks a required folder.");
  }
}
// Adapt the Apache encryption wrapper to the independent provider interface.
// Destructive methods are intentionally unavailable to the personal engine.
class StoreFs extends FakeFs {
  kind = "personal-cloud";
  private inventory: Entity[] = [];
  constructor(readonly store: Store) {
    super();
  }
  async walk(): Promise<Entity[]> {
    this.inventory = (await this.store.list()).map((e) => ({
      key: e.path,
      keyRaw: e.path,
      size: e.size,
      sizeRaw: e.size ?? 0,
    }));
    return this.inventory;
  }
  async walkPartial(): Promise<Entity[]> {
    return this.walk();
  }
  async stat(key: string): Promise<Entity> {
    const found = this.inventory.find((x) => x.key === key);
    if (!found) throw new PersonalSyncError("Missing cloud file.");
    return found;
  }
  async mkdir(key: string): Promise<Entity> {
    return { key, keyRaw: key, size: 0, sizeRaw: 0 };
  }
  async writeFile(key: string, bytes: ArrayBuffer): Promise<Entity> {
    await this.store.write(key, bytes);
    return {
      key,
      keyRaw: key,
      size: bytes.byteLength,
      sizeRaw: bytes.byteLength,
    };
  }
  async readFile(key: string): Promise<ArrayBuffer> {
    return this.store.read(key);
  }
  async rename(): Promise<void> {
    throw new PersonalSyncError("Rename is disabled.");
  }
  async rm(): Promise<void> {
    throw new PersonalSyncError("Deletion is disabled.");
  }
  async checkConnect(): Promise<boolean> {
    await this.walk();
    return true;
  }
  async getUserDisplayName(): Promise<string> {
    return "Personal cloud account";
  }
  async revokeAuth(): Promise<void> {
    throw new PersonalSyncError("Revoke access in your provider account.");
  }
  allowEmptyFile(): boolean {
    return true;
  }
}
export async function openRemote(
  settings: Settings,
  transport: Transport,
  persist: () => Promise<void>,
  checkRun: () => void = () => {}
): Promise<Store & { close(): Promise<void> }> {
  checkRun();
  if (!supportedProvider(settings.provider))
    throw new PersonalSyncError("Choose S3, Google Drive or Dropbox in settings.");
  if (settings.encryption === "unset")
    throw new PersonalSyncError(
      "Select the encryption format of your existing remote before previewing."
    );
  if (settings.encryption !== "none" && !settings.password)
    throw new PersonalSyncError(
      "Enter your existing encryption password locally."
    );
  let inner: FakeFs;
  if (settings.provider === "s3") {
    const s = settings.s3;
    if (
      !s.s3BucketName ||
      !s.s3Region ||
      !s.s3AccessKeyID ||
      !s.s3SecretAccessKey
    )
      throw new PersonalSyncError("Complete S3 settings first.");
    if (!/^[a-z0-9-]+$/.test(s.s3Region))
      throw new PersonalSyncError("Invalid S3 region.");
    if (!s.s3Endpoint) s.s3Endpoint = `https://s3.${s.s3Region}.amazonaws.com`;
    const endpoint = new URL(s.s3Endpoint);
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new PersonalSyncError(
        "S3 endpoint must use HTTPS without embedded credentials."
      );
    if (s.reverseProxyNoSignUrl)
      throw new PersonalSyncError(
        "Unsigned reverse proxies are not supported by VaultBridge."
      );
    inner = new FakeFsS3(s, checkRun);
  } else {
    const session = new CloudSession(
      settings.provider,
      settings[settings.provider],
      transport,
      persist
    );
    inner = new StoreFs(
      settings.provider === "google"
        ? new GoogleStore(session)
        : new DropboxStore(session)
    );
  }
  const cipher = new FakeFsEncrypt(
    inner,
    settings.encryption === "none" ? "" : settings.password,
    settings.encryption === "none" ? "openssl-base64" : settings.encryption
  );
  return {
    async list() {
      if (settings.encryption === "none" && !(await cipher.isPasswordOk()).ok)
        throw new PersonalSyncError(
          "Remote uses encryption. Match your existing encryption settings first."
        );
      // A full successful decrypt is required before a plan can be applied.
      const entries = await cipher.walk();
      return entries
        .filter((x) => !x.key!.endsWith("/"))
        .map((x) => ({ path: x.key!, size: x.size }));
    },
    async read(path) {
      return cipher.readFile(path);
    },
    async write(path, bytes) {
      const now = Date.now();
      await cipher.writeFile(path, bytes, now, now);
    },
    async close() {
      await cipher.closeResources();
    },
  };
}
