// SPDX-License-Identifier: Apache-2.0
import type { S3Config } from "../src/baseTypes";
import type { Credentials, Provider } from "./cloud";

export type Encryption = "unset" | "none" | "openssl-base64" | "rclone-base64";
export interface Settings {
  provider: Provider;
  encryption: Encryption;
  password: string;
  exclusions: string;
  s3: S3Config;
  dropbox: Credentials;
  google: Credentials;
}
const credentials = (): Credentials => ({
  clientId: "",
  clientSecret: "",
  accessToken: "",
  refreshToken: "",
  expiresAt: 0,
  root: "",
});
export const defaults = (): Settings => ({
  provider: "s3",
  encryption: "unset",
  password: "",
  exclusions: "",
  s3: {
    s3Endpoint: "",
    s3Region: "",
    s3AccessKeyID: "",
    s3SecretAccessKey: "",
    s3BucketName: "",
    remotePrefix: "",
    forcePathStyle: false,
    partsConcurrency: 4,
    useAccurateMTime: false,
    reverseProxyNoSignUrl: "",
    generateFolderObject: false,
    bypassCorsLocally: true,
  },
  dropbox: credentials(),
  google: credentials(),
});
