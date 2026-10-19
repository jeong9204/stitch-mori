import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { applyCounterCommand, initialCounterState } from "../../src/domain/counter/engine";
import type { CounterCommand, CounterEvent, CounterState } from "../../src/domain/counter/types";
import { IndexedDbServerCommandQueue } from "../../src/data/remote/server-command-queue";
import { ServerCounterSession } from "../../src/data/remote/server-counter-session";
import type { RemoteCounterStore, RemoteCounterCommandResult } from "../../src/data/remote/types";

const workItemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const plus = { type: "change" as const, counter: "stitch" as const, delta: 1 as const };

class MemoryRemote implements RemoteCounterStore {
  state: CounterState = initialCounterState(workItemId);
  events: CounterEvent[] = [];
  commands: CounterCommand[] = [];
  loseNextResponse = false;
  gate: Promise<void> | null = null;

  async createWorkItem() { return this.state; }
  async getWorkItem(id: string) { return id === workItemId ? this.state : null; }
  async getEvents(id: string) { return id === workItemId ? [...this.events] : []; }
  async applyCommand(command: CounterCommand): Promise<RemoteCounterCommandResult> {
    this.commands.push(command);
    if (this.gate) await this.gate;
    const existing = this.events.find((event) => event.commandId === command.commandId);
    if (existing) return { status: "duplicate", state: existing.after, eventId: existing.eventId,
      revision: existing.after.revision, latestRevision: this.state.revision };
    const result = applyCounterCommand(this.state, this.events, command);
    if (result.status === "conflict") return { status: "conflict", current: this.state, latestRevision: this.state.revision };
    if (result.status === "rejected" || !result.event) return { status: "rejected", reason: result.status === "rejected" ? result.reason : "invalid" };
    this.state = result.state;
    this.events.push(result.event);
    if (this.loseNextResponse) { this.loseNextResponse = false; throw new Error("response lost"); }
    return { status: "applied", state: result.state, eventId: result.eventId,
      revision: result.state.revision, latestRevision: result.state.revision };
  }
}

function fixture() {
  const name = `server-queue-test-${crypto.randomUUID()}`;
  const queue = new IndexedDbServerCommandQueue(name);
  const remote = new MemoryRemote();
  const session = new ServerCounterSession(userId, workItemId, remote, queue, async () => true);
  return { name, queue, remote, session };
}

