// SPDX-License-Identifier: Apache-2.0
import type { Settings } from "./settings";
import { compileExclusions } from "./exclusions";
export function setupIssues(settings: Settings): string[] {
  const issues: string[] = [];
  if (settings.encryption === "unset")
    issues.push(
      "Select the encryption format already used by your remote, or Unencrypted for a new unencrypted target."
    );
  try {
    compileExclusions(settings.exclusions);
  } catch {
    issues.push("Fix exclusion rules before checking or previewing.");
  }
  if (settings.provider === "s3") {
    const s = settings.s3;
    if (
      !s.s3BucketName ||
      !s.s3Region ||
      !s.s3AccessKeyID ||
      !s.s3SecretAccessKey
    )
      issues.push(
        "Enter the S3 bucket, region, access key ID and secret access key."
      );
    if (s.s3Region && !/^[a-z0-9-]+$/.test(s.s3Region))
      issues.push("Use a valid S3 region identifier.");
    if (s.s3Endpoint) {
      try {
        const u = new URL(s.s3Endpoint);
        if (
          u.protocol !== "https:" ||
          u.username ||
          u.password ||
          u.search ||
          u.hash
        )
          throw Error();
      } catch {
        issues.push(
          "Use an HTTPS S3 endpoint without credentials, query parameters or fragments."
        );
      }
    }
    if (s.reverseProxyNoSignUrl)
      issues.push("Unsigned S3 reverse proxies are unsupported.");
    if (
      s.remotePrefix &&
      (s.remotePrefix.startsWith("/") ||
        s.remotePrefix.split("/").some((p) => p === "." || p === "..") ||
        /[\\\x00-\x1f]/.test(s.remotePrefix))
    )
      issues.push(
        "Use a relative S3 prefix without parent segments or backslashes."
      );
  } else if (
    settings.provider === "google" ||
    settings.provider === "dropbox"
  ) {
    const c = settings[settings.provider];
    if (!c.clientId || (!c.refreshToken && !c.accessToken))
      issues.push(
        "Enter your own OAuth client ID and authorize your app or enter its tokens locally."
      );
    if (!c.root)
      issues.push(
        settings.provider === "google"
          ? "Enter a dedicated Google Drive folder ID."
          : "Enter the Dropbox vault folder path inside your app/account root."
      );
  } else issues.push("Choose S3, Google Drive or Dropbox.");
  return issues;
}
