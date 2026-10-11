// SPDX-License-Identifier: Apache-2.0
import { defaults, type Settings } from "./settings";
import { supportedProvider } from "./cloud";
import { included, type History } from "./engine";
import { PersonalSyncError } from "./errors";
import { parseJournal, type SyncJournal } from "./journal";
import { compileExclusions } from "./exclusions";
import { parseReports, type SyncReport } from "./reports";

export interface Saved {
  schemaVersion?: number;
  settings: Settings;
  histories: Record<string, History>;
  journals?: Record<string, SyncJournal>;
  reports?: SyncReport[];
}
const record = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const own = (x: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(x, key);

// Pick known fields only. Never copy arbitrary saved objects into live settings.
export function loadState(raw: unknown): { state: Saved; recovered: boolean } {
  const state: Saved = {
    schemaVersion: 3,
    settings: defaults(),
    histories: Object.create(null),
    journals: Object.create(null),
    reports: [],
  };
  if (raw === null || raw === undefined) return { state, recovered: false };
  if (!record(raw) || !record(raw.settings))
    throw new PersonalSyncError(
      "Saved settings could not be read. Keep a copy of data.json and repair it before syncing."
    );
  if (
    own(raw, "schemaVersion") &&
    ![1, 2, 3].includes(raw.schemaVersion as number)
  )
    throw new PersonalSyncError(
      "Unsupported settings version. Use the matching VaultBridge version; saved settings have not been replaced."
    );
  let recovered = false;
  if (own(raw, "journals")) {
    if (!record(raw.journals))
      throw new PersonalSyncError(
        "Saved sync journals could not be read. Repair data.json before syncing."
      );
    for (const [namespace, journal] of Object.entries(raw.journals)) {
      if (!/^[a-f0-9]{64}$/.test(namespace))
        throw new PersonalSyncError(
          "Saved sync journal has an invalid target. Repair data.json before syncing."
        );
      state.journals![namespace] = parseJournal(journal);
    }
  } else if (raw.schemaVersion === 2 || raw.schemaVersion === 3)
    recovered = true;
  if (own(raw, "reports")) state.reports = parseReports(raw.reports);
  else if (raw.schemaVersion === 3) recovered = true;
  const copy = (
    source: unknown,
    target: object,
    optional: readonly string[] = []
  ) => {
    if (!record(source)) {
      recovered = true;
      return;
    }
    const dest = target as Record<string, unknown>;
    for (const key of Object.keys(dest)) {
      if (!own(source, key)) {
        if (!optional.includes(key)) recovered = true;
        continue;
      }
      const value = source[key];
      if (
        typeof value !== typeof dest[key] ||
        (typeof value === "number" &&
          (!Number.isSafeInteger(value) || value < 0))
      ) {
        recovered = true;
        continue;
      }
      dest[key] = value;
    }
  };
  const s = raw.settings;
  if (typeof s.exclusions === "string") {
    compileExclusions(s.exclusions);
    state.settings.exclusions = s.exclusions;
  } else if (own(s, "exclusions") || raw.schemaVersion === 3) recovered = true;
  if (supportedProvider(s.provider)) state.settings.provider = s.provider;
  else recovered = true;
  if (
    ["unset", "none", "openssl-base64", "rclone-base64"].includes(
      s.encryption as string
    )
  )
    state.settings.encryption = s.encryption as Settings["encryption"];
  else recovered = true;
  if (typeof s.password === "string") state.settings.password = s.password;
  else if (own(s, "password")) recovered = true;
  copy(s.s3, state.settings.s3, [
    "partsConcurrency",
    "forcePathStyle",
    "remotePrefix",
    "useAccurateMTime",
    "reverseProxyNoSignUrl",
    "generateFolderObject",
    "bypassCorsLocally",
  ]);
  copy(s.google, state.settings.google);
  copy(s.dropbox, state.settings.dropbox);
  if (
    (state.settings.s3.partsConcurrency ?? 0) < 1 ||
    (state.settings.s3.partsConcurrency ?? 0) > 16
  ) {
    state.settings.s3.partsConcurrency = 4;
    recovered = true;
  }
  // Never silently reinterpret an unsupported provider as an unencrypted S3 target.
  if (!supportedProvider(s.provider)) state.settings.encryption = "unset";
  if (!record(raw.histories)) recovered = true;
  else
    for (const [namespace, savedHistory] of Object.entries(raw.histories)) {
      if (!/^[a-f0-9]{64}$/.test(namespace) || !record(savedHistory)) {
        recovered = true;
        continue;
      }
      const history: History = Object.create(null);
      for (const [path, baseline] of Object.entries(savedHistory)) {
        let validPath = false;
        try {
          validPath = included(path);
        } catch {
          /* Invalid history cannot authorize a merge. */
        }
        if (
          !validPath ||
          !record(baseline) ||
          typeof baseline.hash !== "string" ||
          !/^[a-f0-9]{64}$/.test(baseline.hash)
        ) {
          recovered = true;
          continue;
        }
        history[path] = { hash: baseline.hash };
        if (own(baseline, "text")) {
          if (
            typeof baseline.text === "string" &&
            baseline.text.length <= 1024 * 1024 &&
            path.toLowerCase().endsWith(".md")
          )
            history[path].text = baseline.text;
          else recovered = true;
        }
      }
      state.histories[namespace] = history;
    }
  return { state, recovered };
}
