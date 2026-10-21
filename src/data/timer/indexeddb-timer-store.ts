import { applyTimerCommand, sameTimerCommand } from "../../domain/timer/engine";
import type { TimerCommand, TimerEvent, TimerResult, WorkSession } from "../../domain/timer/types";

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve,reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve,reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("timer_storage_aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("timer_storage_failed"));
  });
}
export type PendingTimerCommand = { userId: string; command: TimerCommand };
/** Separate DB: never upgrades or writes the quick-counter or counter-outbox databases. */
export class IndexedDbTimerStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  constructor(private readonly name = "stitchmori-timers-v1") {}
  private database(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = new Promise<IDBDatabase>((resolve,reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB_unavailable")); return; }
      const request = indexedDB.open(this.name,1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const sessions = db.createObjectStore("sessions", { keyPath: "sessionId" });
        sessions.createIndex("workItemId","workItemId");
        const events = db.createObjectStore("events", { keyPath: "eventId" });
        events.createIndex("sessionId","command.sessionId");
        db.createObjectStore("meta", { keyPath: "key" });
        db.createObjectStore("server_pending", { keyPath: "userId" });
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("timer_storage_blocked"));
    }).catch(error => { this.dbPromise = null; throw error; });
    return this.dbPromise;
  }
  private async transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.database(), tx = db.transaction(stores,mode), finished = complete(tx);
    // Observe abort/error immediately, including failures raised while awaiting a request.
    void finished.catch(() => undefined);
    try { const value = await run(tx); await finished; return value; }
    catch (error) { try { tx.abort(); } catch { /* Already completed/aborted. */ } throw error; }
  }
  async applyLocal(command: TimerCommand): Promise<TimerResult> {
    return this.transaction(["sessions","events","meta"],"readwrite", async tx => {
      const sessions = tx.objectStore("sessions"), events = tx.objectStore("events"), meta = tx.objectStore("meta");
      const duplicate = await result(events.get(command.commandId)) as TimerEvent | undefined;
      const state = await result(sessions.get(command.sessionId)) as WorkSession | undefined;
      const active = await result(meta.get("active")) as { value: string } | undefined;
      if (!duplicate && command.action === "start" && active && active.value !== command.sessionId) return { status: "rejected", reason: "active_session_exists" };
      const applied = applyTimerCommand(state ?? null, duplicate ? [duplicate] : [], command);
      if (applied.status === "applied") {
        const event: TimerEvent = { eventId: command.commandId, command: structuredClone(command), effectiveAt: applied.state.updatedAt,
          before: state ?? null, after: applied.state };
        sessions.put(applied.state); events.add(event);
        if (applied.state.status === "ended") meta.delete("active");
        else meta.put({ key: "active", value: command.sessionId });
      }
      return applied;
    });
  }
  async getLocal(sessionId: string): Promise<{ state: WorkSession | null; events: TimerEvent[] }> {
    return this.transaction(["sessions","events"],"readonly",async tx => {
      const state = await result(tx.objectStore("sessions").get(sessionId)) as WorkSession | undefined;
      const events = await result(tx.objectStore("events").index("sessionId").getAll(sessionId)) as TimerEvent[];
      return { state: state ?? null, events: events.sort((a,b) => a.after.revision-b.after.revision) };
    });
  }
  async activeLocal(): Promise<WorkSession | null> {
    return this.transaction(["sessions","meta"],"readonly",async tx => {
      const pointer = await result(tx.objectStore("meta").get("active")) as { value: string } | undefined;
      if (!pointer) return null;
      const state = await result(tx.objectStore("sessions").get(pointer.value)) as WorkSession | undefined;
      if (!state || state.status === "ended") throw new Error("timer_active_pointer_corrupt");
      return state;
    });
  }
  async localHistory(workItemId: string): Promise<WorkSession[]> {
    return this.transaction(["sessions"],"readonly",tx => result(tx.objectStore("sessions").index("workItemId").getAll(workItemId)));
  }
  async pending(userId: string): Promise<PendingTimerCommand | null> {
    return this.transaction(["server_pending"],"readonly",async tx => (await result(tx.objectStore("server_pending").get(userId))) ?? null);
  }
  async retain(userId: string, command: TimerCommand): Promise<void> {
    await this.transaction(["server_pending"],"readwrite",async tx => {
      const store = tx.objectStore("server_pending"), old = await result(store.get(userId)) as PendingTimerCommand | undefined;
      if (old && !sameTimerCommand(old.command,command)) throw new Error("pending_timer_command_requires_resolution");
      store.put({ userId, command: structuredClone(command) });
    });
  }
  /** Called after acknowledgement, or a future explicit user decision. Never clears another command. */
  async release(userId: string, commandId: string): Promise<void> {
    await this.transaction(["server_pending"],"readwrite",async tx => {
      const store = tx.objectStore("server_pending"), old = await result(store.get(userId)) as PendingTimerCommand | undefined;
      if (old && old.command.commandId !== commandId) throw new Error("pending_timer_command_mismatch");
      store.delete(userId);
    });
  }
  async readUi<T>(key: string): Promise<T | null> {
    return this.transaction(["meta"],"readonly",async tx => (await result(tx.objectStore("meta").get(`ui:${key}`)))?.value ?? null);
  }
  async writeUi<T>(key: string, value: T): Promise<void> {
    await this.transaction(["meta"],"readwrite",async tx => { tx.objectStore("meta").put({ key: `ui:${key}`, value }); });
  }
  async retainLocal(command: TimerCommand): Promise<void> {
    await this.transaction(["meta"],"readwrite",async tx => {
      const store=tx.objectStore("meta"), old=await result(store.get("local_pending")) as { value: TimerCommand } | undefined;
      if (old && !sameTimerCommand(old.value,command)) throw new Error("pending_timer_command_requires_resolution");
      store.put({ key: "local_pending", value: command });
    });
  }
  async pendingLocal(): Promise<TimerCommand | null> {
    return this.transaction(["meta"],"readonly",async tx => (await result(tx.objectStore("meta").get("local_pending")))?.value ?? null);
  }
  async releaseLocal(commandId: string): Promise<void> {
    await this.transaction(["meta"],"readwrite",async tx => {
      const store=tx.objectStore("meta"), old=await result(store.get("local_pending")) as { value: TimerCommand } | undefined;
      if (old && old.value.commandId!==commandId) throw new Error("pending_timer_command_mismatch");
      store.delete("local_pending");
    });
  }
  async localStatisticsSource() {
    return this.transaction(["sessions","events","meta"],"readonly",async tx=>({
      states:await result(tx.objectStore("sessions").getAll()) as WorkSession[],
      events:await result(tx.objectStore("events").getAll()) as TimerEvent[],
      pending:(await result(tx.objectStore("meta").get("local_pending")))?.value as TimerCommand | undefined,
    }));
  }
  async updateUi<T>(key:string,update:(current:T|null)=>T):Promise<T> {
    return this.transaction(["meta"],"readwrite",async tx=>{
      const store=tx.objectStore("meta"),current=(await result(store.get(`ui:${key}`)))?.value ?? null;
      const value=update(current);store.put({key:`ui:${key}`,value});return value;
    });
  }
  async close(): Promise<void> { if (this.dbPromise) (await this.dbPromise).close(); this.dbPromise = null; }
}
