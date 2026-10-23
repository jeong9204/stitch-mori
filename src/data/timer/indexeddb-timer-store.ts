import {validateTimerImport,type TimerImportSnapshot,type TimerImportReceipt,type TimerImportSession} from "../../domain/timer/imports";
import { applyTimeAdjustment,effectiveWorkTime,type AdjustmentCommand,type AdjustmentSnapshot,type AdjustmentResult,type TimeAdjustment } from "../../domain/timer/adjustments";
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
      const request = indexedDB.open(this.name,3);
      request.onupgradeneeded = () => {
        const db = request.result;
        if(!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "sessionId" });
        sessions.createIndex("workItemId","workItemId");
        const events = db.createObjectStore("events", { keyPath: "eventId" });
        events.createIndex("sessionId","command.sessionId");
        db.createObjectStore("meta", { keyPath: "key" });
        db.createObjectStore("server_pending", { keyPath: "userId" });
        }
        if(!db.objectStoreNames.contains("adjustments")) {
          const adjustments=db.createObjectStore("adjustments",{keyPath:"adjustmentId"});
          adjustments.createIndex("sessionId","sessionId");adjustments.createIndex("commandId","commandId",{unique:true});
        }
        if(!db.objectStoreNames.contains("adjustment_pending"))db.createObjectStore("adjustment_pending",{keyPath:"key"});
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
      if((await result(meta.get(`ui:timer-import:${command.workItemId}`)))?.value?.pending)throw new Error("타이머 가져오기 요청을 먼저 완료해 주세요.");
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
    return this.transaction(["sessions","events","meta","adjustments"],"readonly",async tx=>({
      states:await result(tx.objectStore("sessions").getAll()) as WorkSession[],
      adjustments:await result(tx.objectStore("adjustments").getAll()) as TimeAdjustment[],
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
  async adjustmentSnapshot(sessionId:string):Promise<AdjustmentSnapshot> {
    return this.transaction(["sessions","adjustments","meta"],"readonly",async tx=>{
      const session=await result(tx.objectStore("sessions").get(sessionId)) as WorkSession|undefined;
      if(!session)throw new Error("작업 세션을 찾을 수 없습니다.");
      const adjustments=(await result(tx.objectStore("adjustments").index("sessionId").getAll(sessionId)) as TimeAdjustment[]).sort((a,b)=>a.revision-b.revision);
      return {session,adjustments,effectiveMs:effectiveWorkTime(session,adjustments),revision:adjustments.length,canAdjust:session.status==="ended" && !(await result(tx.objectStore("meta").get(`ui:timer-import:${session.workItemId}`)))?.value?.sources?.includes(sessionId) && !(await result(tx.objectStore("meta").get(`ui:timer-import:${session.workItemId}`)))?.value?.pending};
    });
  }
  async allPendingAdjustments(scope:string):Promise<AdjustmentCommand[]> {
    return this.transaction(["adjustment_pending"],"readonly",async tx=>{
      const rows=await result(tx.objectStore("adjustment_pending").getAll()) as {key:string;command:AdjustmentCommand}[];
      return rows.filter(row=>row.key.startsWith(`${scope}:`)).map(row=>row.command);
    });
  }
  async pendingAdjustment(scope:string,sessionId:string):Promise<AdjustmentCommand|null> {
    return this.transaction(["adjustment_pending"],"readonly",async tx=>(await result(tx.objectStore("adjustment_pending").get(`${scope}:${sessionId}`)))?.command??null);
  }
  async retainAdjustment(scope:string,command:AdjustmentCommand):Promise<void> {
    await this.transaction(["adjustment_pending"],"readwrite",async tx=>{
      const store=tx.objectStore("adjustment_pending"),key=`${scope}:${command.sessionId}`,old=await result(store.get(key));
      if(old && JSON.stringify(old.command)!==JSON.stringify(command))throw new Error("보관된 정정 요청을 먼저 확인해 주세요.");
      store.put({key,command:structuredClone(command)});
    });
  }
  async releaseAdjustment(scope:string,sessionId:string,requestId:string):Promise<void> {
    await this.transaction(["adjustment_pending"],"readwrite",async tx=>{
      const store=tx.objectStore("adjustment_pending"),key=`${scope}:${sessionId}`,old=await result(store.get(key));
      if(old && old.command.requestId!==requestId)throw new Error("정정 요청 ID가 일치하지 않습니다.");store.delete(key);
    });
  }
  async applyLocalAdjustment(command:AdjustmentCommand,at=new Date().toISOString()):Promise<AdjustmentResult> {
    return this.transaction(["sessions","adjustments","adjustment_pending","meta"],"readwrite",async tx=>{
      const session=await result(tx.objectStore("sessions").get(command.sessionId)) as WorkSession|undefined;
      if(!session)return {status:"rejected",reason:"session_not_found"};
      const imported=(await result(tx.objectStore("meta").get(`ui:timer-import:${session.workItemId}`)))?.value;
      if(imported?.pending || imported?.sources?.includes(session.sessionId))throw new Error("가져오기 중이거나 계정에 보관한 세션입니다. 계정 기록에서 정정해 주세요.");
      const adjustments=tx.objectStore("adjustments"),history=await result(adjustments.getAll()) as TimeAdjustment[];
      const applied=applyTimeAdjustment(session,history,command,at);
      if(applied.status==="applied" || applied.status==="duplicate") {
        if(applied.status==="applied")adjustments.add(applied.adjustment);
        const store=tx.objectStore("adjustment_pending"),key=`local:${command.sessionId}`,old=await result(store.get(key));
        if(old && old.command.requestId!==command.requestId)throw new Error("보관된 정정 요청이 다릅니다.");store.delete(key);
      }return applied;
    });
  }
  async freezeTimerImport(userId:string,localWorkItemId:string,counterImportId:string):Promise<TimerImportSnapshot> {
    return this.transaction(["sessions","events","adjustments","adjustment_pending","meta","server_pending"],"readwrite",async tx=>{
      const meta=tx.objectStore("meta"),key=`ui:timer-import:${localWorkItemId}`,old=(await result(meta.get(key)))?.value;
      if(old && old.userId!==userId)throw new Error("다른 계정에 연결된 로컬 타이머 기록입니다.");
      if(old?.pending)return old.pending;
      if(await result(meta.get("local_pending")) || await result(tx.objectStore("server_pending").get(userId)))throw new Error("미확정 타이머 명령을 먼저 처리해 주세요.");
      const pending=await result(tx.objectStore("adjustment_pending").getAll()) as {key:string}[];
      if(pending.some(p=>p.key.startsWith("local:")||p.key.startsWith(`account:${userId}:`)))throw new Error("미확정 시간 정정을 먼저 처리해 주세요.");
      const states=await result(tx.objectStore("sessions").index("workItemId").getAll(localWorkItemId)) as WorkSession[];
      if(states.some(s=>s.status!=="ended"))throw new Error("실행 중·일시정지 세션을 먼저 종료해 주세요.");
      const sessions:TimerImportSession[]=[];
      for(const state of states.filter(s=>!old?.sources?.includes(s.sessionId)).sort((a,b)=>a.startedAt.localeCompare(b.startedAt))){
        const events=(await result(tx.objectStore("events").index("sessionId").getAll(state.sessionId)) as TimerEvent[]).sort((a,b)=>a.after.revision-b.after.revision);
        const adjustments=(await result(tx.objectStore("adjustments").index("sessionId").getAll(state.sessionId)) as TimeAdjustment[]).sort((a,b)=>a.revision-b.revision);
        const bundle={state,events,adjustments};validateTimerImport(bundle,localWorkItemId);sessions.push(bundle);
      }
      if(!sessions.length)throw new Error("새로 가져올 종료 세션이 없습니다.");
      if(sessions.length>50||sessions.reduce((n,s)=>n+s.events.length+s.adjustments.length,0)>5000)throw new Error("한 번에 50개 세션·5000개 이력까지 가져올 수 있습니다.");
      const snapshot={importId:crypto.randomUUID(),counterImportId,localWorkItemId,sessions};
      meta.put({key,value:{...old,userId,pending:snapshot,sources:old?.sources??[]}});return snapshot;
    });
  }
  async finishTimerImport(userId:string,snapshot:TimerImportSnapshot,receipt:TimerImportReceipt):Promise<void>{
    await this.transaction(["meta","sessions","events","adjustments"],"readwrite",async tx=>{
      const meta=tx.objectStore("meta"),key=`ui:timer-import:${snapshot.localWorkItemId}`,old=(await result(meta.get(key)))?.value;
      if(old?.userId!==userId || old.pending?.importId!==snapshot.importId || receipt.importId!==snapshot.importId || receipt.mappings.length!==snapshot.sessions.length || snapshot.sessions.some(s=>!receipt.mappings.some(m=>m.localSessionId===s.state.sessionId)))throw new Error("타이머 가져오기 영수증이 일치하지 않습니다.");
      for(const bundle of snapshot.sessions){
        const state=await result(tx.objectStore("sessions").get(bundle.state.sessionId));
        const events=(await result(tx.objectStore("events").index("sessionId").getAll(bundle.state.sessionId)) as TimerEvent[]).sort((a,b)=>a.after.revision-b.after.revision);
        const adjustments=(await result(tx.objectStore("adjustments").index("sessionId").getAll(bundle.state.sessionId)) as TimeAdjustment[]).sort((a,b)=>a.revision-b.revision);
        if(JSON.stringify({state,events,adjustments})!==JSON.stringify(bundle))throw new Error("스냅샷 생성 후 로컬 원본이 달라졌습니다. 원본과 요청을 보존했습니다. 계정에 보관된 스냅샷을 먼저 확인해 주세요.");
      }
      meta.put({key,value:{userId,pending:null,sources:[...new Set([...(old.sources??[]),...receipt.mappings.map(m=>m.localSessionId)])],mappings:[...(old.mappings??[]),...receipt.mappings],receipt}});
    });
  }
  async close(): Promise<void> { if (this.dbPromise) (await this.dbPromise).close(); this.dbPromise = null; }
}
