import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexedDbTrackingOutbox, withTrackingLock, type TrackingEntry, type TrackingLock } from "../../src/data/projects/tracking-outbox";
import { ProjectTrackingSession } from "../../src/components/project-tracking-session";
import type { ProjectDetail } from "../../src/data/projects/project-part-store";
import type { ProjectTrackingCommand, ProjectTrackingResult } from "../../src/domain/project/tracking";
const user=crypto.randomUUID(),project=crypto.randomUUID(),part=crypto.randomUUID();
const detail:ProjectDetail={id:project,name:"프로젝트",notes:null,status:"active",progressPercent:null,revision:2,updatedAt:new Date().toISOString(),parts:[{id:part,name:"파트",status:"not_started",position:0,isDefault:true,workItemId:crypto.randomUUID(),workItemRevision:3,stitch:42,row:10,lastCountAt:null,lastEventCreatedAt:null}]};
function entry(userId=user,projectId=project):TrackingEntry{
 const now=new Date().toISOString();return{userId,projectId,command:{projectId,requestId:crypto.randomUUID(),expectedRevision:2,action:{type:"setProgress",value:50}},draft:{target:{type:"progress"},text:"50",unset:false,partStatus:"not_started"},base:{id:projectId,revision:2,progressPercent:null,parts:[]},createdAt:now,updatedAt:now,version:0,stage:"queued",latest:null,replacesRequestId:null};
}
const unlocked:TrackingLock=async(_scope,fn)=>fn();
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
function setup(name=`tracking-test-${crypto.randomUUID()}`,owner=user,projectId=project,lock=unlocked){
 const outbox=new IndexedDbTrackingOutbox(name),apply=vi.fn<(c:ProjectTrackingCommand)=>Promise<ProjectTrackingResult>>().mockResolvedValue({status:"applied",projectId,projectRevision:3,change:{type:"setProgress",before:null,after:50}}),load=vi.fn().mockResolvedValue({...detail,id:projectId,progressPercent:50,revision:3}),checkUser=vi.fn().mockResolvedValue(undefined),onSaved=vi.fn();
 const session=new ProjectTrackingSession({userId:owner,projectId,outbox,apply,detail:load,checkUser,onSaved,lock});
 return{name,outbox,apply,load,checkUser,onSaved,session};
}
async function open(ctx:ReturnType<typeof setup>){await ctx.session.restore();ctx.session.open({type:"progress"},detail);ctx.session.edit({text:"50",unset:false});}
afterEach(()=>vi.unstubAllGlobals());
describe("tracking durable outbox",()=>{
 it("atomically reserves a single slot across DB connections and reuses identical commands",async()=>{
  const name=`tracking-${crypto.randomUUID()}`,a=new IndexedDbTrackingOutbox(name),b=new IndexedDbTrackingOutbox(name),first=entry(),second=entry();
  const results=await Promise.allSettled([a.reserve(first),b.reserve(second)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const saved=(await a.read(user,project))!;expect(await b.reserve(saved)).toEqual(saved);expect(await a.list(user)).toHaveLength(1);
 });
 it("isolates user/project slots and rejects stale updates, mismatched content and unsafe removals",async()=>{
  const store=new IndexedDbTrackingOutbox(`tracking-${crypto.randomUUID()}`),a=entry(),b=entry(crypto.randomUUID()),c=entry(user,crypto.randomUUID());
  await store.reserve(a);await store.reserve(b);await store.reserve(c);expect(await store.list(user)).toHaveLength(2);expect(await store.read(b.userId,project)).toEqual(b);
  await expect(store.reserve({...a,command:{...a.command,action:{type:"setProgress",value:99}},draft:{...a.draft,text:"99"}})).rejects.toThrow();
  const updated=await store.update(a,{stage:"sending"});await expect(store.update(a,{stage:"waiting"})).rejects.toThrow(/다른 탭/);
  await expect(store.resolve(updated)).rejects.toThrow(/불분명/);expect(await store.read(user,project)).toEqual(updated);
  await expect(store.resolve({...updated,userId:b.userId})).rejects.toThrow();
 });
 it("replaces only acknowledged conflicts atomically and preserves old queue on replacement failure",async()=>{
  const store=new IndexedDbTrackingOutbox(`tracking-${crypto.randomUUID()}`),a=entry();await store.reserve(a);const b={...entry(),replacesRequestId:a.command.requestId};
  await expect(store.replace(a,b)).rejects.toThrow();const conflict=await store.update(a,{stage:"conflict"});
  await expect(store.replace(conflict,{...b,userId:crypto.randomUUID()})).rejects.toThrow();expect((await store.read(user,project))?.command).toEqual(a.command);
  expect(await store.replace(conflict,b)).toEqual(b);expect(await store.list(user)).toHaveLength(1);
 });
 it("does not remove corrupt entries or coerce them into a new command",async()=>{
  const ctx=setup();await ctx.outbox.read(user,project);
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(ctx.name);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction("pending","readwrite");tx.objectStore("pending").put({...entry(),stage:"invalid"});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});
  await ctx.session.restore();expect(ctx.session.snapshot().phase).toBe("recovery_failed");expect(ctx.session.snapshot().initialized).toBe(false);
  await ctx.session.save();expect(ctx.apply).not.toHaveBeenCalled();
  const count=await new Promise<number>(resolve=>{const r=db.transaction("pending").objectStore("pending").count();r.onsuccess=()=>resolve(r.result);});expect(count).toBe(1);db.close();
 });
 it("refuses transport without Web Locks and holds one project lock across concurrent tasks",async()=>{
  vi.stubGlobal("navigator",{});await expect(withTrackingLock("x",async()=>1)).rejects.toThrow(/전송 보호/);
  const held=new Set<string>();vi.stubGlobal("navigator",{locks:{request:async(name:string,_options:unknown,callback:(lock:object|null)=>unknown)=>{if(held.has(name))return callback(null);held.add(name);try{return await callback({});}finally{held.delete(name);}}}});
  const wait=deferred<number>();const a=withTrackingLock("a",()=>wait.promise);
  await expect(withTrackingLock("a",async()=>2)).rejects.toThrow(/다른 탭/);expect(await withTrackingLock("b",async()=>3)).toBe(3);wait.resolve(1);expect(await a).toBe(1);
 });
});
describe("tracking recovery protocol",()=>{
 it("keeps saved status and clears obsolete drafts on repeated post-commit notifications",async()=>{
  const ctx=setup();await open(ctx);await ctx.session.save();await ctx.session.restore();await ctx.session.restore();
  expect(ctx.session.snapshot().phase).toBe("saved");expect(ctx.session.snapshot().draft).toBeNull();expect(ctx.session.snapshot().pending).toBeNull();expect(ctx.apply).toHaveBeenCalledOnce();
 });
 it("waits for the committed local transaction before calling RPC",async()=>{
  const ctx=setup();await open(ctx);const original=ctx.outbox.reserve.bind(ctx.outbox),gate=deferred<void>();
  vi.spyOn(ctx.outbox,"reserve").mockImplementation(async value=>{await gate.promise;return original(value);});
  const saving=ctx.session.save();await Promise.resolve();expect(ctx.apply).not.toHaveBeenCalled();gate.resolve();
  ctx.apply.mockImplementationOnce(async command=>{const stored=await ctx.outbox.read(user,project);expect(stored?.command).toEqual(command);expect(stored?.stage).toBe("sending");return{status:"unchanged",projectId:project,projectRevision:2,change:{type:"setProgress",before:50,after:50}};});
  await saving;expect(ctx.session.snapshot().phase).toBe("saved");expect(await ctx.outbox.read(user,project)).toBeNull();
 });
 it("retains the same in-memory ID on IndexedDB failure and sends nothing until retry stores it",async()=>{
  const ctx=setup();await open(ctx);vi.spyOn(ctx.outbox,"reserve").mockRejectedValueOnce(new Error("quota exceeded"));await ctx.session.save();
  const command=ctx.session.snapshot().pending;expect(ctx.session.snapshot().phase).toBe("storage_failed");expect(ctx.session.snapshot().durable).toBe(false);expect(ctx.apply).not.toHaveBeenCalled();
  await ctx.session.retry();expect(ctx.apply.mock.calls[0][0]).toEqual(command);expect(ctx.session.snapshot().phase).toBe("saved");
 });
 it("restores a pre-transport command without auto sending, including duplicate initialization",async()=>{
  const ctx=setup(),saved=entry();await ctx.outbox.reserve(saved);const read=vi.spyOn(ctx.outbox,"read");await Promise.all([ctx.session.restore(),ctx.session.restore()]);
  expect(read).toHaveBeenCalledOnce();expect(ctx.apply).not.toHaveBeenCalled();expect(ctx.session.snapshot().pending).toEqual(saved.command);expect(ctx.session.snapshot().draft).toEqual(saved.draft);
  await ctx.session.retry();expect(ctx.apply.mock.calls[0][0]).toEqual(saved.command);
 });
 it("restores requests interrupted during HTTP, then handles a committed lost response exactly once",async()=>{
  const ctx=setup();await open(ctx);const wait=deferred<ProjectTrackingResult>();let applications=0;
  ctx.apply.mockImplementationOnce(async()=>{applications++;return wait.promise;});const sending=ctx.session.save();await vi.waitFor(()=>expect(ctx.apply).toHaveBeenCalledOnce());
  const stored=(await ctx.outbox.read(user,project))!;expect(stored.stage).toBe("sending");ctx.session.deactivate();
  wait.resolve({status:"applied",projectId:project,projectRevision:3,change:{type:"setProgress",before:null,after:50}});await sending;
  const reopened=setup(ctx.name);await reopened.session.restore();expect(reopened.apply).not.toHaveBeenCalled();
  reopened.apply.mockResolvedValueOnce({status:"duplicate",projectId:project,projectRevision:3,change:{type:"setProgress",before:null,after:50}});await reopened.session.retry();
  expect(reopened.apply.mock.calls[0][0]).toEqual(stored.command);expect(applications).toBe(1);expect(await reopened.outbox.read(user,project)).toBeNull();
 });
 it("journals network failure as waiting and restores after closing a controller",async()=>{
  const ctx=setup();await open(ctx);ctx.apply.mockRejectedValueOnce(new Error("network offline"));await ctx.session.save();const saved=(await ctx.outbox.read(user,project))!;expect(saved.stage).toBe("waiting");
  ctx.session.deactivate();const next=setup(ctx.name);await next.session.restore();expect(next.session.snapshot().durable).toBe(true);expect(next.session.snapshot().pending).toEqual(saved.command);
  await next.session.retry();expect(next.apply.mock.calls[0][0]).toEqual(saved.command);
 });
 it("keeps conflicts and latest comparisons after reopening, requiring explicit review and a new ID",async()=>{
  const ctx=setup();await open(ctx);ctx.apply.mockResolvedValueOnce({status:"conflict",latestRevision:8});ctx.load.mockResolvedValue({...detail,revision:8,progressPercent:99});await ctx.session.save();await ctx.session.refreshLatest();
  const old=(await ctx.outbox.read(user,project))!;expect(old.stage).toBe("conflict");expect(old.latest?.progressPercent).toBe(99);
  ctx.session.deactivate();const next=setup(ctx.name);await next.session.restore();expect(next.session.snapshot().phase).toBe("conflict");expect(next.session.snapshot().draft?.text).toBe("50");
  await next.session.confirmReviewedSave();expect(next.apply).not.toHaveBeenCalled();next.load.mockResolvedValue({...detail,revision:9,progressPercent:100});await next.session.refreshLatest();
  expect(next.session.snapshot().pending).toEqual(old.command);expect(next.apply).not.toHaveBeenCalled();
  const wait=deferred<ProjectTrackingResult>();next.apply.mockReturnValueOnce(wait.promise);const save=next.session.confirmReviewedSave();await vi.waitFor(()=>expect(next.apply).toHaveBeenCalledOnce());
  const replacement=(await next.outbox.read(user,project))!;expect(replacement.command.requestId).not.toBe(old.command.requestId);expect(replacement.command.expectedRevision).toBe(9);expect(replacement.replacesRequestId).toBe(old.command.requestId);expect(replacement.command.action).toEqual(old.command.action);
  wait.resolve({status:"applied",projectId:project,projectRevision:10,change:{type:"setProgress",before:100,after:50}});await save;
 });
 it("lets an old tab explicitly acknowledge a resolved conflict without deleting a replacement",async()=>{
  const ctx=setup();await open(ctx);ctx.apply.mockResolvedValueOnce({status:"conflict",latestRevision:8});await ctx.session.save();const old=(await ctx.outbox.read(user,project))!;
  const next={...entry(),replacesRequestId:old.command.requestId};await ctx.outbox.replace(old,next);await ctx.session.restore();
  expect(await ctx.session.cancel()).toBe(false); // Must explicitly adopt the existing queued request, not discard unknown work.
  const acknowledged=setup(ctx.name);await acknowledged.outbox.update(next,{stage:"conflict"});
  const pending=(await ctx.outbox.read(user,project))!;await ctx.outbox.resolve(pending);
  await ctx.session.restore();expect(ctx.session.snapshot().phase).toBe("conflict");expect(await ctx.session.cancel()).toBe(true);expect(ctx.session.snapshot().pending).toBeNull();
 });
 it("preserves a conflict until explicit cancellation succeeds locally",async()=>{
  const ctx=setup();await open(ctx);ctx.apply.mockResolvedValueOnce({status:"conflict",latestRevision:8});await ctx.session.save();vi.spyOn(ctx.outbox,"resolve").mockRejectedValueOnce(new Error("IDB failure"));
  expect(await ctx.session.cancel()).toBe(false);expect((await ctx.outbox.read(user,project))?.stage).toBe("conflict");expect(ctx.session.snapshot().pending).not.toBeNull();
  expect(await ctx.session.cancel()).toBe(true);expect(await ctx.outbox.read(user,project)).toBeNull();
 });
 it("retains confirmed requests when refresh or cleanup fails, and verifies the same receipt after reopening",async()=>{
  const ctx=setup();await open(ctx);vi.spyOn(ctx.outbox,"resolve").mockRejectedValueOnce(new Error("cleanup failure"));await ctx.session.save();const saved=(await ctx.outbox.read(user,project))!;
  expect(saved.stage).toBe("confirmed");expect(ctx.session.snapshot().phase).toBe("refresh_failed");
  const next=setup(ctx.name);await next.session.restore();await next.session.retry();expect(next.apply.mock.calls[0][0]).toEqual(saved.command);expect(await next.outbox.read(user,project)).toBeNull();
 });
 it("does not transmit A's stored command under B or expired authentication",async()=>{
  const a=setup();await a.outbox.reserve(entry());const b=setup(a.name,crypto.randomUUID());await b.session.restore();expect(b.session.snapshot().pending).toBeNull();expect(await b.outbox.list(user)).toHaveLength(1);
  await a.session.restore();a.checkUser.mockRejectedValue(new Error("expired"));await a.session.retry();expect(a.apply).not.toHaveBeenCalled();expect(await a.outbox.read(user,project)).not.toBeNull();
 });
 it("preserves a second tab's new input instead of overwriting a project slot",async()=>{
  const ctx=setup();await open(ctx);const other=entry();await ctx.outbox.reserve(other);await ctx.session.save();expect(ctx.session.snapshot().phase).toBe("blocked");expect(ctx.session.snapshot().draft?.text).toBe("50");expect(ctx.apply).not.toHaveBeenCalled();
  expect((await ctx.outbox.read(user,project))?.command.requestId).toBe(other.command.requestId);
  await ctx.session.restore();expect(ctx.session.snapshot().peer?.command.requestId).toBe(other.command.requestId);await ctx.session.useStored();expect(ctx.session.snapshot().pending).toEqual(other.command);
 });
 it("keeps original part targets through persistence and refuses automatic cross-project reuse",async()=>{
  const ctx=setup();await ctx.session.restore();ctx.session.open({type:"part",partId:part},detail);ctx.session.edit({partStatus:"completed"});ctx.apply.mockRejectedValueOnce(new Error("offline"));await ctx.session.save();
  const saved=(await ctx.outbox.read(user,project))!;expect(saved.command.action).toEqual({type:"setPartStatus",partId:part,status:"completed"});const other=setup(ctx.name,user,crypto.randomUUID());await other.session.restore();expect(other.session.snapshot().pending).toBeNull();
  const next=setup(ctx.name);await next.session.restore();expect(next.session.snapshot().draft?.target).toEqual({type:"part",partId:part});
 });
});
