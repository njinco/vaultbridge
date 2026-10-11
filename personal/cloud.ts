// SPDX-License-Identifier: Apache-2.0
import { PersonalSyncError } from "./errors";
import { tokenResponse } from "./tokens";
// Implemented from public provider API contracts, independently of pro/.
import { type Entry, type Store, validatePath } from "./engine";

export type Provider = "s3" | "dropbox" | "google";
export function supportedProvider(value: unknown): value is Provider {
  return value === "s3" || value === "dropbox" || value === "google";
}
export interface Credentials {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  root: string;
}
export interface Response {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}
export interface Request {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}
export type Transport = (r: Request) => Promise<Response>;
const utf8 = new TextEncoder();
function json<T>(r: Response): T {
  if (r.status < 200 || r.status >= 300)
    throw new PersonalSyncError(`Cloud request failed (HTTP ${r.status}).`);
  try {
    return JSON.parse(new TextDecoder().decode(r.body)) as T;
  } catch {
    throw new PersonalSyncError("Invalid response from cloud service.");
  }
}
function accepted(r: Response) {
  if (r.status < 200 || r.status >= 300)
    throw new PersonalSyncError(`Cloud request failed (HTTP ${r.status}).`);
  return r;
}
const TOKEN_URL = {
  google: "https://oauth2.googleapis.com/token",
  dropbox: "https://api.dropboxapi.com/oauth2/token",
};
export class CloudSession {
  private pendingSave = false;
  private refreshing?: Promise<string>;
  constructor(
    readonly provider: Exclude<Provider, "s3">,
    readonly credentials: Credentials,
    readonly transport: Transport,
    readonly persist: () => Promise<void>
  ) {}
  async token(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const pending = this.obtainToken();
    this.refreshing = pending;
    try {
      return await pending;
    } finally {
      if (this.refreshing === pending) this.refreshing = undefined;
    }
  }
  private async obtainToken(): Promise<string> {
    const c = this.credentials;
    if (this.pendingSave) {
      await this.persist();
      this.pendingSave = false;
    }
    if (c.accessToken && c.expiresAt > Date.now() + 60000) return c.accessToken;
    if (!c.refreshToken || !c.clientId)
      throw new PersonalSyncError("Authorize your own cloud app first.");
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: c.refreshToken,
      client_id: c.clientId,
    });
    if (c.clientSecret) form.set("client_secret", c.clientSecret);
    const body = tokenResponse(
      await this.transport({
        url: TOKEN_URL[this.provider],
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      false
    );
    c.accessToken = body.accessToken;
    c.refreshToken = body.refreshToken ?? c.refreshToken;
    c.expiresAt = body.expiresAt;
    // Persist refreshed credentials before further requests.
    this.pendingSave = true;
    await this.persist();
    this.pendingSave = false;
    return c.accessToken;
  }
  async request(r: Request, allowedStatuses: readonly number[] = []): Promise<Response> {
    const u = new URL(r.url);
    const allowed =
      this.provider === "google"
        ? ["www.googleapis.com"]
        : ["api.dropboxapi.com", "content.dropboxapi.com"];
    if (
      u.protocol !== "https:" ||
      !allowed.includes(u.hostname) ||
      u.username ||
      u.password ||
      u.port
    )
      throw new PersonalSyncError(
        "Refusing to send credentials to an unexpected host."
      );
    const send = async () => this.transport({
        ...r,
        headers: {
          ...r.headers,
          Authorization: `Bearer ${await this.token()}`,
        },
      });
    let response = await send();
    // A definite 401 rejection can be retried once with refreshed credentials.
    // Never replay ambiguous network failures or generic write errors here.
    if (response.status === 401) {
      this.credentials.expiresAt = 0;
      response = await send();
    }
    return allowedStatuses.includes(response.status) ? response : accepted(response);
  }
  async api<T>(url: string, method = "GET", body?: unknown): Promise<T> {
    return json<T>(
      await this.request({
        url,
        method,
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  }
}
interface Item {
  id: string;
  name: string;
  folder: boolean;
  size?: number;
}
abstract class TreeStore implements Store {
  protected items = new Map<string, Item>();
  protected ready = false;
  constructor(readonly session: CloudSession) {}
  abstract children(id: string): Promise<Item[]>;
  abstract createFolder(parent: string, name: string): Promise<Item>;
  abstract read(path: string): Promise<ArrayBuffer>;
  abstract write(path: string, bytes: ArrayBuffer): Promise<void>;
  async list(): Promise<Entry[]> {
    this.ready = false;
    this.items.clear();
    const root = this.session.credentials.root;
    if (
      !root ||
      root === "0" ||
      root === "root" ||
      !/^[A-Za-z0-9_-]+$/.test(root)
    )
      throw new PersonalSyncError(
        "Choose a dedicated vault folder ID, not the account root."
      );
    const queue = [{ id: root, path: "" }];
    const seen = new Set<string>([root]);
    const result: Entry[] = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      if (cursor > 10000)
        throw new PersonalSyncError("Cloud folder tree is too large.");
      const folder = queue[cursor];
      for (const item of await this.children(folder.id)) {
        if (
          !item.id ||
          !/^[A-Za-z0-9_-]+$/.test(item.id) ||
          !item.name ||
          item.name.includes("/")
        )
          throw new PersonalSyncError("Invalid cloud item.");
        const path = folder.path + item.name;
        validatePath(path);
        if (this.items.has(path))
          throw new PersonalSyncError(
            "Duplicate cloud filenames; sync stopped."
          );
        this.items.set(path, item);
        if (item.folder) {
          if (seen.has(item.id))
            throw new PersonalSyncError("Cloud folder cycle; sync stopped.");
          seen.add(item.id);
          queue.push({ id: item.id, path: `${path}/` });
        } else result.push({ path, size: item.size });
      }
    }
    this.ready = true;
    return result;
  }
  protected file(path: string): Item {
    validatePath(path);
    const item = this.items.get(path);
    if (!this.ready || !item || item.folder)
      throw new PersonalSyncError(
        "File missing from complete cloud inventory."
      );
    return item;
  }
  protected async destination(
    path: string
  ): Promise<{ parent: string; name: string; existing?: Item }> {
    validatePath(path);
    if (!this.ready)
      throw new PersonalSyncError("Complete a cloud inventory before writing.");
    const parts = path.split("/");
    const name = parts.pop()!;
    let parent = this.session.credentials.root,
      prefix = "";
    for (const part of parts) {
      prefix += part;
      let folder = this.items.get(prefix);
      if (!folder) {
        folder = await this.createFolder(parent, part);
        this.items.set(prefix, folder);
      }
      if (!folder.folder)
        throw new PersonalSyncError("File blocks the destination folder.");
      parent = folder.id;
      prefix += "/";
    }
    const existing = this.items.get(path);
    if (existing?.folder)
      throw new PersonalSyncError("Folder blocks the destination file.");
    return { parent, name, existing };
  }
}
const DRIVE = "https://www.googleapis.com/drive/v3/files";
const FOLDER = "application/vnd.google-apps.folder";
interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  trashed?: boolean;
}
function driveItem(x: DriveFile): Item {
  if (!x || typeof x.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(x.id) ||
      typeof x.name !== "string" || !x.name || x.name.includes("/") ||
      typeof x.mimeType !== "string" || !x.mimeType ||
      (x.size !== undefined && (typeof x.size !== "string" || !/^\d+$/.test(x.size) ||
        !Number.isSafeInteger(Number(x.size)))))
    throw new PersonalSyncError("Invalid Google Drive file metadata.");
  if (
    x.mimeType?.startsWith("application/vnd.google-apps.") &&
    x.mimeType !== FOLDER
  )
    throw new PersonalSyncError(
      "Google-native documents/shortcuts are unsupported. Use a dedicated folder of vault files."
    );
  return {
    id: x.id,
    name: x.name,
    folder: x.mimeType === FOLDER,
    size: x.size === undefined ? undefined : Number(x.size),
  };
}
export class GoogleStore extends TreeStore {
  private uploaded(path: string, bytes: ArrayBuffer, response: Response, existing?: Item) {
    const item = driveItem(json<DriveFile>(response));
    if (item.folder || item.name !== path.split("/").pop() ||
        (existing && item.id !== existing.id) ||
        (item.size !== undefined && item.size !== bytes.byteLength))
      throw new PersonalSyncError("Google Drive upload metadata did not match the file. Preview again.");
    this.items.set(path, item);
  }
  private async uploadSession(location: string, bytes: ArrayBuffer): Promise<Response> {
    const total = bytes.byteLength;
    let offset = 0;
    // Recover only this session, with a strict request bound. Never restart a
    // possibly completed create: re-listing in a new preview avoids duplicates.
    const statuses = [308, 404, 500, 502, 503, 504];
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response | undefined;
      try {
        response = await this.session.request({
          url: location, method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(total - offset),
            "Content-Range": `bytes ${offset}-${total - 1}/${total}`,
          },
          body: bytes.slice(offset),
        }, statuses);
      } catch (error) {
        if (error instanceof PersonalSyncError) throw error;
        // A transport failure may follow a successful write. Query its status.
      }
      if (!response || response.status >= 500) {
        response = await this.session.request({
          url: location, method: "PUT",
          headers: { "Content-Length": "0", "Content-Range": `bytes */${total}` },
          body: new ArrayBuffer(0),
        }, statuses);
      }
      if (response.status === 200 || response.status === 201) return response;
      if (response.status === 404)
        throw new PersonalSyncError("Google Drive upload session expired. Preview again before retrying.");
      if (response.status !== 308)
        throw new PersonalSyncError("Google Drive upload was interrupted. Preview again before retrying.");
      const range = Object.entries(response.headers).find(([k]) => k.toLowerCase() === "range")?.[1];
      const match = range === undefined ? undefined : /^bytes=0-(\d+)$/.exec(range);
      const next = match ? Number(match[1]) + 1 : 0;
      if ((range !== undefined && !match) || !Number.isSafeInteger(next) ||
          next < offset || next >= total || (attempt > 0 && next === offset))
        throw new PersonalSyncError("Invalid or stalled Google Drive upload progress. Preview again.");
      offset = next;
    }
    throw new PersonalSyncError("Google Drive upload recovery limit reached. Preview again.");
  }
  async children(id: string): Promise<Item[]> {
    const result: Item[] = [],
      seen = new Set<string>();
    let page = "";
    do {
      const q = new URLSearchParams({
        q: `'${id}' in parents and trashed = false`,
        pageSize: "1000",
        fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,size)",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (page) q.set("pageToken", page);
      const r = await this.session.api<{
        files: DriveFile[];
        nextPageToken?: string;
        incompleteSearch?: boolean;
      }>(`${DRIVE}?${q}`);
      if (r.incompleteSearch || !Array.isArray(r.files))
        throw new PersonalSyncError(
          "Incomplete Google Drive listing; sync stopped."
        );
      result.push(...r.files.map(driveItem));
      page = r.nextPageToken ?? "";
      if (page && seen.has(page))
        throw new PersonalSyncError("Repeated Google Drive page token.");
      seen.add(page);
    } while (page);
    return result;
  }
  async createFolder(parent: string, name: string): Promise<Item> {
    return driveItem(
      await this.session.api<DriveFile>(
        `${DRIVE}?fields=id,name,mimeType&supportsAllDrives=true`,
        "POST",
        { name, parents: [parent], mimeType: FOLDER }
      )
    );
  }
  async read(path: string): Promise<ArrayBuffer> {
    return (
      await this.session.request({
        url: `${DRIVE}/${encodeURIComponent(this.file(path).id)}?alt=media&supportsAllDrives=true`,
      })
    ).body;
  }
  async write(path: string, bytes: ArrayBuffer): Promise<void> {
    const { parent, name, existing } = await this.destination(path);
    const suffix = existing ? `/${encodeURIComponent(existing.id)}` : "";
    if (bytes.byteLength > 5 * 1000 * 1000) {
      const metadata = existing
        ? { name, modifiedTime: new Date().toISOString() }
        : { name, parents: [parent], modifiedTime: new Date().toISOString() };
      const initiation = await this.session.request({
        url: `https://www.googleapis.com/upload/drive/v3/files${suffix}?uploadType=resumable&fields=id,name,mimeType,size&supportsAllDrives=true`,
        method: existing ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": "application/octet-stream",
          "X-Upload-Content-Length": String(bytes.byteLength),
        },
        body: JSON.stringify(metadata),
      });
      const location = Object.entries(initiation.headers).find(
        ([key]) => key.toLowerCase() === "location"
      )?.[1];
      if (!location)
        throw new PersonalSyncError(
          "Google Drive did not supply an upload session URL."
        );
      // CloudSession checks the session hostname before forwarding credentials.
      this.uploaded(path, bytes, await this.uploadSession(location, bytes), existing);
      return;
    }
    // Multipart upload, one request: no empty file is created before its content.
    const boundary = `personal-${crypto.randomUUID()}`;
    const metadata = existing
      ? { name, modifiedTime: new Date().toISOString() }
      : { name, parents: [parent], modifiedTime: new Date().toISOString() };
    const start = utf8.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const end = utf8.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(start.length + bytes.byteLength + end.length);
    body.set(start);
    body.set(new Uint8Array(bytes), start.length);
    body.set(end, start.length + bytes.byteLength);
    const response = await this.session.request({
        url: `https://www.googleapis.com/upload/drive/v3/files${suffix}?uploadType=multipart&fields=id,name,mimeType,size&supportsAllDrives=true`,
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: body.buffer,
      });
    this.uploaded(path, bytes, response, existing);
  }
}
interface DropboxItem {
  ".tag"?: string;
  id: string;
  path_display: string;
  path_lower?: string;
  name: string;
  rev?: string;
  size?: number;
  is_downloadable?: boolean;
  symlink_info?: unknown;
}
export class DropboxStore implements Store {
  private ready = false;
  private items = new Map<string, DropboxItem>();
  constructor(readonly session: CloudSession) {}
  private root(): string {
    const root = this.session.credentials.root
      .replace(/^\//, "")
      .replace(/\/$/, "");
    validatePath(root);
    return `/${root}`;
  }
  private path(path: string): string {
    validatePath(path);
    return `${this.root()}/${path}`;
  }
  private item(value: DropboxItem, file: boolean): string {
    const root = this.root();
    if (!value || typeof value.path_display !== "string" ||
        !value.path_display.toLowerCase().startsWith(`${root}/`.toLowerCase()) ||
        typeof value.name !== "string" || !value.name ||
        value.name !== value.path_display.split("/").pop() ||
        typeof value.id !== "string" || !value.id.startsWith("id:") || value.id.length <= 3 ||
        (value.path_lower !== undefined && value.path_lower !== value.path_display.toLowerCase()))
      throw new PersonalSyncError("Invalid or out-of-scope Dropbox metadata.");
    const path = value.path_display.split("/").slice(root.split("/").length).join("/");
    validatePath(path);
    if (file && (
      (value[".tag"] !== undefined && value[".tag"] !== "file") ||
      typeof value.rev !== "string" || !/^[0-9a-f]{9,}$/.test(value.rev) ||
      typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 ||
      (value.is_downloadable !== undefined && value.is_downloadable !== true) ||
      value.symlink_info !== undefined
    ))
      throw new PersonalSyncError("Invalid or unsupported Dropbox file metadata.");
    return path;
  }
  async list(): Promise<Entry[]> {
    this.ready = false;
    this.items.clear();
    const result: Entry[] = [],
      seen = new Set<string>(), names = new Set<string>();
    let r = await this.session.api<{
      entries: DropboxItem[];
      cursor: string;
      has_more: boolean;
    }>("https://api.dropboxapi.com/2/files/list_folder", "POST", {
      path: this.root(),
      recursive: true,
      include_deleted: false,
      include_non_downloadable_files: true,
    });
    for (let page = 0; page < 10000; page++) {
      if (!r || !Array.isArray(r.entries) || typeof r.has_more !== "boolean" ||
          typeof r.cursor !== "string" || !r.cursor)
        throw new PersonalSyncError("Incomplete Dropbox listing.");
      for (const x of r.entries) {
        if (!x || (x[".tag"] !== "file" && x[".tag"] !== "folder"))
          throw new PersonalSyncError("Unexpected Dropbox item.");
        const path = this.item(x, x[".tag"] === "file");
        const folded = path.normalize("NFC").toLowerCase();
        if (names.has(folded))
          throw new PersonalSyncError("Duplicate Dropbox paths; preview again.");
        names.add(folded);
        if (x[".tag"] === "folder") continue;
        this.items.set(path, x);
        result.push({ path, size: x.size });
      }
      if (!r.has_more) {
        this.ready = true;
        return result;
      }
      if (!r.cursor || seen.has(r.cursor))
        throw new PersonalSyncError("Invalid Dropbox pagination cursor.");
      seen.add(r.cursor);
      r = await this.session.api(
        "https://api.dropboxapi.com/2/files/list_folder/continue",
        "POST",
        { cursor: r.cursor }
      );
    }
    throw new PersonalSyncError("Dropbox listing exceeds the page safety limit.");
  }
  async read(path: string): Promise<ArrayBuffer> {
    const expected = this.items.get(path);
    if (!this.ready || !expected)
      throw new PersonalSyncError("File missing from complete Dropbox inventory.");
    const response = await this.session.request({
        url: "https://content.dropboxapi.com/2/files/download",
        method: "POST",
        headers: { "Dropbox-API-Arg": asciiJSON({ path: this.path(path) }) },
      });
    let metadata: DropboxItem;
    try {
      const header = Object.entries(response.headers).find(([k]) => k.toLowerCase() === "dropbox-api-result")?.[1];
      if (!header) throw Error();
      metadata = JSON.parse(header);
    } catch {
      throw new PersonalSyncError("Missing or invalid Dropbox download metadata.");
    }
    if (this.item(metadata, true) !== path || metadata.id !== expected.id ||
        metadata.rev !== expected.rev || metadata.size !== response.body.byteLength)
      throw new PersonalSyncError("Dropbox file changed or download was incomplete. Preview again.");
    return response.body;
  }
  async write(path: string, bytes: ArrayBuffer): Promise<void> {
    if (!this.ready)
      throw new PersonalSyncError("Complete a Dropbox inventory before writing.");
    const expected = this.items.get(path);
    // Dropbox creates missing parent folders for uploads. The root must already
    // exist before the read-only list call can succeed.
    const response = await this.session.request({
      url: "https://content.dropboxapi.com/2/files/upload",
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": asciiJSON({
          path: this.path(path),
          mode: expected ? { ".tag": "update", update: expected.rev } : { ".tag": "add" },
          autorename: false,
          strict_conflict: true,
          mute: true,
        }),
      },
      body: bytes,
    }, [409, 429]);
    if (response.status === 409)
      throw new PersonalSyncError("Dropbox rejected the upload because of a conflict or storage restriction. Preview again.");
    if (response.status === 429)
      throw new PersonalSyncError("Dropbox is rate limiting uploads. Wait before previewing again.");
    const metadata = json<DropboxItem>(response);
    if (this.item(metadata, true) !== path || metadata.size !== bytes.byteLength ||
        (expected && metadata.id !== expected.id))
      throw new PersonalSyncError("Dropbox upload metadata did not match the file. Preview again.");
    this.items.set(path, metadata);
  }
}
export function asciiJSON(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (x) => `\\u${x.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
