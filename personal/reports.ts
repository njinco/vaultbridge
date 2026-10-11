// SPDX-License-Identifier: Apache-2.0
import type { Plan } from "./engine";
import type { Provider } from "./cloud";
import { supportedProvider } from "./cloud";
import { PersonalSyncError } from "./errors";
export interface SyncReport {
  id: string;
  startedAt: number;
  endedAt: number;
  provider: Provider;
  status: "completed" | "cancelled" | "failed";
  counts: {
    upload: number;
    download: number;
    merge: number;
    conflict: number;
    equal: number;
  };
  selected: number;
  skipped: number;
  verified: number;
  preserved: number;
}
export function countActions(plan: Plan): SyncReport["counts"] {
  const counts = { upload: 0, download: 0, merge: 0, conflict: 0, equal: 0 };
  for (const change of plan.changes) counts[change.action]++;
  return counts;
}
export function parseReports(raw: unknown): SyncReport[] {
  const invalid = (): never => {
    throw new PersonalSyncError(
      "Saved sync reports are invalid. Keep a copy of data.json and repair it before syncing."
    );
  };
  if (!Array.isArray(raw) || raw.length > 20) return invalid();
  const ids = new Set<string>();
  return raw.map((r) => {
    if (
      !r ||
      typeof r !== "object" ||
      !/^[0-9]{13}-[0-9a-f-]{36}$/.test(r.id) ||
      ids.has(r.id) ||
      !supportedProvider(r.provider) ||
      !["completed", "cancelled", "failed"].includes(r.status) ||
      !r.counts ||
      typeof r.counts !== "object"
    )
      return invalid();
    const n = (v: unknown): number =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0
        ? v
        : invalid();
    ids.add(r.id);
    const counts = {
      upload: n(r.counts.upload),
      download: n(r.counts.download),
      merge: n(r.counts.merge),
      conflict: n(r.counts.conflict),
      equal: n(r.counts.equal),
    };
    const result: SyncReport = {
      id: r.id,
      startedAt: n(r.startedAt),
      endedAt: n(r.endedAt),
      provider: r.provider,
      status: r.status,
      counts,
      selected: n(r.selected),
      skipped: n(r.skipped),
      verified: n(r.verified),
      preserved: n(r.preserved),
    };
    if (
      result.endedAt < result.startedAt ||
      result.selected !==
        counts.upload + counts.download + counts.merge + counts.conflict ||
      result.verified + result.preserved > result.selected
    )
      return invalid();
    return result;
  });
}
// Allowlist every exported field. Never serialize settings, journals, paths,
// account IDs, note contents, targets or provider exceptions into diagnostics.
export function diagnostics(reports: SyncReport[], version: string): string {
  return JSON.stringify(
    { app: "VaultBridge", version, reports: parseReports(reports) },
    null,
    2
  );
}
