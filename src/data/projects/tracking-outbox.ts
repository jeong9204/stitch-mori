import { isPartStatus, isProjectProgress, validateTrackingCommand, type PartStatus, type ProjectProgress, type ProjectTrackingCommand } from "../../domain/project/tracking";

export type TrackingContext = { id: string; revision: number; progressPercent: ProjectProgress; parts: { id: string; status: PartStatus }[] };
export type TrackingDraft = { target: { type: "progress" } | { type: "part"; partId: string }; text: string; unset: boolean; partStatus: PartStatus };
export type TrackingEntry = {
  userId: string; projectId: string; command: ProjectTrackingCommand; draft: TrackingDraft; base: TrackingContext;
  createdAt: string; updatedAt: string; version: number;
  stage: "queued" | "sending" | "waiting" | "conflict" | "confirmed";
  latest: TrackingContext | null; replacesRequestId: string | null;
};
export interface TrackingOutbox {
  read(userId: string, projectId: string): Promise<TrackingEntry | null>;
  list(userId: string): Promise<TrackingEntry[]>;
  reserve(entry: TrackingEntry): Promise<TrackingEntry>;
  update(entry: TrackingEntry, patch: Pick<Partial<TrackingEntry>, "stage" | "latest">): Promise<TrackingEntry>;
  replace(entry: TrackingEntry, next: TrackingEntry): Promise<TrackingEntry>;
  resolve(entry: TrackingEntry): Promise<void>;
}
export class TrackingOccupiedError extends Error { constructor() { super("이 프로젝트의 다른 미확정 요청을 먼저 확인해 주세요. 새 입력은 아직 서버에 전송하지 않았습니다."); } }
const stages = ["queued","sending","waiting","conflict","confirmed"];
function validContext(value: TrackingContext, id: string) {
  return value && value.id === id && Number.isSafeInteger(value.revision) && value.revision >= 0 && isProjectProgress(value.progressPercent)
    && Array.isArray(value.parts) && value.parts.every(p => p && typeof p.id === "string" && isPartStatus(p.status));
}
export function validateTrackingEntry(entry: TrackingEntry): void {
  if (!entry || typeof entry !== "object") throw new Error("보관된 요청이 손상됐습니다. 원본을 보존했어요.");
  validateTrackingCommand(entry.command);
  const { command, draft } = entry;
  if (typeof entry.userId !== "string" || !entry.userId || entry.projectId !== command.projectId || !validContext(entry.base, entry.projectId)
    || !Number.isSafeInteger(entry.version) || entry.version < 0 || !stages.includes(entry.stage)
    || !Number.isFinite(Date.parse(entry.createdAt)) || !Number.isFinite(Date.parse(entry.updatedAt))
    || !draft || typeof draft.text !== "string" || typeof draft.unset !== "boolean" || !isPartStatus(draft.partStatus)
    || (entry.latest !== null && !validContext(entry.latest, entry.projectId))
    || (command.action.type === "setProgress" ? draft.target?.type !== "progress" || (draft.unset ? null : /^\d+$/.test(draft.text.trim()) ? Number(draft.text) : NaN) !== command.action.value
      : draft.target?.type !== "part" || draft.target.partId !== command.action.partId || draft.partStatus !== command.action.status)) {
    throw new Error("보관된 요청이 올바르지 않습니다. 데이터를 삭제하지 않았어요.");
  }
}
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject) => { req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error ?? new Error("대기 요청 저장소 오류")); }); }
function sameCommand(a: ProjectTrackingCommand,b: ProjectTrackingCommand) { return a.requestId===b.requestId && a.projectId===b.projectId && a.expectedRevision===b.expectedRevision && JSON.stringify(a.action)===JSON.stringify(b.action); }
/** A separate database: no counter/timer database version or queue is touched. */
export class IndexedDbTrackingOutbox implements TrackingOutbox {
  private db: Promise<IDBDatabase> | null = null;
  constructor(private readonly name = "stitchmori-project-tracking-v1") {}
  private database() {
    if (!this.db) this.db = new Promise<IDBDatabase>((resolve,reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB를 사용할 수 없습니다.")); return; }
      const open=indexedDB.open(this.name,1);
      open.onupgradeneeded=()=>{ const store=open.result.createObjectStore("pending",{keyPath:["userId","projectId"]}); store.createIndex("user","userId"); };
      open.onsuccess=()=>{ open.result.onversionchange=()=>{ open.result.close(); this.db=null; }; resolve(open.result); };
      open.onerror=()=>reject(open.error ?? new Error("대기 요청 저장소를 열지 못했습니다."));
      open.onblocked=()=>reject(new Error("다른 탭이 저장소를 사용 중입니다. 해당 탭을 확인해 주세요."));
    }).catch(e=>{this.db=null;throw e;});
    return this.db;
  }
  private async transaction<T>(mode: IDBTransactionMode, fn:(store:IDBObjectStore)=>Promise<T>):Promise<T> {
    const db=await this.database(), tx=db.transaction("pending",mode,mode==="readwrite"?{durability:"strict"}:undefined);
    const done=new Promise<void>((resolve,reject)=>{ tx.oncomplete=()=>resolve(); tx.onabort=tx.onerror=()=>reject(tx.error ?? new Error("대기 요청 저장을 완료하지 못했습니다.")); });
    try { const value=await fn(tx.objectStore("pending")); await done; if(mode==="readwrite")notifyTrackingOutbox(); return value; }
    catch(e){ try{tx.abort();}catch{} void done.catch(()=>undefined); throw e; }
  }
  async read(userId:string,projectId:string) {
    const entry=await this.transaction("readonly",async store=>(await request(store.get([userId,projectId]))) as TrackingEntry|undefined);
    if(!entry)return null;
    validateTrackingEntry(entry); if(entry.userId!==userId||entry.projectId!==projectId)throw new Error("요청 소유권이 일치하지 않습니다."); return entry;
  }
  async list(userId:string) {
    const entries=await this.transaction("readonly",async store=>await request(store.index("user").getAll(userId)) as TrackingEntry[]);
    entries.forEach(e=>{validateTrackingEntry(e);if(e.userId!==userId)throw new Error("요청 소유권이 일치하지 않습니다.");});
    return entries.sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  }
  async reserve(entry:TrackingEntry) {
    validateTrackingEntry(entry);
    return this.transaction("readwrite",async store=>{
      const old=await request(store.get([entry.userId,entry.projectId])) as TrackingEntry|undefined;
      if(old){validateTrackingEntry(old);if(!sameCommand(old.command,entry.command))throw new TrackingOccupiedError();return old;}
      await request(store.add(entry));return entry;
    });
  }
  private assertCurrent(old:TrackingEntry|undefined,entry:TrackingEntry) {
    if(!old || old.userId!==entry.userId || !sameCommand(old.command,entry.command) || old.version!==entry.version) throw new Error("다른 탭의 보관 상태가 변경됐습니다. 대기 요청을 다시 확인해 주세요.");
    validateTrackingEntry(old);
  }
  async update(entry:TrackingEntry,patch:Pick<Partial<TrackingEntry>,"stage"|"latest">) {
    return this.transaction("readwrite",async store=>{
      const old=await request(store.get([entry.userId,entry.projectId])) as TrackingEntry|undefined;this.assertCurrent(old,entry);
      const next={...old!,...patch,version:entry.version+1,updatedAt:new Date().toISOString()};validateTrackingEntry(next);await request(store.put(next));return next;
    });
  }
  async replace(entry:TrackingEntry,next:TrackingEntry) {
    validateTrackingEntry(next);
    return this.transaction("readwrite",async store=>{
      const old=await request(store.get([entry.userId,entry.projectId])) as TrackingEntry|undefined;this.assertCurrent(old,entry);
      if(old!.stage!=="conflict"||next.userId!==entry.userId||next.projectId!==entry.projectId||next.command.requestId===entry.command.requestId)throw new Error("확인한 충돌 요청만 새 요청으로 바꿀 수 있습니다.");
      await request(store.put(next));return next;
    });
  }
  async resolve(entry:TrackingEntry) {
    await this.transaction("readwrite",async store=>{
      const old=await request(store.get([entry.userId,entry.projectId])) as TrackingEntry|undefined;this.assertCurrent(old,entry);
      if(!["confirmed","conflict"].includes(old!.stage))throw new Error("서버 결과가 불분명한 요청은 삭제할 수 없습니다.");
      await request(store.delete([entry.userId,entry.projectId]));
    });
  }
}
export type TrackingLock = <T>(scope:string,task:()=>Promise<T>)=>Promise<T>;
export const withTrackingLock: TrackingLock = async (scope,task) => {
  if(typeof navigator==="undefined" || !navigator.locks)throw new Error("이 브라우저에서는 탭 간 전송 보호를 사용할 수 없습니다. 지원하는 브라우저에서 다시 시도해 주세요.");
  return navigator.locks.request(`stitchmori-tracking:${scope}`,{ifAvailable:true},async lock=>{
    if(!lock)throw new Error("다른 탭에서 이 프로젝트의 요청을 처리하고 있습니다. 잠시 뒤 다시 확인해 주세요.");
    return task();
  });
};

export function notifyTrackingOutbox() {
  if(typeof window!=="undefined")window.dispatchEvent(new Event("stitchmori-tracking-change"));
  if(typeof window!=="undefined"&&typeof BroadcastChannel!=="undefined"){const channel=new BroadcastChannel("stitchmori-tracking-change");channel.postMessage("changed");channel.close();}
}
export function watchTrackingOutbox(listener:()=>void) {
  if(typeof window==="undefined")return()=>undefined;
  const channel=typeof BroadcastChannel!=="undefined"?new BroadcastChannel("stitchmori-tracking-change"):null;
  if(channel)channel.onmessage=listener;
  window.addEventListener("stitchmori-tracking-change",listener);window.addEventListener("focus",listener);
  const visible=()=>{if(document.visibilityState==="visible")listener();};document.addEventListener("visibilitychange",visible);
  return()=>{channel?.close();window.removeEventListener("stitchmori-tracking-change",listener);window.removeEventListener("focus",listener);document.removeEventListener("visibilitychange",visible);};
}
