// SPDX-License-Identifier: Apache-2.0
// VaultBridge modification: bounded requests and deterministic worker cleanup.
export class WorkerRequests {
  private closed = false;
  private pending = new Set<(error: Error) => void>();
  constructor(readonly workers: Worker[], readonly timeoutMs = 120000) {
    for (const worker of workers) {
      worker.onerror = () => this.close(new Error("Encryption worker failed."));
      worker.onmessageerror = () => this.close(new Error("Encryption worker communication failed."));
    }
  }
  check() {
    if (this.closed) throw new Error("Encryption workers are closed.");
  }
  close(error = new Error("Encryption operation stopped.")) {
    if (this.closed) return;
    this.closed = true;
    for (const reject of [...this.pending]) reject(error);
    for (const worker of this.workers) {
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    }
  }
  request<T>(worker: Worker, message: unknown, decode: (data: any) => T,
    buffers: Transferable[] = []): Promise<T> {
    this.check();
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pending.delete(fail);
        channel.port2.onmessage = null;
        channel.port2.onmessageerror = null;
        channel.port1.close();
        channel.port2.close();
        if (error) reject(error); else resolve(value!);
      };
      const fail = (error: Error) => finish(error);
      const timer = setTimeout(() => this.close(new Error("Encryption worker timed out.")), this.timeoutMs);
      this.pending.add(fail);
      channel.port2.onmessage = (event) => {
        try { finish(undefined, decode(event.data)); }
        catch { finish(new Error("Encryption worker returned an invalid result.")); }
      };
      channel.port2.onmessageerror = () => this.close(new Error("Encryption worker communication failed."));
      try { worker.postMessage(message, [channel.port1, ...buffers]); }
      catch { this.close(new Error("Encryption worker request failed.")); }
    });
  }
}
