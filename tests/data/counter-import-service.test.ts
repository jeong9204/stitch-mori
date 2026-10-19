import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { CounterImportService } from "../../src/data/import/import-service";
import type { ImportedWorkItem, LocalImportSnapshot } from "../../src/data/import/types";
import { IndexedDbCounterStore } from "../../src/data/local/indexeddb-counter-store";
import { QuickCounterSession } from "../../src/data/local/quick-counter-session";
import { initialCounterState } from "../../src/domain/counter/engine";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverWorkItemId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function local() { return new IndexedDbCounterStore(`stitchmori-import-test-${crypto.randomUUID()}`); }

async function savedRecord(store: IndexedDbCounterStore) {
  const session = new QuickCounterSession(store);
  await session.load();
  session.enqueue({ type: "change", counter: "stitch", delta: 1 });
  await session.whenSettled();
  session.enqueue({ type: "setTarget", counter: "stitch", value: 8 });
  await session.whenSettled();
  session.enqueue({ type: "completeRow", stitch: "reset" });
  await session.whenSettled();
  const target = session.getSnapshot().events.at(-1)!;
  session.enqueue({ type: "undo", eventId: target.eventId });
  await session.whenSettled();
  return (await store.getQuickIfExists())!;
}

function receipt(snapshot: LocalImportSnapshot, status: ImportedWorkItem["status"] = "imported"): ImportedWorkItem {
  return { status, importId: snapshot.importId, localWorkItemId: snapshot.localWorkItemId, serverWorkItemId, importedRevision: snapshot.state.revision };
}

describe("guest counter import", () => {
  it("upgrades the Phase 1A database without losing the existing local work item", async () => {
    const databaseName = `stitchmori-import-upgrade-${crypto.randomUUID()}`;
    const localWorkItemId = crypto.randomUUID();
    const importedId = crypto.randomUUID();
    const opened = indexedDB.open(databaseName, 1);
    opened.onupgradeneeded = () => {
      const db = opened.result;
      db.createObjectStore("work_items", { keyPath: "localWorkItemId" });
      db.createObjectStore("meta", { keyPath: "key" });
      const events = db.createObjectStore("counter_events", { keyPath: "eventId" });
      events.createIndex("workItemId", "workItemId");
      events.createIndex("commandId", "commandId", { unique: true });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { opened.onsuccess = () => resolve(opened.result); opened.onerror = () => reject(opened.error); });
    const tx = db.transaction(["work_items", "meta"], "readwrite");
    tx.objectStore("work_items").add({ localWorkItemId, deviceId: crypto.randomUUID(), state: initialCounterState(localWorkItemId), importId: importedId, importStatus: "local", serverWorkItemId: null, updatedAt: new Date().toISOString() });
    tx.objectStore("meta").add({ key: "quick-work-item", value: localWorkItemId });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    db.close();
    const upgraded = new IndexedDbCounterStore(databaseName);
    expect((await upgraded.getQuickIfExists())?.importId).toBe(importedId);
    expect((await upgraded.beginImport(localWorkItemId)).state.revision).toBe(0);
  });

  it("freezes the saved event chain, blocks writes during import, and keeps later local edits separate", async () => {
    const store = local();
    const record = await savedRecord(store);
    const frozen = await store.beginImport(record.localWorkItemId);
    expect(frozen.state.revision).toBe(4);
    expect(frozen.state.stitch).toEqual({ current: 1, target: 8 });
    expect(frozen.events.map((event) => event.action.type)).toEqual(["change", "setTarget", "completeRow", "undo"]);
    expect(frozen.events[3].action).toEqual({ type: "undo", eventId: frozen.events[2].eventId });
    await expect(store.applyCommand({
      commandId: crypto.randomUUID(), workItemId: record.localWorkItemId, expectedRevision: 4,
      occurredAt: new Date().toISOString(), deviceId: record.deviceId,
      action: { type: "change", counter: "stitch", delta: 1 },
    })).rejects.toThrow("가져오는 동안");
    await store.releaseImport(record.localWorkItemId);
    const session = new QuickCounterSession(store);
    await session.load();
    session.enqueue({ type: "change", counter: "stitch", delta: 1 });
    await session.whenSettled();
    expect((await store.beginImport(record.localWorkItemId)).events).toEqual(frozen.events);
    await store.finishImport(frozen, userId, serverWorkItemId);
    const linked = await store.getQuickIfExists();
    expect(linked?.state.stitch.current).toBe(2);
    expect(linked?.importedRevision).toBe(4);
    expect(linked?.importedByUserId).toBe(userId);
    expect(linked?.serverWorkItemId).toBe(serverWorkItemId);
  });

  it("retries the identical snapshot after a lost server response without deleting the original", async () => {
    const store = local();
    const record = await savedRecord(store);
    const seen: LocalImportSnapshot[] = [];
    const remote = { importSnapshot: vi.fn(async (snapshot: LocalImportSnapshot) => {
      seen.push(snapshot);
      if (seen.length === 1) throw new Error("response lost after commit");
      return receipt(snapshot, "duplicate");
    }) };
    const service = new CounterImportService(store, remote);
    await expect(service.import(record.localWorkItemId, userId)).rejects.toThrow("response lost");
    expect((await store.getQuickIfExists())?.importStatus).toBe("failed");
    expect((await store.getQuickIfExists())?.state).toEqual(record.state);
    expect((await service.import(record.localWorkItemId, userId)).status).toBe("duplicate");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(seen[0]);
    expect((await store.getEvents(record.localWorkItemId))).toHaveLength(4);
    expect((await store.getQuickIfExists())?.importStatus).toBe("imported");
    await expect(service.import(record.localWorkItemId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc")).rejects.toThrow("다른 계정");
  });

  it("does not contact the server when local snapshot creation fails", async () => {
    const store = local();
    const record = await savedRecord(store);
    const remote = { importSnapshot: vi.fn(async (snapshot: LocalImportSnapshot) => receipt(snapshot)) };
    vi.spyOn(store, "beginImport").mockRejectedValueOnce(new Error("local storage failed"));
    await expect(new CounterImportService(store, remote).import(record.localWorkItemId, userId)).rejects.toThrow("local storage failed");
    expect(remote.importSnapshot).not.toHaveBeenCalled();
  });
});