describe("server counter durable command queue", () => {
  it("keeps rapid input ordered and persists every command before its RPC", async () => {
    const { queue, remote, session } = fixture();
    let release!: () => void;
    remote.gate = new Promise<void>((resolve) => { release = resolve; });
    await session.load();
    expect((await Promise.all(Array.from({ length: 12 }, () => session.enqueue(plus)))).every(Boolean)).toBe(true);
    expect(session.getSnapshot().display?.stitch.current).toBe(12);
    expect((await queue.pending(userId, workItemId))).toHaveLength(12);
    expect(remote.commands).toHaveLength(1);
    release();
    await session.whenSettled();
    expect(remote.state.stitch.current).toBe(12);
    expect(remote.events.map((event) => event.after.revision)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await queue.pending(userId, workItemId)).toHaveLength(0);
    expect(session.getSnapshot().status).toBe("saved");
  });

  it("recovers the same command after server success and lost response, including after a new session opens", async () => {
    const { name, queue, remote, session } = fixture();
    await session.load();
    remote.loseNextResponse = true;
    expect(await session.enqueue(plus)).toBe(true);
    await session.whenSettled();
    expect(session.getSnapshot().status).toBe("failed");
    const pending = await queue.pending(userId, workItemId);
    expect(pending).toHaveLength(1);
    session.dispose();
    const reopened = new ServerCounterSession(userId, workItemId, remote, new IndexedDbServerCommandQueue(name), async () => true);
    await reopened.load();
    await reopened.whenSettled();
    expect(remote.state.stitch.current).toBe(1);
    expect(remote.events).toHaveLength(1);
    expect(remote.commands[0].commandId).toBe(remote.commands[1].commandId);
    expect(reopened.getSnapshot().status).toBe("saved");
    expect(await queue.pending(userId, workItemId)).toHaveLength(0);
  });

  it("preserves conflicting commands when another device changed the revision", async () => {
    const { queue, remote, session } = fixture();
    await session.load();
    await remote.applyCommand({ commandId: crypto.randomUUID(), workItemId, expectedRevision: 0,
      occurredAt: new Date().toISOString(), deviceId: "other-device", action: plus });
    expect(await session.enqueue(plus)).toBe(true);
    await session.whenSettled();
    expect(session.getSnapshot().status).toBe("conflict");
    expect(session.getSnapshot().confirmed?.stitch.current).toBe(1);
    expect(remote.state.stitch.current).toBe(1);
    expect(await queue.pending(userId, workItemId)).toHaveLength(1);
    await session.refreshConflict();
    expect(await queue.pending(userId, workItemId)).toHaveLength(1);
    await session.discardPending();
    expect(await queue.pending(userId, workItemId)).toHaveLength(0);
    expect(await session.enqueue(plus)).toBe(true);
    await session.whenSettled();
    expect(remote.state.stitch.current).toBe(2);
  });

  it("keeps pending commands separated by account and refuses to send after an account switch", async () => {
    const { queue, remote } = fixture();
    const command: CounterCommand = { commandId: crypto.randomUUID(), workItemId, expectedRevision: 0,
      occurredAt: new Date().toISOString(), deviceId: "local-device", action: plus };
    await queue.add(userId, workItemId, command);
    expect(await queue.pending("cccccccc-cccc-4ccc-8ccc-cccccccccccc", workItemId)).toHaveLength(0);
    const session = new ServerCounterSession(userId, workItemId, remote, queue, async () => false);
    await session.load();
    expect(session.getSnapshot().status).toBe("failed");
    expect(remote.commands).toHaveLength(0);
    expect(await queue.pending(userId, workItemId)).toHaveLength(1);
  });

  it("keeps durable part queues separated by work item within one project account", async () => {
    const { queue } = fixture();
    const sleeveId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const makeCommand = (id: string): CounterCommand => ({ commandId: crypto.randomUUID(), workItemId: id,
      expectedRevision: 0, occurredAt: new Date().toISOString(), deviceId: "parts-device", action: plus });
    await queue.add(userId, workItemId, makeCommand(workItemId));
    await queue.add(userId, sleeveId, makeCommand(sleeveId));
    expect((await queue.pending(userId, workItemId)).map(item => item.workItemId)).toEqual([workItemId]);
    expect((await queue.pending(userId, sleeveId)).map(item => item.workItemId)).toEqual([sleeveId]);
    await queue.clear(userId, workItemId);
    expect(await queue.pending(userId, sleeveId)).toHaveLength(1);
  });

  it("applies row completion, targets, direct edits, and undo through the same RPC contract", async () => {
    const { remote, session } = fixture();
    await session.load();
    await session.enqueue({ type: "setTarget", counter: "stitch", value: 12 });
    await session.enqueue({ type: "setValue", counter: "stitch", value: 7 });
    await session.enqueue({ type: "completeRow", stitch: "reset" });
    await session.whenSettled();
    expect(remote.state.stitch).toEqual({ current: 0, target: 12 });
    expect(remote.state.row.current).toBe(1);
    const completed = remote.events.at(-1)!;
    await session.enqueue({ type: "undo", eventId: completed.eventId });
    await session.whenSettled();
    expect(remote.state.stitch).toEqual({ current: 7, target: 12 });
    expect(remote.state.row.current).toBe(0);
    await session.enqueue({ type: "completeRow", stitch: "keep" });
    await session.whenSettled();
    expect(remote.state.stitch.current).toBe(7);
    expect(remote.state.row.current).toBe(1);
    expect(remote.events.map((event) => event.commandId)).toEqual(remote.commands.map((command) => command.commandId));
  });

  it("does not call the RPC when the durable queue write fails", async () => {
    const { remote, session } = fixture();
    await session.load();
    const original = IDBObjectStore.prototype.add;
    const failure = vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "commands") throw new DOMException("No space", "QuotaExceededError");
      return original.call(this, value, key);
    });
    try { expect(await session.enqueue(plus)).toBe(false); } finally { failure.mockRestore(); }
    expect(remote.commands).toHaveLength(0);
    expect(session.getSnapshot().display?.stitch.current).toBe(0);
    expect(session.getSnapshot().status).toBe("failed");
    expect(session.getSnapshot().error).toContain("서버에 전송되지 않았습니다");
  });
});
