import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { IndexedDbTimerStore } from "../../src/data/timer/indexeddb-timer-store";
import { ServerTimerCommands, SupabaseTimerStore, type TimerRemoteStore } from "../../src/data/timer/server-timer-store";
import { elapsedMilliseconds } from "../../src/domain/timer/engine";
import type { TimerCommand, TimerResult } from "../../src/domain/timer/types";
const at="2026-10-20T14:00:00.000Z";
const cmd=(action: TimerCommand["action"]="start", revision=0, sessionId=crypto.randomUUID()): TimerCommand => ({ action, expectedRevision: revision,
  sessionId, commandId: crypto.randomUUID(), workItemId: crypto.randomUUID(), deviceId: "device", occurredAt: at });
const db=()=>new IndexedDbTimerStore(`timer-test-${crypto.randomUUID()}`);

describe("local timer persistence", () => {
  it("restores running state, active pointer, events, and elapsed time after closing and reopening", async () => {
    const name=`timer-${crypto.randomUUID()}`, store=new IndexedDbTimerStore(name), command=cmd();
    expect((await store.applyLocal(command)).status).toBe("applied"); await store.close();
    const reopened=new IndexedDbTimerStore(name), active=await reopened.activeLocal();
    expect(active?.sessionId).toBe(command.sessionId);
    expect(elapsedMilliseconds(active!,"2026-10-20T15:00:00Z")).toBe(3600000);
    expect((await reopened.getLocal(command.sessionId)).events).toHaveLength(1);
  });
  it("serializes concurrent cross-tab starts, including different work items", async () => {
    const name=`timer-${crypto.randomUUID()}`, a=new IndexedDbTimerStore(name), b=new IndexedDbTimerStore(name);
    const results=await Promise.all([a.applyLocal(cmd()),b.applyLocal(cmd())]);
    expect(results.filter(r=>r.status==="applied")).toHaveLength(1);
    expect(results.find(r=>r.status==="rejected")).toMatchObject({ reason: "active_session_exists" });
  });
  it("keeps paused sessions active; part selection does not relocate a session; end frees the slot", async () => {
    const store=db(), first=cmd(); await store.applyLocal(first);
    const pause={ ...first, commandId: crypto.randomUUID(), action: "pause" as const, expectedRevision: 1, occurredAt: "2026-10-20T14:30:00Z" };
    await store.applyLocal(pause);
    expect((await store.applyLocal(cmd())).status).toBe("rejected");
    expect(await store.localHistory("another-work")).toEqual([]);
    expect((await store.activeLocal())?.workItemId).toBe(first.workItemId);
    await store.applyLocal({ ...pause, commandId: crypto.randomUUID(), action: "end", expectedRevision: 2 });
    expect(await store.activeLocal()).toBeNull(); expect((await store.applyLocal(cmd())).status).toBe("applied");
  });
  it("does not overwrite newer state when replaying a previous event", async () => {
    const store=db(), first=cmd(); await store.applyLocal(first);
    await store.applyLocal({ ...first, commandId: crypto.randomUUID(), expectedRevision: 1, action: "pause" });
    expect((await store.applyLocal(first)).status).toBe("duplicate");
    expect((await store.activeLocal())?.status).toBe("paused");
    expect((await store.getLocal(first.sessionId)).events).toHaveLength(2);
  });
  it("atomically rolls back snapshot, event and active pointer on storage failure, then retries", async () => {
    const store=db(), first=cmd();
    const original=IDBObjectStore.prototype.add;
    const failure=vi.spyOn(IDBObjectStore.prototype,"add").mockImplementation(function(this: IDBObjectStore,value: unknown,key?: IDBValidKey) {
      if (this.name==="events") throw new DOMException("No space","QuotaExceededError");
      return original.call(this,value,key);
    });
    try { await expect(store.applyLocal(first)).rejects.toThrow("No space"); } finally { failure.mockRestore(); }
    expect(await store.activeLocal()).toBeNull(); expect((await store.getLocal(first.sessionId)).state).toBeNull();
    expect((await store.getLocal(first.sessionId)).events).toEqual([]);
    expect((await store.applyLocal(first)).status).toBe("applied");
  });
  it("restores paused/ended states without accruing offline time", async () => {
    const store=db(), first=cmd(); await store.applyLocal(first);
    await store.applyLocal({ ...first, commandId: crypto.randomUUID(), expectedRevision: 1, action: "pause", occurredAt: "2026-10-20T14:10:00Z" });
    expect(elapsedMilliseconds((await store.activeLocal())!,"2026-11-20T14:00:00Z")).toBe(600000);
    await store.applyLocal({ ...first, commandId: crypto.randomUUID(), expectedRevision: 2, action: "resume", occurredAt: "2026-10-20T14:20:00Z" });
    await store.applyLocal({ ...first, commandId: crypto.randomUUID(), expectedRevision: 3, action: "end", occurredAt: "2026-10-20T14:30:00Z" });
    expect(elapsedMilliseconds((await store.getLocal(first.sessionId)).state!,"2026-11-20T14:00:00Z")).toBe(1200000);
  });
});
describe("server timer command recovery", () => {
  it("retains the same envelope on network failure, recovers after reopening, and explicitly retries", async () => {
    const name=`timer-${crypto.randomUUID()}`, store=new IndexedDbTimerStore(name), command=cmd();
    const apply=vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue({ status: "duplicate", state: {}, eventId: command.commandId });
    const remote={ apply, load: vi.fn() } as TimerRemoteStore;
    await expect(new ServerTimerCommands("a",remote,store).submit(command)).rejects.toThrow("lost response");
    await store.close(); const reopened=new IndexedDbTimerStore(name), service=new ServerTimerCommands("a",remote,reopened);
    expect((await service.pending())?.command).toEqual(command); expect(apply).toHaveBeenCalledTimes(1);
    expect((await service.retry()).status).toBe("duplicate"); expect(apply.mock.calls[0]).toEqual(apply.mock.calls[1]);
    expect(await service.pending()).toBeNull();
  });
  it("does not send before durable storage succeeds", async () => {
    const remote={ apply: vi.fn() } as unknown as TimerRemoteStore;
    const service=new ServerTimerCommands("a",remote,{ pending: vi.fn(), release: vi.fn(), retain: vi.fn().mockRejectedValue(new Error("disk full")) });
    await expect(service.submit(cmd())).rejects.toThrow("disk full"); expect(remote.apply).not.toHaveBeenCalled();
  });
  it("preserves conflicts/rejections and blocks new commands without silently rebasing or deleting", async () => {
    for (const result of [{ status: "conflict", current: null },{ status: "rejected", reason: "active_session_exists" }] as TimerResult[]) {
      const store=db(), command=cmd(), remote={ apply: vi.fn().mockResolvedValue(result) } as unknown as TimerRemoteStore;
      const service=new ServerTimerCommands("a",remote,store);
      expect(await service.submit(command)).toEqual(result); expect((await service.pending())?.command).toEqual(command);
      await expect(service.submit(cmd())).rejects.toThrow("requires_resolution");
      expect(remote.apply).toHaveBeenCalledTimes(1);
    }
  });
  it("isolates accounts and only acknowledges the exact pending command", async () => {
    const store=db(), a=cmd(), b=cmd(); await store.retain("a",a); await store.retain("b",b);
    expect((await store.pending("b"))?.command).toEqual(b);
    await expect(store.release("a",b.commandId)).rejects.toThrow("mismatch");
    await store.release("a",a.commandId); expect(await store.pending("a")).toBeNull(); expect(await store.pending("b")).not.toBeNull();
  });
  it("keeps a successfully applied command when saving its acknowledgement fails, then safely retries", async () => {
    const store=db(), command=cmd(), release=vi.spyOn(store,"release").mockRejectedValueOnce(new Error("ack storage failed"));
    const remote={ apply: vi.fn().mockResolvedValueOnce({ status: "applied", state: {}, eventId: command.commandId }).mockResolvedValue({ status: "duplicate", state: {}, eventId: command.commandId }) } as unknown as TimerRemoteStore;
    const service=new ServerTimerCommands("a",remote,store);
    await expect(service.submit(command)).rejects.toThrow("ack storage failed");
    expect((await service.pending())?.command).toEqual(command);
    expect((await service.retry()).status).toBe("duplicate");
    expect(await service.pending()).toBeNull(); expect(release).toHaveBeenCalledTimes(2);
  });
  it("does not acknowledge an invalid or incorrectly scoped RPC response", async () => {
    const getClaims=vi.fn().mockResolvedValue({ data: { claims: { sub: "a" } } });
    const rpc=vi.fn().mockResolvedValue({ data: { status: "applied", state: { userId: "b" } }, error: null });
    const store=db(), command=cmd();
    const remote=new SupabaseTimerStore({ auth: { getClaims }, rpc } as never,"a");
    await expect(new ServerTimerCommands("a",remote,store).submit(command)).rejects.toThrow("invalid_timer_response");
    expect((await store.pending("a"))?.command).toEqual(command);
  });
  it("checks login identity before and after RPC; never returns another account's snapshot", async () => {
    const getClaims=vi.fn().mockResolvedValueOnce({ data: { claims: { sub: "a" } } }).mockResolvedValue({ data: { claims: { sub: "b" } } });
    const rpc=vi.fn().mockResolvedValue({ data: { status: "applied" }, error: null });
    await expect(new SupabaseTimerStore({ auth: { getClaims }, rpc } as never,"a").apply(cmd())).rejects.toThrow("account_changed");
    await expect(new SupabaseTimerStore({ auth: { getClaims }, rpc } as never,"a").load()).rejects.toThrow("account_changed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
