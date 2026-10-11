// SPDX-License-Identifier: Apache-2.0
// Only deliberately public messages may reach notices. SDK errors can contain
// signed URLs and tokens and must never be logged or displayed directly.
export class PersonalSyncError extends Error {}
export function publicError(error: unknown): string {
  return error instanceof PersonalSyncError
    ? error.message
    : "Cloud or encryption request failed. Check your account, connection and encryption settings.";
}
