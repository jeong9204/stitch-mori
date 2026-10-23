import 'fake-indexeddb/auto';
import {it,expect,vi} from 'vitest';
import {IndexedDbTimerStore} from '../../src/data/timer/indexeddb-timer-store';
import {LocalAdjustmentStore,AccountAdjustmentStore} from '../../src/data/timer/adjustment-store';
import {AdjustmentSession} from '../../src/data/timer/adjustment-session';
import {localTimeStatistics} from '../../src/domain/timer/statistics';
import type {AdjustmentCommand,AdjustmentSnapshot} from '../../src/domain/timer/adjustments';
async function fixture(){
  const name=`adjustments-${crypto.randomUUID()}`,store=new IndexedDbTimerStore(name),sessionId=crypto.randomUUID(),workItemId=crypto.randomUUID();
  const start={commandId:crypto.randomUUID(),sessionId,workItemId,expectedRevision:0,action:'start' as const,occurredAt:'2026-10-23T00:00:00Z',deviceId:'test'};
  await store.applyLocal(start);await store.applyLocal({...start,commandId:crypto.randomUUID(),expectedRevision:1,action:'end',occurredAt:'2026-10-23T00:10:00Z'});
  const backend=new LocalAdjustmentStore(store),editor=new AdjustmentSession(backend,sessionId);await editor.load();return {name,store,sessionId,backend,editor,start};
}
it('persists append-only local history and restores effective statistics after reopening',async()=>{
  const {name,store,sessionId,editor}=await fixture();const original=await store.getLocal(sessionId);
  await editor.save(900000,'측정 오류');await editor.save(0,'');expect(await store.getLocal(sessionId)).toEqual(original);await store.close();
  const restored=new IndexedDbTimerStore(name),snapshot=await restored.adjustmentSnapshot(sessionId);expect(snapshot).toMatchObject({effectiveMs:0,revision:2});expect(snapshot.adjustments).toHaveLength(2);
  const source=await restored.localStatisticsSource();expect(localTimeStatistics(source.states,source.events,'2026-10-23T12:00:00Z','UTC',0,source.adjustments).works[0].savedMs).toBe(0);
});
it('keeps a failed write request durable, rolls back the audit and retries the identical ID after reload',async()=>{
  const {name,store,sessionId,backend,editor}=await fixture();const originalAdd=IDBObjectStore.prototype.add;
  const spy=vi.spyOn(IDBObjectStore.prototype,'add').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['add']>){if(this.name==='adjustments')throw new Error('disk full');return originalAdd.apply(this,args);});
  await editor.save(1200000,'실제 작업');spy.mockRestore();
  const pending=await store.pendingAdjustment('local',sessionId);expect(pending?.adjustedMs).toBe(1200000);expect(editor.getSnapshot()).toMatchObject({status:'failed',durable:true});expect((await backend.load(sessionId)).effectiveMs).toBe(600000);
  await store.close();const nextStore=new IndexedDbTimerStore(name),next=new AdjustmentSession(new LocalAdjustmentStore(nextStore),sessionId);await next.load();expect(next.getSnapshot().pending).toEqual(pending);
  await next.retry();expect(next.getSnapshot()).toMatchObject({status:'saved',snapshot:{effectiveMs:1200000,revision:1},pending:null});
});
it('serializes concurrent corrections and preserves the losing request until explicit review',async()=>{
  const {name,store,sessionId,editor}=await fixture(),other=new AdjustmentSession(new LocalAdjustmentStore(new IndexedDbTimerStore(name)),sessionId);await other.load();
  // One pending envelope per session prevents concurrent local tabs silently overwriting intent.
  await Promise.all([editor.save(1000,'a'),other.save(2000,'b')]);
  const snapshot=await store.adjustmentSnapshot(sessionId);expect(snapshot.revision).toBe(1);expect([1000,2000]).toContain(snapshot.effectiveMs);
  expect([editor,other].some(e=>e.getSnapshot().pending!==null)).toBe(true);
});
it('does not reapply a correction when its acknowledgement is lost',async()=>{
  const {backend,editor,sessionId}=await fixture();const real=backend.submit.bind(backend);
  vi.spyOn(backend,'submit').mockImplementationOnce(async command=>{await real(command);throw new Error('lost response');});
  await editor.save(3000,'memo');const id=editor.getSnapshot().pending?.requestId;await editor.retry();const snapshot=await backend.load(sessionId);
  expect(snapshot.revision).toBe(1);expect(snapshot.adjustments[0].commandId).toBe(id);
});
it('preserves conflicts instead of rebasing, and releases only by explicit action',async()=>{
  const {backend,editor,sessionId}=await fixture();const pending:AdjustmentCommand={requestId:crypto.randomUUID(),sessionId,expectedRevision:0,adjustedMs:1000,reason:'other device'};
  await backend.submit(pending);await editor.save(2000,'stale');expect(editor.getSnapshot()).toMatchObject({status:'conflict',snapshot:{revision:1},pending:{expectedRevision:0}});
  await editor.release();expect(editor.getSnapshot().pending).toBeNull();await editor.save(2000,'after review');expect(editor.getSnapshot().snapshot?.revision).toBe(2);
});
it('isolates account journals and checks authentication after an in-flight RPC',async()=>{
  const {store,sessionId}=await fixture();let user='alice';
  const client={auth:{getClaims:async()=>({data:{claims:{sub:user}}})},rpc:vi.fn(async()=>{user='bob';return {data:{status:'applied'},error:null};})};
  const backend=new AccountAdjustmentStore(client as never,'alice',store),cmd={requestId:crypto.randomUUID(),sessionId,expectedRevision:0,adjustedMs:1000,reason:''};
  await expect(backend.submit(cmd)).rejects.toThrow('계정');expect(await store.pendingAdjustment('account:alice',sessionId)).toEqual(cmd);expect(await store.pendingAdjustment('account:bob',sessionId)).toBeNull();expect(await store.pendingAdjustment('local',sessionId)).toBeNull();
});
it('does not publish a delayed snapshot after editor disposal',async()=>{
  const {backend,editor}=await fixture();let finish!:(snapshot:AdjustmentSnapshot)=>void;
  const snapshot=editor.getSnapshot().snapshot!;vi.spyOn(backend,'load').mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const loading=editor.load();editor.dispose();finish(snapshot);await loading;expect(editor.getSnapshot().snapshot).toBeNull();
});
it('retains the in-memory request when even journal storage fails',async()=>{
  const {store,editor}=await fixture();vi.spyOn(store,'retainAdjustment').mockRejectedValueOnce(new Error('quota'));
  await editor.save(4000,'keep');expect(editor.getSnapshot()).toMatchObject({status:'failed',durable:false,pending:{adjustedMs:4000}});await editor.retry();expect(editor.getSnapshot().snapshot?.effectiveMs).toBe(4000);
});
it('upgrades the v1 timer DB without losing sessions, events, preferences or pending timer commands',async()=>{
  const name=`timer-v1-upgrade-${crypto.randomUUID()}`;
  await new Promise<void>((resolve,reject)=>{
    const request=indexedDB.open(name,1);request.onupgradeneeded=()=>{
      const db=request.result,sessions=db.createObjectStore('sessions',{keyPath:'sessionId'}),events=db.createObjectStore('events',{keyPath:'eventId'});
      sessions.createIndex('workItemId','workItemId');events.createIndex('sessionId','command.sessionId');db.createObjectStore('meta',{keyPath:'key'});db.createObjectStore('server_pending',{keyPath:'userId'});
    };
    request.onerror=()=>reject(request.error);request.onsuccess=()=>{
      const db=request.result,tx=db.transaction(['sessions','events','meta','server_pending'],'readwrite');
      tx.objectStore('sessions').put({sessionId:'old-session',workItemId:'old-work',status:'ended'});
      tx.objectStore('events').put({eventId:'old-event',command:{sessionId:'old-session'},after:{revision:1}});
      tx.objectStore('meta').put({key:'ui:old-preference',value:'auto'});
      tx.objectStore('server_pending').put({userId:'alice',command:{commandId:'pending-timer'}});
      tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
    };
  });
  const upgraded=new IndexedDbTimerStore(name);expect((await upgraded.getLocal('old-session')).events[0].eventId).toBe('old-event');
  expect(await upgraded.readUi('old-preference')).toBe('auto');expect((await upgraded.pending('alice'))?.command.commandId).toBe('pending-timer');
  expect(await upgraded.pendingAdjustment('local','old-session')).toBeNull();
});
it('supports a strict-effect cleanup/restart without exposing a disposed editor instance elsewhere',async()=>{
  const {editor}=await fixture();editor.dispose();editor.activate();await editor.load();expect(editor.getSnapshot().snapshot?.session.status).toBe('ended');
});
