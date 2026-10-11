// SPDX-License-Identifier: Apache-2.0
import { PersonalSyncError } from "./errors";
// Independent personal sync implementation; does not use the upstream PRO engine.
import { diff3Merge } from "node-diff3";
import type { JournalPhase } from "./journal";

export interface Entry {
  path: string;
  size?: number;
}
export interface Store {
  list(): Promise<Entry[]>;
  read(path: string): Promise<ArrayBuffer>;
  write(
    path: string,
    bytes: ArrayBuffer,
    expected?: WriteCondition
  ): Promise<void>;
}
export interface WriteCondition {
  hash?: string;
}
export interface Baseline {
  hash: string;
  text?: string;
}
export type History = Record<string, Baseline>;
export type Action = "equal" | "upload" | "download" | "merge" | "conflict";
export interface Change {
  path: string;
  action: Action;
  local?: ArrayBuffer;
  remote?: ArrayBuffer;
  result?: ArrayBuffer;
  reason?: string;
}
export interface Plan {
  changes: Change[];
}
export interface Progress {
  phase: "preview" | "validate" | "apply";
  completed: number;
  total: number;
  path?: string;
}
export type ReportProgress = (progress: Progress) => void;
const MAX_FILE = 50 * 1024 * 1024;
const MAX_PLAN = 256 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

