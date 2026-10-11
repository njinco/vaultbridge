import type { RemotelySavePluginSettings } from "./baseTypes";

type Validator = (value: unknown) => boolean;
type Schema = Record<string, Validator>;
const string: Validator = (value) => typeof value === "string";
const boolean: Validator = (value) => typeof value === "boolean";
const integer: Validator = (value) =>
  typeof value === "number" && Number.isSafeInteger(value);
const nonnegative: Validator = (value) =>
  integer(value) && (value as number) >= 0;
const positive: Validator = (value) => integer(value) && (value as number) > 0;
const interval: Validator = (value) =>
  integer(value) && (value as number) >= -1;
const oneOf =
  (...values: unknown[]): Validator =>
  (value) =>
    values.includes(value);
const strings: Validator = (value) =>
  Array.isArray(value) && value.every(string);
const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const object =
  (schema: Schema, required: string[] = []): Validator =>
  (value) =>
    isRecord(value) &&
    required.every((key) => hasOwn(value, key)) &&
    Object.entries(value).every(
      ([key, item]) => hasOwn(schema, key) && schema[key](item)
    );

const oauthSeconds: Schema = {
  accessToken: string,
  clientID: string,
  refreshToken: string,
  accessTokenExpiresInSeconds: nonnegative,
  accessTokenExpiresAtTime: nonnegative,
  credentialsShouldBeDeletedAtTime: nonnegative,
  remoteBaseDir: string,
};
const oauthMs: Schema = {
  accessToken: string,
  refreshToken: string,
  accessTokenExpiresInMs: nonnegative,
  accessTokenExpiresAtTimeMs: nonnegative,
  credentialsShouldBeDeletedAtTimeMs: nonnegative,
  remoteBaseDir: string,
};
const secondsRequired = [
  "accessToken",
  "clientID",
  "refreshToken",
  "accessTokenExpiresInSeconds",
  "accessTokenExpiresAtTime",
];
const msRequired = [
  "accessToken",
  "refreshToken",
  "accessTokenExpiresInMs",
  "accessTokenExpiresAtTimeMs",
  "kind",
];
const onedrive = (kind: string) =>
  object(
    {
      ...oauthSeconds,
      authority: string,
      deltaLink: string,
      username: string,
      emptyFile: oneOf("skip", "error"),
      kind: oneOf(kind),
    },
    [
      ...secondsRequired,
      "authority",
      "deltaLink",
      "username",
      "emptyFile",
      "kind",
    ]
  );

