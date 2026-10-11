// SPDX-License-Identifier: Apache-2.0
import { PersonalSyncError } from "./errors";
import type { Store } from "./engine";

// Cancellation is cooperative: a native HTTP request or write already sent
// cannot be recalled. Keep the run locked until that operation settles.
export class SyncRun {
  cancelled = false;
  cancel() {
    this.cancelled = true;
  }
  check() {
    if (this.cancelled)
      throw new PersonalSyncError(
        "Sync cancelled. Preview again before continuing."
      );
  }
  async step<T>(operation: () => Promise<T>): Promise<T> {
    this.check();
    const result = await operation();
    this.check();
    return result;
  }
  store(store: Store): Store {
    return {
      list: () => this.step(() => store.list()),
      read: (path) => this.step(() => store.read(path)),
      write: (path, bytes, expected) =>
        this.step(() => store.write(path, bytes, expected)),
    };
  }
}
