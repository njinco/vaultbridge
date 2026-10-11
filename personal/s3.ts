// SPDX-License-Identifier: Apache-2.0
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { FakeFsS3 } from "../src/fsS3";
import type { Entity, S3Config } from "../src/baseTypes";
import { PersonalSyncError } from "./errors";

function etag(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^"[^"\\\s\x00-\x1f\x7f]{1,1024}"$/.test(value)
  )
    throw new PersonalSyncError(
      "S3 did not return a usable object version. Sync stopped."
    );
  return value;
}
function failure(error: unknown, writing = false): never {
  if (error instanceof PersonalSyncError) throw error;
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  if ([404, 409, 412].includes(status ?? 0))
    throw new PersonalSyncError(
      "S3 object changed or was created after review. Preview again."
    );
  if ([400, 405, 501].includes(status ?? 0))
    throw new PersonalSyncError(
      "S3 rejected a conditional request. Verify that your provider supports conditional reads and writes; no unconditional retry was made."
    );
  throw new PersonalSyncError(
    writing
      ? "S3 upload failed. A write may have completed; backups and the sync journal were retained. Preview again."
      : "S3 read failed. Check your provider and connection, then preview again."
  );
}
// All VaultBridge files are already buffered and bounded to 50 MiB plaintext.
// A single conditional PUT avoids unsafe multipart completion/retry behavior.
export class ConditionalS3 extends FakeFsS3 {
  private versions = new Map<string, string>();
  private ready = false;
  constructor(
    config: S3Config,
    readonly check: () => void
  ) {
    super({ ...config, generateFolderObject: false }, check);
    this.s3Client.config.maxAttempts = async () => 1;
  }
  async walk(): Promise<Entity[]> {
    this.ready = false;
    this.versions.clear();
    const entries = await super.walk();
    this.check();
    for (const entry of entries)
      if (!entry.key!.endsWith("/"))
        this.versions.set(entry.key!, etag(entry.etag));
    this.ready = true;
    return entries;
  }
  async _readFileFromRoot(key: string): Promise<ArrayBuffer> {
    if (!key.startsWith(this.s3Config.remotePrefix ?? ""))
      throw new PersonalSyncError(
        "S3 object is outside the configured prefix."
      );
    const path = key.slice((this.s3Config.remotePrefix ?? "").length);
    const expected = this.versions.get(path);
    if (!this.ready || !expected)
      throw new PersonalSyncError("Complete an S3 inventory before reading.");
    try {
      this.check();
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: this.s3Config.s3BucketName,
          Key: key,
          IfMatch: expected,
        })
      );
      this.check();
      if (etag(response.ETag) !== expected)
        throw new PersonalSyncError(
          "S3 returned a different object version. Preview again."
        );
      if (!response.Body)
        throw new PersonalSyncError("S3 returned an incomplete object.");
      const bytes = await response.Body.transformToByteArray();
      this.check();
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
    } catch (error) {
      return failure(error);
    }
  }
  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number
  ): Promise<Entity> {
    if (!this.ready)
      throw new PersonalSyncError("Complete an S3 inventory before writing.");
    const expected = this.versions.get(key);
    try {
      this.check();
      const response = await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.s3Config.s3BucketName,
          Key: `${this.s3Config.remotePrefix ?? ""}${key}`,
          Body: new Uint8Array(content),
          ContentType: "application/octet-stream",
          Metadata: { MTime: `${mtime / 1000}`, CTime: `${ctime / 1000}` },
          ...(expected ? { IfMatch: expected } : { IfNoneMatch: "*" }),
        })
      );
      this.check();
      const version = etag(response.ETag);
      this.versions.set(key, version);
      return {
        key,
        keyRaw: key,
        size: content.byteLength,
        sizeRaw: content.byteLength,
        etag: version,
        mtimeCli: mtime,
        mtimeSvr: mtime,
      };
    } catch (error) {
      return failure(error, true);
    }
  }
}
