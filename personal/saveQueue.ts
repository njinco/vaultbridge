// SPDX-License-Identifier: Apache-2.0
// Each caller receives its own result. A failed save cannot poison later saves.
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();
  enqueue<T>(value: T, save: (snapshot: T) => Promise<void>): Promise<void> {
    const snapshot = structuredClone(value);
    const result = this.tail.then(() => save(snapshot));
    this.tail = result.catch(() => {});
    return result;
  }
}
