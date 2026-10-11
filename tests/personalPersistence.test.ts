import { strict as assert } from "node:assert";
import { SaveQueue } from "../personal/saveQueue";
import { harness } from "./helpers/vaultBridgeHarness";

describe("Serialized settings snapshots", () => {
  it("saves in call order with immutable nested snapshots while the first save is delayed", async () => {
    const queue = new SaveQueue(),
      writes: unknown[] = [];
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const input = { settings: { root: "first" } };
    const first = queue.enqueue(input, async (snapshot) => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      writes.push(snapshot);
    });
    await started;
    input.settings.root = "second";
    const second = queue.enqueue(input, async (snapshot) => {
      writes.push(snapshot);
    });
    input.settings.root = "third";
    await Promise.resolve();
    assert.equal(writes.length, 0);
    finish();
    await Promise.all([first, second]);
    assert.deepEqual(writes, [
      { settings: { root: "first" } },
      { settings: { root: "second" } },
    ]);
  });
  it("reports a failed save to its caller and continues later saves", async () => {
    const queue = new SaveQueue(),
      writes: number[] = [];
    const failed = assert.rejects(
      queue.enqueue(1, async () => {
        throw Error("failed");
      }),
      /failed/
    );
    const next = queue.enqueue(2, async (snapshot) => {
      writes.push(snapshot);
    });
    await failed;
    await next;
    assert.deepEqual(writes, [2]);
  });
  it("serializes the actual plugin's saves and never snapshots session passwords", async () => {
    const h = harness("session-secret");
    let finish!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const snapshots: unknown[] = [];
    h.plugin.saveData = async (snapshot) => {
      if (!snapshots.length) {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      snapshots.push(snapshot);
    };
    h.plugin.state.settings.s3.remotePrefix = "first/";
    h.plugin.state.settings.password = "session-secret";
    const first = h.plugin.persist();
    await started;
    h.plugin.state.settings.s3.remotePrefix = "second/";
    const second = h.plugin.persist();
    finish();
    await Promise.all([first, second]);
    assert.deepEqual(
      snapshots.map((s: any) => s.settings.s3.remotePrefix),
      ["first/", "second/"]
    );
    assert.ok(!JSON.stringify(snapshots).includes("session-secret"));
  });
});
