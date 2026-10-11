// SPDX-License-Identifier: Apache-2.0
import type { Vault } from "obsidian";
import { digest, included, validatePath } from "./engine";
import { PersonalSyncError } from "./errors";
import { ensureParents } from "./vault";

export const BACKUP_ROOT = "_personal_sync_backups";
const RUN =
  /^([0-9]{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FILE = 50 * 1024 * 1024;
export interface Backup {
  source: string;
  run: string;
  side: "local" | "remote";
  path: string;
  created: number;
  size: number;
}
function target(vault: Vault, path: string) {
  if (
    !included(path) ||
    path === vault.configDir ||
    path.startsWith(`${vault.configDir}/`) ||
    BACKUP_ROOT === vault.configDir ||
    BACKUP_ROOT.startsWith(`${vault.configDir}/`)
  )
    throw new PersonalSyncError(
      "Configuration and excluded files cannot be restored."
    );
}
function validate(vault: Vault, backup: Backup) {
  target(vault, backup.path);
  if (
    !RUN.test(backup.run) ||
    !["local", "remote"].includes(backup.side) ||
    backup.source !==
      `${BACKUP_ROOT}/${backup.run}/${backup.side}/${backup.path}`
  )
    throw new PersonalSyncError("Invalid backup location.");
}
export async function listBackups(
  vault: Vault,
  check: () => void = () => {}
): Promise<Backup[]> {
  check();
  if (!(await vault.adapter.exists(BACKUP_ROOT))) return [];
  const queue = [BACKUP_ROOT],
    result: Backup[] = [];
  const seen = new Set(queue);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    check();
    if (cursor > 10000)
      throw new PersonalSyncError("Backup tree is too large.");
    const directory = queue[cursor];
    const page = await vault.adapter.list(directory);
    check();
    for (const child of [...page.folders, ...page.files]) {
      validatePath(child);
      if (
        !child.startsWith(`${directory}/`) ||
        child.slice(directory.length + 1).includes("/") ||
        seen.has(child)
      )
        throw new PersonalSyncError("Invalid backup inventory.");
      seen.add(child);
    }
    for (const folder of page.folders) {
      const [, run, side] = folder.split("/");
      if (
        RUN.test(run ?? "") &&
        (side === undefined || side === "local" || side === "remote")
      )
        queue.push(folder);
    }
    for (const source of page.files) {
      const [, run, side, ...parts] = source.split("/");
      const match = RUN.exec(run ?? "");
      if (!match || !["local", "remote"].includes(side) || !parts.length)
        continue;
      const path = parts.join("/");
      target(vault, path);
      const stat = await vault.adapter.stat(source);
      check();
      if (
        !stat ||
        stat.type !== "file" ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 0
      )
        throw new PersonalSyncError(
          "Backup changed during listing. Review again."
        );
      result.push({
        source,
        run,
        side: side as Backup["side"],
        path,
        created: Number(match[1]),
        size: stat.size,
      });
      if (result.length > 10000)
        throw new PersonalSyncError("Too many backup files to review.");
    }
  }
  return result.sort(
    (a, b) =>
      b.created - a.created ||
      b.run.localeCompare(a.run) ||
      a.source.localeCompare(b.source)
  );
}
async function read(vault: Vault, path: string, check: () => void) {
  check();
  const stat = await vault.adapter.stat(path);
  check();
  if (
    !stat ||
    stat.type !== "file" ||
    !Number.isSafeInteger(stat.size) ||
    stat.size < 0 ||
    stat.size > MAX_FILE
  )
    throw new PersonalSyncError(
      "Backup or destination is missing, unsupported or exceeds 50 MiB."
    );
  const bytes = await vault.adapter.readBinary(path);
  check();
  if (bytes.byteLength > MAX_FILE)
    throw new PersonalSyncError("File exceeds the 50 MiB safety limit.");
  return bytes;
}
export interface RestorePlan {
  backup: Backup;
  bytes: ArrayBuffer;
  sourceHash: string;
  currentHash?: string;
}
export async function prepareRestore(
  vault: Vault,
  backup: Backup,
  check: () => void = () => {}
): Promise<RestorePlan> {
  validate(vault, backup);
  const bytes = await read(vault, backup.source, check);
  check();
  const current = (await vault.adapter.exists(backup.path))
    ? await read(vault, backup.path, check)
    : undefined;
  check();
  return {
    backup,
    bytes,
    sourceHash: await digest(bytes),
    currentHash: current ? await digest(current) : undefined,
  };
}
export async function restoreBackup(
  vault: Vault,
  plan: RestorePlan,
  run: string,
  check: () => void = () => {}
) {
  validate(vault, plan.backup);
  if (!RUN.test(run)) throw new PersonalSyncError("Invalid restore backup ID.");
  const { path, source } = plan.backup;
  const unchanged = async () => {
    check();
    const current = (await vault.adapter.exists(path))
      ? await read(vault, path, check)
      : undefined;
    check();
    if (
      (current ? await digest(current) : undefined) !== plan.currentHash ||
      (await digest(await read(vault, source, check))) !== plan.sourceHash ||
      (await digest(plan.bytes)) !== plan.sourceHash
    )
      throw new PersonalSyncError(
        "Backup or destination changed after review. Review again."
      );
    return current;
  };
  const current = await unchanged();
  if (current) {
    const undo = `${BACKUP_ROOT}/${run}/local/${path}`;
    if (await vault.adapter.exists(undo))
      throw new PersonalSyncError("Restore backup already exists.");
    await ensureParents(vault, undo, check);
    check();
    await vault.adapter.writeBinary(undo, current);
    check();
    if ((await digest(await read(vault, undo, check))) !== plan.currentHash)
      throw new PersonalSyncError(
        "Restore backup verification failed. Destination was not replaced."
      );
  }
  await ensureParents(vault, path, check);
  await unchanged();
  check();
  await vault.adapter.writeBinary(path, plan.bytes);
  check();
  if ((await digest(await read(vault, path, check))) !== plan.sourceHash)
    throw new PersonalSyncError(
      "Restore verification failed. Undo backup retained."
    );
}
export interface CleanupPlan {
  files: { backup: Backup; hash: string }[];
}
export async function prepareCleanup(
  vault: Vault,
  keepRuns: number,
  check: () => void = () => {}
): Promise<CleanupPlan> {
  if (!Number.isSafeInteger(keepRuns) || keepRuns < 1)
    throw new PersonalSyncError("Keep at least one backup run.");
  const backups = await listBackups(vault, check);
  const retained = new Set(
    [...new Set(backups.map((b) => b.run))].slice(0, keepRuns)
  );
  const files: CleanupPlan["files"] = [];
  for (const backup of backups) {
    if (!retained.has(backup.run))
      files.push({
        backup,
        hash: await digest(await read(vault, backup.source, check)),
      });
  }
  return { files };
}
export async function cleanupBackups(
  vault: Vault,
  plan: CleanupPlan,
  check: () => void = () => {}
) {
  const verify = async (file: CleanupPlan["files"][number]) => {
    validate(vault, file.backup);
    if (
      (await digest(await read(vault, file.backup.source, check))) !== file.hash
    )
      throw new PersonalSyncError(
        "Backup changed after cleanup review. Review again."
      );
  };
  // Check the whole reviewed set before moving the first file, then near each move.
  for (const file of plan.files) await verify(file);
  for (const file of plan.files) {
    await verify(file);
    check();
    await vault.adapter.trashLocal(file.backup.source);
    check();
  }
}