// Only fields supported by settings exports may cross the URI trust boundary.
// Account entitlements and vault identity must never be imported.
const schema: Schema = {
  s3: object(
    {
      s3Endpoint: string,
      s3Region: string,
      s3AccessKeyID: string,
      s3SecretAccessKey: string,
      s3BucketName: string,
      partsConcurrency: positive,
      forcePathStyle: boolean,
      remotePrefix: string,
      useAccurateMTime: boolean,
      reverseProxyNoSignUrl: string,
      generateFolderObject: boolean,
      bypassCorsLocally: boolean,
    },
    [
      "s3Endpoint",
      "s3Region",
      "s3AccessKeyID",
      "s3SecretAccessKey",
      "s3BucketName",
    ]
  ),
  webdav: object(
    {
      address: string,
      username: string,
      password: string,
      authType: oneOf("digest", "basic"),
      manualRecursive: boolean,
      depth: oneOf(
        "auto",
        "auto_unknown",
        "auto_1",
        "auto_infinity",
        "manual_1",
        "manual_infinity"
      ),
      remoteBaseDir: string,
      customHeaders: string,
    },
    ["address", "username", "password", "authType", "manualRecursive"]
  ),
  webdis: object(
    {
      address: string,
      username: string,
      password: string,
      remoteBaseDir: string,
    },
    ["address"]
  ),
  dropbox: object({ ...oauthSeconds, accountID: string, username: string }, [
    ...secondsRequired,
    "accountID",
    "username",
  ]),
  onedrive: onedrive("onedrive"),
  onedrivefull: onedrive("onedrivefull"),
  googledrive: object(
    {
      ...oauthMs,
      scope: oneOf("https://www.googleapis.com/auth/drive.file"),
      kind: oneOf("googledrive"),
    },
    [...msRequired, "scope"]
  ),
  box: object({ ...oauthMs, kind: oneOf("box") }, msRequired),
  yandexdisk: object({ ...oauthMs, scope: string, kind: oneOf("yandexdisk") }, [
    ...msRequired,
    "scope",
  ]),
  koofr: object(
    {
      ...oauthMs,
      scope: string,
      api: string,
      mountID: string,
      kind: oneOf("koofr"),
    },
    [...msRequired, "scope", "api", "mountID"]
  ),
  pcloud: object(
    {
      accessToken: string,
      hostname: oneOf("eapi.pcloud.com", "api.pcloud.com"),
      locationid: oneOf(1, 2),
      remoteBaseDir: string,
      credentialsShouldBeDeletedAtTimeMs: nonnegative,
      kind: oneOf("pcloud"),
      emptyFile: oneOf("skip", "error"),
    },
    ["accessToken", "hostname", "locationid", "kind", "emptyFile"]
  ),
  azureblobstorage: object(
    {
      containerSasUrl: string,
      containerName: string,
      remotePrefix: string,
      generateFolderObject: boolean,
      partsConcurrency: positive,
      kind: oneOf("azureblobstorage"),
    },
    [
      "containerSasUrl",
      "containerName",
      "remotePrefix",
      "generateFolderObject",
      "partsConcurrency",
      "kind",
    ]
  ),
  password: string,
  serviceType: oneOf(
    "s3",
    "webdav",
    "dropbox",
    "onedrive",
    "onedrivefull",
    "webdis",
    "googledrive",
    "box",
    "pcloud",
    "yandexdisk",
    "koofr",
    "azureblobstorage"
  ),
  currLogLevel: oneOf("info", "debug"),
  autoRunEveryMilliseconds: interval,
  initRunAfterMilliseconds: interval,
  syncOnSaveAfterMilliseconds: interval,
  concurrency: positive,
  syncConfigDir: boolean,
  syncBookmarks: boolean,
  syncUnderscoreItems: boolean,
  lang: oneOf("auto", "en", "zh_cn", "zh_tw"),
  agreeToUseSyncV3: boolean,
  skipSizeLargerThan: interval,
  ignorePaths: strings,
  onlyAllowPaths: strings,
  enableStatusBarInfo: boolean,
  deleteToWhere: oneOf("system", "obsidian"),
  conflictAction: oneOf("keep_newer", "keep_larger", "smart_conflict"),
  protectModifyPercentage: (value) =>
    nonnegative(value) && (value as number) <= 100,
  syncDirection: oneOf(
    "bidirectional",
    "incremental_pull_only",
    "incremental_push_only",
    "incremental_pull_and_delete_only",
    "incremental_push_and_delete_only"
  ),
  obfuscateSettingFile: boolean,
  enableMobileStatusBar: boolean,
  encryptionMethod: oneOf("rclone-base64", "openssl-base64", "unknown"),
  profiler: object({
    enable: boolean,
    enablePrinting: boolean,
    recordSize: boolean,
  }),
  agreeToUploadExtraMetadata: boolean,
  logToDB: boolean,
  howToCleanEmptyFolder: oneOf("skip", "clean_both"),
};

export const validateImportedSettings = (
  value: unknown
): Partial<RemotelySavePluginSettings> => {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !object(schema)(value)
  ) {
    // Never echo input: it can include passwords, tokens, and malicious text.
    throw new Error(
      "Invalid settings import: unsupported fields, values, or incomplete service settings."
    );
  }
  return value as Partial<RemotelySavePluginSettings>;
};
