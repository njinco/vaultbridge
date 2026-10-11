// SPDX-License-Identifier: Apache-2.0
import { digest, type History } from "./engine";
import type { Settings } from "./settings";
import { PersonalSyncError } from "./errors";

export async function historyNamespace(
  settings: Settings,
  accountId?: string
): Promise<string> {
  const identity =
    settings.provider === "s3"
      ? [
          settings.s3.s3Endpoint,
          settings.s3.s3Region,
          settings.s3.s3BucketName,
          settings.s3.remotePrefix,
          settings.s3.s3AccessKeyID,
        ]
      : accountId === undefined
        ? [
            settings[settings.provider].clientId,
            settings[settings.provider].root,
            settings[settings.provider].refreshToken,
          ]
        : [
            "account-v2",
            settings[settings.provider].clientId,
            settings[settings.provider].root,
            accountId,
          ];
  if (accountId !== undefined && !/^[A-Za-z0-9:_-]{1,256}$/.test(accountId))
    throw new PersonalSyncError(
      "Cloud account identity could not be verified."
    );
  return digest(
    new TextEncoder().encode(
      JSON.stringify([
        settings.provider,
        identity,
        settings.encryption,
        settings.password,
      ])
    ).buffer
  );
}
export function selectHistory(
  histories: Record<string, History>,
  namespace: string,
  legacy: string
) {
  if (Object.prototype.hasOwnProperty.call(histories, namespace))
    return { history: histories[namespace], migrated: false };
  if (Object.prototype.hasOwnProperty.call(histories, legacy))
    return {
      history: structuredClone(histories[legacy]),
      migrated: namespace !== legacy,
    };
  return { history: Object.create(null) as History, migrated: false };
}
