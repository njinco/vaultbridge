// SPDX-License-Identifier: Apache-2.0
import { included, type Plan, type Action } from "./engine";
import { PersonalSyncError } from "./errors";
export type JournalPhase =
  | "queued"
  | "backup-local"
  | "backup-remote"
  | "write-local"
  | "write-remote"
  | "verified"
  | "preserved";
const phases: readonly string[] = [
  "queued",
  "backup-local",
  "backup-remote",
  "write-local",
  "write-remote",
  "verified",
  "preserved",
];
export interface JournalFile {
  path: string;
  action: Exclude<Action, "equal">;
  phase: JournalPhase;
}
export interface SyncJournal {
  id: string;
  startedAt: number;
  files: JournalFile[];
}
const idPattern =
  /^[0-9]{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function newJournal(
  plan: Plan,
  id: string,
  startedAt: number
): SyncJournal {
  if (plan.changes.filter((c) => c.action !== "equal").length > 10000)
    throw new PersonalSyncError(
      "Sync plan exceeds the 10,000 changed-file journal limit. Use a smaller vault before applying."
    );
  return parseJournal({
    id,
    startedAt,
    files: plan.changes
      .filter((c) => c.action !== "equal")
      .map((c) => ({ path: c.path, action: c.action, phase: "queued" })),
  });
}
export function parseJournal(raw: unknown): SyncJournal {
  const invalid = (): never => {
    throw new PersonalSyncError(
      "Saved sync journal is invalid. Keep a private copy of data.json and repair it before syncing. The journal limit is 10,000 changed files per run."
    );
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const source = raw as Record<string, unknown>;
  if (
    typeof source.id !== "string" ||
    !idPattern.test(source.id) ||
    typeof source.startedAt !== "number" ||
    !Number.isSafeInteger(source.startedAt) ||
    source.startedAt < 0 ||
    !Array.isArray(source.files) ||
    source.files.length > 10000
  )
    return invalid();
  const files: JournalFile[] = [],
    seen = new Set<string>();
  for (const rawFile of source.files) {
    if (!rawFile || typeof rawFile !== "object" || Array.isArray(rawFile))
      return invalid();
    const file = rawFile as Record<string, unknown>;
    let valid = false;
    try {
      valid = typeof file.path === "string" && included(file.path);
    } catch {
      /* Fail closed. */
    }
    if (
      !valid ||
      seen.has(file.path as string) ||
      !["upload", "download", "merge", "conflict"].includes(
        file.action as string
      ) ||
      !phases.includes(file.phase as string)
    )
      return invalid();
    seen.add(file.path as string);
    files.push({
      path: file.path as string,
      action: file.action as JournalFile["action"],
      phase: file.phase as JournalPhase,
    });
  }
  return { id: source.id, startedAt: source.startedAt, files };
}