export function validatePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    /[\\\u0000-\u001f\u007f:<>"|?*]/.test(path) ||
    path
      .split("/")
      .some(
        (x) =>
          !x ||
          x === "." ||
          x === ".." ||
          ["__proto__", "constructor", "prototype"].includes(x) ||
          /[ .]$/.test(x)
      )
  ) {
    throw new PersonalSyncError(
      "Unsafe or unsupported vault path; sync stopped."
    );
  }
}
export function included(path: string): boolean {
  validatePath(path);
  return (
    !path.split("/").some((x) => x.startsWith(".")) &&
    path !== "_personal_sync_backups" &&
    !path.startsWith("_personal_sync_backups/") &&
    !path.startsWith("_debug_remotely_save/") &&
    ![
      "_remotely-save-metadata-on-remote.json",
      "_remotely-save-metadata-on-remote.bin",
    ].includes(path)
  );
}
export async function digest(bytes: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function textOf(bytes: ArrayBuffer): string | undefined {
  if (bytes.byteLength > MAX_TEXT) return undefined;
  try {
    const s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
    return s.includes("\0") ? undefined : s;
  } catch {
    return undefined;
  }
}
function lines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
export function mergeNote(
  base: string,
  local: string,
  remote: string
): string | undefined {
  // Include line terminators in tokens: preserve CRLF, BOM and final-newline changes.
  if (
    [base, local, remote].some(
      (s) => s.length > MAX_TEXT || lines(s).length > 10000
    )
  )
    return undefined;
  const regions = diff3Merge(lines(local), lines(base), lines(remote), {
    excludeFalseConflicts: true,
  });
  if (regions.some((r) => r.conflict !== undefined)) return undefined;
  return regions.flatMap((r) => r.ok ?? []).join("");
}
async function index(store: Store): Promise<Map<string, Entry>> {
  const result = new Map<string, Entry>();
  for (const item of await store.list()) {
    if (!included(item.path)) continue;
    if (result.has(item.path))
      throw new PersonalSyncError("Duplicate remote name; sync stopped.");
    if ((item.size ?? 0) > MAX_FILE)
      throw new PersonalSyncError("File exceeds the 50 MiB safety limit.");
    result.set(item.path, item);
  }
  return result;
}
function checkNames(paths: Iterable<string>) {
  const names = new Map<string, string>();
  const fileNames = new Set(paths);
  const foldedFiles = new Set(
    Array.from(fileNames, (p) => p.normalize("NFC").toLowerCase())
  );
  for (const path of fileNames) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/"),
        folded = prefix.normalize("NFC").toLowerCase();
      if (names.has(folded) && names.get(folded) !== prefix)
        throw new PersonalSyncError(
          "Case or Unicode name collision; sync stopped."
        );
      names.set(folded, prefix);
      if (i < parts.length && foldedFiles.has(folded))
        throw new PersonalSyncError(
          "File and folder name collision; sync stopped."
        );
    }
  }
}
export async function preview(
  local: Store,
  remote: Store,
  history: History,
  report?: ReportProgress
): Promise<Plan> {
  // Complete both inventories before computing anything that could be applied.
  const [l, r] = await Promise.all([index(local), index(remote)]);
  const paths = new Set([...l.keys(), ...r.keys()]);
  checkNames(paths);
  const changes: Change[] = [];
  let total = 0;
  report?.({ phase: "preview", completed: 0, total: paths.size });
  for (const path of Array.from(paths).sort()) {
    const a = l.has(path) ? await local.read(path) : undefined;
    const b = r.has(path) ? await remote.read(path) : undefined;
    total += (a?.byteLength ?? 0) + (b?.byteLength ?? 0);
    if (
      (a?.byteLength ?? 0) > MAX_FILE ||
      (b?.byteLength ?? 0) > MAX_FILE ||
      total > MAX_PLAN
    ) {
      throw new PersonalSyncError(
        "Preview exceeds the memory safety limit; no files have been changed."
      );
    }
    const c: Change = { path, action: "conflict", local: a, remote: b };
    const ah = a ? await digest(a) : undefined;
    const bh = b ? await digest(b) : undefined;
    const base = Object.prototype.hasOwnProperty.call(history, path)
      ? history[path]
      : undefined;
    if (!a) {
      c.action = "download";
      c.result = b;
    } else if (!b) {
      c.action = "upload";
      c.result = a;
    } else if (ah === bh) {
      c.action = "equal";
      c.result = a;
      // Equal copies need only one retained buffer; actual contents were hashed.
      c.remote = a;
    } else if (base?.hash === bh) {
      c.action = "upload";
      c.result = a;
    } else if (base?.hash === ah) {
      c.action = "download";
      c.result = b;
    } else {
      const at = textOf(a),
        bt = textOf(b);
      // A corrupt/stale stored base cannot authorize a merge.
      const validBase =
        base?.text !== undefined &&
        (await digest(new TextEncoder().encode(base.text).buffer)) ===
          base.hash;
      const merged =
        path.toLowerCase().endsWith(".md") &&
        validBase &&
        at !== undefined &&
        bt !== undefined
          ? mergeNote(base!.text!, at, bt)
          : undefined;
      if (merged !== undefined) {
        c.action = "merge";
        c.result = new TextEncoder().encode(merged).buffer;
      } else
        c.reason = validBase
          ? "Overlapping edits or unsupported content"
          : "No shared version saved on this device";
    }
    changes.push(c);
    report?.({
      phase: "preview",
      completed: changes.length,
      total: paths.size,
      path,
    });
  }
  return { changes };
}
async function assertUnchanged(
  store: Store,
  inventory: Map<string, Entry>,
  path: string,
  expected?: ArrayBuffer,
  expectedHash?: string
) {
  if (inventory.has(path) !== (expected !== undefined))
    throw new PersonalSyncError("Files changed after preview. Preview again.");
  if (
    expected &&
    (await digest(await store.read(path))) !==
      (expectedHash ?? (await digest(expected)))
  ) {
    throw new PersonalSyncError("Files changed after preview. Preview again.");
  }
}
export interface ApplyHooks {
  progress?: ReportProgress;
  record?(path: string, phase: JournalPhase): Promise<void>;
  backup(
    path: string,
    side: "local" | "remote",
    bytes: ArrayBuffer
  ): Promise<void>;
  checkpoint(history: History): Promise<void>;
}
export async function apply(
  plan: Plan,
  local: Store,
  remote: Store,
  history: History,
  hooks: ApplyHooks
): Promise<number> {
  const [li, ri] = await Promise.all([index(local), index(remote)]);
  checkNames(new Set([...li.keys(), ...ri.keys()]));
  const hashes = new WeakMap<ArrayBuffer, string>();
  const hashOf = async (bytes?: ArrayBuffer) => {
    if (!bytes) return undefined;
    let hash = hashes.get(bytes);
    if (hash === undefined) {
      hash = await digest(bytes);
      hashes.set(bytes, hash);
    }
    return hash;
  };
  let validated = 0;
  hooks.progress?.({
    phase: "validate",
    completed: 0,
    total: plan.changes.length,
  });
  // Fail before the first write if any previewed file was edited/deleted/created.
  for (const c of plan.changes) {
    if (!included(c.path)) throw new PersonalSyncError("Invalid plan path.");
    await assertUnchanged(local, li, c.path, c.local, await hashOf(c.local));
    await assertUnchanged(remote, ri, c.path, c.remote, await hashOf(c.remote));
    if (
      c.action === "equal" &&
      (!c.local ||
        !c.remote ||
        !c.result ||
        (await hashOf(c.local)) !== (await hashOf(c.remote)) ||
        (await hashOf(c.result)) !== (await hashOf(c.local)))
    )
      throw new PersonalSyncError("Invalid unchanged-file plan.");
    hooks.progress?.({
      phase: "validate",
      completed: ++validated,
      total: plan.changes.length,
      path: c.path,
    });
  }
  let conflicts = 0;
  let completed = 0;
  const equalHistory: History = Object.create(null);
  hooks.progress?.({
    phase: "apply",
    completed: 0,
    total: plan.changes.length,
  });
  for (const c of plan.changes) {
    if (c.action === "equal") {
      // Preflight confirmed convergence. No writes need another content check.
      const baseline = {
        hash: (await hashOf(c.result))!,
        text: c.path.toLowerCase().endsWith(".md")
          ? textOf(c.result!)
          : undefined,
      };
      if (
        history[c.path]?.hash !== baseline.hash ||
        history[c.path]?.text !== baseline.text
      )
        equalHistory[c.path] = baseline;
      hooks.progress?.({
        phase: "apply",
        completed: ++completed,
        total: plan.changes.length,
        path: c.path,
      });
      continue;
    }
    // Recheck close to writing as well; remote services do not offer a cross-provider transaction.
    await assertUnchanged(local, li, c.path, c.local, await hashOf(c.local));
    await assertUnchanged(remote, ri, c.path, c.remote, await hashOf(c.remote));
    if (c.action === "conflict") {
      if (c.local) {
        await hooks.record?.(c.path, "backup-local");
        await hooks.backup(c.path, "local", c.local);
      }
      if (c.remote) {
        await hooks.record?.(c.path, "backup-remote");
        await hooks.backup(c.path, "remote", c.remote);
      }
      await hooks.record?.(c.path, "preserved");
      conflicts++;
      hooks.progress?.({
        phase: "apply",
        completed: ++completed,
        total: plan.changes.length,
        path: c.path,
      });
      continue;
    }
    if (!c.result)
      throw new PersonalSyncError("Invalid plan: missing content.");
    if (["download", "merge"].includes(c.action) && c.local) {
      await hooks.record?.(c.path, "backup-local");
      await hooks.backup(c.path, "local", c.local);
    }
    if (["upload", "merge"].includes(c.action) && c.remote) {
      await hooks.record?.(c.path, "backup-remote");
      await hooks.backup(c.path, "remote", c.remote);
    }
    if (["upload", "merge"].includes(c.action)) {
      await hooks.record?.(c.path, "write-remote");
      await remote.write(c.path, c.result);
    }
    if (["download", "merge"].includes(c.action)) {
      await hooks.record?.(c.path, "write-local");
      // Backups and remote uploads can take time. Re-inventory to detect a newly
      // created destination, then check again inside VaultStore after mkdirs.
      const current = await index(local);
      checkNames(new Set([...current.keys(), ...ri.keys()]));
      await assertUnchanged(
        local,
        current,
        c.path,
        c.local,
        await hashOf(c.local)
      );
      await local.write(c.path, c.result, { hash: await hashOf(c.local) });
    }
    // Never record convergence when a failed or partial upload changed the content.
    const hash = (await hashOf(c.result))!;
    if (
      (await digest(await local.read(c.path))) !== hash ||
      (await digest(await remote.read(c.path))) !== hash
    ) {
      throw new PersonalSyncError(
        "Post-write verification failed. Backups retained; preview again."
      );
    }
    const previous = history[c.path];
    history[c.path] = {
      hash,
      text: c.path.toLowerCase().endsWith(".md") ? textOf(c.result) : undefined,
    };
    try {
      await hooks.checkpoint(history);
    } catch (error) {
      if (previous) history[c.path] = previous;
      else delete history[c.path];
      throw error;
    }
    await hooks.record?.(c.path, "verified");
    hooks.progress?.({
      phase: "apply",
      completed: ++completed,
      total: plan.changes.length,
      path: c.path,
    });
  }
  if (Object.keys(equalHistory).length) {
    const previous = { ...history };
    Object.assign(history, equalHistory);
    try {
      await hooks.checkpoint(history);
    } catch (error) {
      for (const path of Object.keys(equalHistory)) {
        if (Object.prototype.hasOwnProperty.call(previous, path))
          history[path] = previous[path];
        else delete history[path];
      }
      throw error;
    }
  }
  return conflicts;
}
