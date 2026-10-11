// SPDX-License-Identifier: Apache-2.0
import { PersonalSyncError } from "./errors";
import type { Credentials, Transport } from "./cloud";
import { tokenResponse } from "./tokens";
export interface Authorization {
  provider: OAuthProvider;
  clientId: string;
  url: string;
  state: string;
  verifier: string;
  redirect: string;
  createdAt: number;
}
type OAuthProvider = "google" | "dropbox";
const endpoints = {
  google: {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
  },
  dropbox: {
    auth: "https://www.dropbox.com/oauth2/authorize",
    token: "https://api.dropboxapi.com/oauth2/token",
  },
};
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function authorize(
  provider: OAuthProvider,
  clientId: string,
  redirect: string
): Promise<Authorization> {
  if (!clientId)
    throw new PersonalSyncError("Enter the client ID of your own OAuth app.");
  const target = new URL(redirect);
  const loopback =
    ["127.0.0.1", "localhost"].includes(target.hostname) &&
    target.protocol === "http:";
  if (
    (!loopback && target.protocol !== "https:") ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new PersonalSyncError(
      "Use your registered HTTPS redirect or a desktop loopback redirect."
    );
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirect,
    state,
  });
  params.set(
    "code_challenge",
    b64url(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier)
        )
      )
    )
  );
  params.set("code_challenge_method", "S256");
  if (provider === "google") {
    params.set("scope", "https://www.googleapis.com/auth/drive");
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  if (provider === "dropbox") params.set("token_access_type", "offline");
  return {
    provider,
    clientId,
    url: `${endpoints[provider].auth}?${params}`,
    state,
    verifier,
    redirect,
    createdAt: Date.now(),
  };
}
export async function complete(
  provider: OAuthProvider,
  c: Credentials,
  pending: Authorization,
  callback: string,
  transport: Transport
): Promise<void> {
  const url = new URL(callback),
    expected = new URL(pending.redirect);
  if (
    provider !== pending.provider ||
    c.clientId !== pending.clientId ||
    url.username || url.password || url.hash ||
    url.searchParams.has("error") ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("code").length !== 1 ||
    !Number.isFinite(pending.createdAt) || pending.createdAt > Date.now() ||
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.searchParams.get("state") !== pending.state ||
    Date.now() - pending.createdAt > 15 * 60000 ||
    !url.searchParams.get("code")
  )
    throw new PersonalSyncError(
      "Invalid, expired, or mismatched OAuth callback."
    );
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: c.clientId,
    code: url.searchParams.get("code")!,
    redirect_uri: pending.redirect,
  });
  if (c.clientSecret) params.set("client_secret", c.clientSecret);
  params.set("code_verifier", pending.verifier);
  const r = await transport({
    url: endpoints[provider].token,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const body = tokenResponse(r, true);
  c.accessToken = body.accessToken;
  c.refreshToken = body.refreshToken!;
  c.expiresAt = body.expiresAt;
}

export async function persistAuthorization(
  credentials: Credentials,
  candidate: Credentials,
  persist: () => Promise<void>
): Promise<void> {
  const previous = { ...credentials };
  Object.assign(credentials, candidate);
  try {
    await persist();
  } catch {
    Object.assign(credentials, previous);
    throw new PersonalSyncError(
      "Cloud authorization could not be saved. Start a new authorization."
    );
  }
}
