import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { IndexedDbCounterStore } from "../../src/data/local/indexeddb-counter-store";
import { QuickCounterSession } from "../../src/data/local/quick-counter-session";
import { lastCountOccurredAt } from "../../src/domain/counter/engine";
import type { CounterCommand, CounterCommandResult } from "../../src/domain/counter/types";
import type { LocalCounterStore } from "../../src/data/local/types";

function databaseName(): string { return `stitchmori-queue-test-${crypto.randomUUID()}`; }
function stitchPlus() { return { type: "change" as const, counter: "stitch" as const, delta: 1 as const }; }

describe("quick counter input queue", () => {
  it("keeps rapid taps ordered while the first IndexedDB write is pending", async () => {
    const store = new IndexedDbCounterStore(databaseName());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls: CounterCommand[] = [];
    const delayed: LocalCounterStore = {
      getOrCreateQuick: () => store.getOrCreateQuick(),
      getEvents: (id) => store.getEvents(id),
      applyCommand: async (command) => {
        calls.push(command);
        if (calls.length === 1) await gate;
        return store.applyCommand(command);
      },
    };
    let nextId = 0;
    const session = new QuickCounterSession(delayed, () => `command-${++nextId}`, () => "2026-10-18T12:34:56.000Z");
    await session.load();
    for (let i = 0; i < 20; i++) expect(session.enqueue(stitchPlus())).toBe(true);
    expect(session.getSnapshot().record?.state.stitch.current).toBe(20);
    expect(session.getSnapshot().pendingCount).toBe(20);
    expect(session.getSnapshot().status).toBe("pending");
    release();
    await session.whenSettled();
    const saved = await store.getOrCreateQuick();
    const events = await store.getEvents(saved.localWorkItemId);
    expect(saved.state.stitch.current).toBe(20);
    expect(saved.state.revision).toBe(20);
    expect(events.map((event) => event.commandId)).toEqual(Array.from({ length: 20 }, (_, i) => `command-${i + 1}`));
    expect(events.map((event) => event.after.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(calls.map((command) => command.expectedRevision)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(session.getSnapshot().status).toBe("saved");
    expect(session.getSnapshot().pendingCount).toBe(0);
  });

  it("keeps a failed write and later taps in the queue, then retries in order", async () => {
    const store = new IndexedDbCounterStore(databaseName());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    const attemptedIds: string[] = [];
    const unreliable: LocalCounterStore = {
      getOrCreateQuick: () => store.getOrCreateQuick(),
      getEvents: (id) => store.getEvents(id),
      applyCommand: async (command) => {
        attemptedIds.push(command.commandId);
        attempts += 1;
        if (attempts === 1) { await gate; throw new Error("Quota exceeded"); }
        return store.applyCommand(command);
      },
    };
    let nextId = 0;
    const session = new QuickCounterSession(unreliable, () => `retry-${++nextId}`);
    await session.load();
    session.enqueue(stitchPlus());
    session.enqueue(stitchPlus());
    session.enqueue(stitchPlus());
    release();
    await session.whenSettled();
    expect(session.getSnapshot().status).toBe("failed");
    expect(session.getSnapshot().pendingCount).toBe(3);
    expect(session.getSnapshot().record?.state.stitch.current).toBe(3);
    expect(session.getSnapshot().error).toContain("Quota exceeded");
    expect((await store.getOrCreateQuick()).state.stitch.current).toBe(0);
    expect(session.enqueue(stitchPlus())).toBe(false);
    await session.retry();
    expect(attemptedIds).toEqual(["retry-1", "retry-1", "retry-2", "retry-3"]);
    expect((await store.getOrCreateQuick()).state.stitch.current).toBe(3);
    expect(session.getSnapshot().status).toBe("saved");
    expect(session.getSnapshot().pendingCount).toBe(0);
  });

  it("retries safely if IndexedDB committed but its acknowledgment was lost", async () => {
    const store = new IndexedDbCounterStore(databaseName());
    let first = true;
    const uncertain: LocalCounterStore = {
      getOrCreateQuick: () => store.getOrCreateQuick(),
      getEvents: (id) => store.getEvents(id),
      applyCommand: async (command): Promise<CounterCommandResult> => {
        const result = await store.applyCommand(command);
        if (first) { first = false; throw new Error("acknowledgment lost"); }
        return result;
      },
    };
    const session = new QuickCounterSession(uncertain);
    await session.load();
    session.enqueue(stitchPlus());
    await session.whenSettled();
    expect(session.getSnapshot().status).toBe("failed");
    await session.retry();
    const record = await store.getOrCreateQuick();
    expect(record.state.stitch.current).toBe(1);
    expect(await store.getEvents(record.localWorkItemId)).toHaveLength(1);
    expect(session.getSnapshot().status).toBe("saved");
  });

  it("preserves the command timestamp and restores it with the history", async () => {
    const name = databaseName();
    const store = new IndexedDbCounterStore(name);
    const times = ["2026-10-18T12:34:56.000Z", "2026-10-18T12:35:02.000Z", "2026-10-18T12:35:09.000Z"];
    const session = new QuickCounterSession(store, () => crypto.randomUUID(), () => times.shift()!);
    await session.load();
    session.enqueue(stitchPlus());
    await session.whenSettled();
    session.enqueue({ type: "setTarget", counter: "stitch", value: 5 });
    await session.whenSettled();
    const record = await store.getOrCreateQuick();
    expect(lastCountOccurredAt(session.getSnapshot().events)).toBe("2026-10-18T12:34:56.000Z");
    const reopened = new IndexedDbCounterStore(name);
    const restored = new QuickCounterSession(reopened);
    await restored.load();
    expect(restored.getSnapshot().record?.localWorkItemId).toBe(record.localWorkItemId);
    expect(restored.getSnapshot().events.map((event) => event.occurredAt)).toEqual(["2026-10-18T12:34:56.000Z", "2026-10-18T12:35:02.000Z"]);
    expect(lastCountOccurredAt(restored.getSnapshot().events)).toBe("2026-10-18T12:34:56.000Z");
  });
});
