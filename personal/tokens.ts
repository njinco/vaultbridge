// SPDX-License-Identifier: Apache-2.0
import type { Response } from "./cloud";
import { PersonalSyncError } from "./errors";

export function tokenResponse(response: Response, requireRefresh: boolean) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(response.body));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error();
  } catch {
    throw new PersonalSyncError("Invalid token response from your cloud app.");
  }
  if (response.status < 200 || response.status >= 300) {
    if (body.error === "invalid_grant")
      throw new PersonalSyncError(
        "Cloud authorization expired or was revoked. Authorize your own app again."
      );
    throw new PersonalSyncError(`Cloud authorization failed (HTTP ${response.status}).`);
  }
  const access = body.access_token, refresh = body.refresh_token, expires = body.expires_in;
  if (
    typeof access !== "string" || !access || /[\s\x00-\x1f\x7f]/.test(access) ||
    (refresh !== undefined && (typeof refresh !== "string" || !refresh || /[\s\x00-\x1f\x7f]/.test(refresh))) ||
    (requireRefresh && refresh === undefined) ||
    typeof expires !== "number" || !Number.isFinite(expires) || expires <= 0 ||
    !Number.isSafeInteger(Math.ceil(Date.now() + expires * 1000)) ||
    (body.token_type !== undefined && (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer"))
  )
    throw new PersonalSyncError("Invalid or incomplete token response from your cloud app.");
  return { accessToken: access, refreshToken: refresh as string | undefined,
    expiresAt: Date.now() + expires * 1000 };
}
