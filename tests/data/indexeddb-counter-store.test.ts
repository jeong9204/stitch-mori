import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbCounterStore } from "../../src/data/local/indexeddb-counter-store";
import type { CounterCommand } from "../../src/domain/counter/types";

function command(workItemId: string, expectedRevision: number, commandId = crypto.randomUUID()): CounterCommand {
  return {
    commandId, workItemId, expectedRevision, occurredAt: new Date().toISOString(), deviceId: "test-device",
    action: { type: "change", counter: "stitch", delta: 1 },
  };
}

function store(): IndexedDbCounterStore {
  return new IndexedDbCounterStore(`stitchmori-test-${crypto.randomUUID()}`);
}

describe("local IndexedDB counter store", () => {
  it("restores the same work item, snapshot, and event after a new store instance opens the database", async () => {
    const databaseName = `stitchmori-test-${crypto.randomUUID()}`;
    const first = new IndexedDbCounterStore(databaseName);
    const record = await first.getOrCreateQuick();
    const applied = await first.applyCommand(command(record.localWorkItemId, 0));
    expect(applied.status).toBe("applied");
    const reopened = new IndexedDbCounterStore(databaseName);
    const restored = await reopened.getOrCreateQuick();
    expect(restored.localWorkItemId).toBe(record.localWorkItemId);
    expect(restored.importId).toBe(record.importId);
    expect(restored.state.stitch.current).toBe(1);
    expect((await reopened.getEvents(record.localWorkItemId))).toHaveLength(1);
  });

  it("does not write a snapshot twice for a repeated command ID", async () => {
    const local = store();
    const record = await local.getOrCreateQuick();
    const same = command(record.localWorkItemId, 0, "same-command");
    expect((await local.applyCommand(same)).status).toBe("applied");
    expect((await local.applyCommand(same)).status).toBe("duplicate");
    expect((await local.getOrCreateQuick()).state.stitch.current).toBe(1);
    expect(await local.getEvents(record.localWorkItemId)).toHaveLength(1);
  });

  it("leaves both snapshot and event unchanged on a failed write, then accepts the same command on retry", async () => {
    const local = store();
    const record = await local.getOrCreateQuick();
    const originalAdd = IDBObjectStore.prototype.add;
    const failure = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "counter_events") throw new DOMException("No space", "QuotaExceededError");
      return originalAdd.call(this, value, key);
    });
    const same = command(record.localWorkItemId, 0, "retry-command");
    try {
      await expect(local.applyCommand(same)).rejects.toThrow("No space");
    } finally {
      failure.mockRestore();
    }
    expect((await local.getOrCreateQuick()).state.stitch.current).toBe(0);
    expect(await local.getEvents(record.localWorkItemId)).toHaveLength(0);
    expect((await local.applyCommand(same)).status).toBe("applied");
    expect((await local.getOrCreateQuick()).state.stitch.current).toBe(1);
  });
});
