// Modified for VaultBridge: bounded worker requests, shared preparation and cleanup.
import { Cipher as CipherRCloneCryptPack, encryptedSize } from "@fyears/rclone-crypt";
// @ts-ignore
import EncryptWorker from "./encryptRClone.worker";
import { WorkerRequests } from "./workerRequests";

export const getSizeFromOrigToEnc = encryptedSize;

export class CipherRclone {
  readonly cipher = new CipherRCloneCryptPack("base64");
  readonly workers: Worker[] = [];
  readonly requests: WorkerRequests;
  init = false;
  workerIdx = 0;
  private preparation?: Promise<void>;
  constructor(readonly password: string, workerNum: number) {
    if (!Number.isInteger(workerNum) || workerNum < 1) throw new Error("Invalid encryption worker count.");
    try {
      for (let i = 0; i < workerNum; i++) this.workers.push(new (EncryptWorker as any)());
      this.requests = new WorkerRequests(this.workers);
    } catch (error) {
      for (const worker of this.workers) worker.terminate();
      throw error;
    }
  }
  closeResources() { this.requests.close(); }
  async prepareByCallingWorker(): Promise<void> {
    this.requests.check();
    if (this.init) return;
    if (!this.preparation) this.preparation = this.prepare();
    await this.preparation;
  }
  private async prepare() {
    try {
      await this.cipher.key(this.password, "");
      this.requests.check();
      await Promise.all(this.workers.map((worker) => this.requests.request(worker, {
        action: "prepare",
        dataKeyBuf: this.cipher.dataKey.buffer,
        nameKeyBuf: this.cipher.nameKey.buffer,
        nameTweakBuf: this.cipher.nameTweak.buffer,
      }, (data) => {
        if (data?.status !== "ok") throw new Error("Encryption preparation failed.");
      })));
      this.requests.check();
      this.init = true;
    } catch (error) {
      this.requests.close();
      throw error;
    }
  }
  private async name(action: string, inputName: string): Promise<string> {
    await this.prepareByCallingWorker();
    const worker = this.workers[++this.workerIdx % this.workers.length];
    return this.requests.request(worker, { action, inputName }, (data) => {
      if (data?.status !== "ok" || typeof data.outputName !== "string") throw new Error("Invalid encryption result.");
      return data.outputName;
    });
  }
  private async content(action: string, input: ArrayBuffer): Promise<ArrayBuffer> {
    await this.prepareByCallingWorker();
    const worker = this.workers[++this.workerIdx % this.workers.length];
    return this.requests.request(worker, { action, inputContent: input }, (data) => {
      if (data?.status !== "ok" || !(data.outputContent instanceof ArrayBuffer)) throw new Error("Invalid encryption result.");
      return data.outputContent;
    }, action === "decryptContent" ? [input] : []);
  }
  encryptNameByCallingWorker(input: string) { return this.name("encryptName", input); }
  decryptNameByCallingWorker(input: string) { return this.name("decryptName", input); }
  encryptContentByCallingWorker(input: ArrayBuffer) { return this.content("encryptContent", input); }
  decryptContentByCallingWorker(input: ArrayBuffer) { return this.content("decryptContent", input); }
}
