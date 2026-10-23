import 'fake-indexeddb/auto';
import {it,expect,vi} from 'vitest';
import {IndexedDbTimerStore} from '../../src/data/timer/indexeddb-timer-store';
import {LocalAdjustmentStore} from '../../src/data/timer/adjustment-store';
import {validateTimerImport} from '../../src/domain/timer/imports';
import {TimerImportService} from '../../src/data/timer/timer-import-service';
import {IndexedDbCounterStore} from '../../src/data/local/indexeddb-counter-store';
const uid='alice';
async function fixture(){
 const name=`timer-import-${crypto.randomUUID()}`,store=new IndexedDbTimerStore(name),work=crypto.randomUUID(),sid=crypto.randomUUID();
 const commands=['start','pause','resume','end'] as const;
 for(let i=0;i<commands.length;i++)await store.applyLocal({commandId:crypto.randomUUID(),sessionId:sid,workItemId:work,expectedRevision:i,occurredAt:new Date(Date.UTC(2026,9,22,14,i*10)).toISOString(),deviceId:'fixture',action:commands[i]});
 return {name,store,work,sid};
}
it('freezes complete ended events and correction history and restores the same request',async()=>{
 const {store,work,sid}=await fixture();await new LocalAdjustmentStore(store).submit({requestId:crypto.randomUUID(),sessionId:sid,expectedRevision:0,adjustedMs:123,reason:'sample'});
 const snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID());expect(validateTimerImport(snapshot.sessions[0],work)).toBe(123);
 expect(snapshot.sessions[0].events).toHaveLength(4);expect(snapshot.sessions[0].state.accumulatedMs).toBe(1200000);
 expect(await store.freezeTimerImport(uid,work,snapshot.counterImportId)).toEqual(snapshot);
 expect((await store.readUi<{pending:unknown}>(`timer-import:${work}`))?.pending).toEqual(snapshot);
});
it('blocks active sessions and pending timer/adjustment commands',async()=>{
 const {store,work,sid}=await fixture();const cmd={commandId:crypto.randomUUID(),sessionId:crypto.randomUUID(),workItemId:work,expectedRevision:0,occurredAt:'2026-10-23T00:00:00Z',deviceId:'test',action:'start' as const};
 await store.retainLocal(cmd);await expect(store.freezeTimerImport(uid,work,crypto.randomUUID())).rejects.toThrow('미확정');await store.releaseLocal(cmd.commandId);
 await store.retainAdjustment('local',{requestId:crypto.randomUUID(),sessionId:sid,expectedRevision:0,adjustedMs:1,reason:''});await expect(store.freezeTimerImport(uid,work,crypto.randomUUID())).rejects.toThrow('정정');
 const pending=await store.pendingAdjustment('local',sid);await store.releaseAdjustment('local',sid,pending!.requestId);
 await store.applyLocal(cmd);await expect(store.freezeTimerImport(uid,work,crypto.randomUUID())).rejects.toThrow('종료');
});
it('locks a frozen work item and makes acknowledged local originals read-only without deleting them',async()=>{
 const {store,work,sid}=await fixture(),snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID());
 await expect(store.applyLocal({commandId:crypto.randomUUID(),sessionId:crypto.randomUUID(),workItemId:work,expectedRevision:0,occurredAt:'2026-10-23T00:00:00Z',deviceId:'test',action:'start'})).rejects.toThrow('가져오기');
 expect((await store.adjustmentSnapshot(sid)).canAdjust).toBe(false);
 await store.finishTimerImport(uid,snapshot,{importId:snapshot.importId,status:'imported',serverWorkItemId:'server',mappings:[{localSessionId:sid,serverSessionId:'server-session'}]});
 expect((await store.getLocal(sid)).events).toHaveLength(4);expect((await store.adjustmentSnapshot(sid)).canAdjust).toBe(false);
 await expect(store.freezeTimerImport(uid,work,snapshot.counterImportId)).rejects.toThrow('없습니다');
 await expect(store.freezeTimerImport('bob',work,snapshot.counterImportId)).rejects.toThrow('다른 계정');
});
it('rejects mismatching receipts and leaves the frozen request retryable',async()=>{
 const {store,work}=await fixture(),snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID());
 await expect(store.finishTimerImport(uid,snapshot,{importId:'wrong',status:'imported',serverWorkItemId:'server',mappings:[]})).rejects.toThrow('영수증');
 expect(await store.freezeTimerImport(uid,work,snapshot.counterImportId)).toEqual(snapshot);
});
it('validates original duration, order, actor and audit chain',async()=>{
 const {store,work}=await fixture(),snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID());const bundle=structuredClone(snapshot.sessions[0]);bundle.events.reverse();expect(()=>validateTimerImport(bundle,work)).toThrow();
 const altered=structuredClone(snapshot.sessions[0]);altered.state.accumulatedMs++;expect(()=>validateTimerImport(altered,work)).toThrow();
});
it('keeps snapshot after counter-import success and timer RPC failure, then retries the same payload',async()=>{
 const counters=new IndexedDbCounterStore(`counter-timer-import-${crypto.randomUUID()}`),record=await counters.getOrCreateQuick();
 const timers=new IndexedDbTimerStore(`timer-service-${crypto.randomUUID()}`),sid=crypto.randomUUID();
 for(const [i,action] of (['start','end'] as const).entries())await timers.applyLocal({commandId:crypto.randomUUID(),sessionId:sid,workItemId:record.localWorkItemId,expectedRevision:i,occurredAt:`2026-10-22T00:0${i}:00Z`,deviceId:'test',action});
 let payload:unknown;const rpc=vi.fn(async(name:string,args:{p_payload:unknown})=>{
  if(name==='import_counter_snapshot')return {data:{status:'imported',importId:record.importId,localWorkItemId:record.localWorkItemId,serverWorkItemId:'server',importedRevision:0},error:null};
  if(!payload){payload=structuredClone(args.p_payload);return {error:{message:'lost response'}};}
  expect(args.p_payload).toEqual(payload);const s=args.p_payload as {importId:string};return {data:{status:'duplicate',importId:s.importId,serverWorkItemId:'server',mappings:[{localSessionId:sid,serverSessionId:'session'}]},error:null};
 });
 const client={auth:{getClaims:async()=>({data:{claims:{sub:uid}}})},rpc};
 const service=new TimerImportService(timers,counters,client as never,uid,async()=>false,{pending:async()=>[]} as never);
 await expect(service.import()).rejects.toThrow('lost');expect((await counters.getQuickIfExists())?.serverWorkItemId).toBe('server');
 expect((await service.import()).status).toBe('duplicate');expect(rpc.mock.calls.filter(([name])=>name==='import_counter_snapshot')).toHaveLength(1);
});
it('blocks unsaved counters and other-account mapping before uploading',async()=>{
 const counters=new IndexedDbCounterStore(`counter-timer-block-${crypto.randomUUID()}`);await counters.getOrCreateQuick();const rpc=vi.fn();const client={auth:{getClaims:async()=>({data:{claims:{sub:uid}}})},rpc};
 const service=new TimerImportService(new IndexedDbTimerStore(`timer-block-${crypto.randomUUID()}`),counters,client as never,uid,async()=>true);
 await expect(service.import()).rejects.toThrow('로컬 카운터');expect(rpc).not.toHaveBeenCalled();
});
it('blocks a server counter outbox before freezing or uploading',async()=>{
 const counters=new IndexedDbCounterStore(`timer-outbox-${crypto.randomUUID()}`),record=await counters.getOrCreateQuick();
 const snapshot=await counters.beginImport(record.localWorkItemId);await counters.finishImport(snapshot,uid,'server');
 const rpc=vi.fn(),client={auth:{getClaims:async()=>({data:{claims:{sub:uid}}})},rpc};
 const service=new TimerImportService(new IndexedDbTimerStore(`timer-outbox-block-${crypto.randomUUID()}`),counters,client as never,uid,async()=>false,{pending:async()=>[{}]} as never);
 await expect(service.import()).rejects.toThrow('서버 미확정');expect(rpc).not.toHaveBeenCalled();
});
it('allows another batch for new ended sessions but keeps earlier mappings unchanged',async()=>{
 const {store,work,sid}=await fixture(),snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID());
 await store.finishTimerImport(uid,snapshot,{importId:snapshot.importId,status:'imported',serverWorkItemId:'server',mappings:[{localSessionId:sid,serverSessionId:'server-session'}]});
 const next=crypto.randomUUID();for(const [i,action] of (['start','end'] as const).entries())await store.applyLocal({commandId:crypto.randomUUID(),sessionId:next,workItemId:work,expectedRevision:i,occurredAt:`2026-10-23T00:0${i}:00Z`,deviceId:'test',action});
 const again=await store.freezeTimerImport(uid,work,snapshot.counterImportId);expect(again.importId).not.toBe(snapshot.importId);expect(again.sessions.map(s=>s.state.sessionId)).toEqual([next]);expect((await store.getLocal(sid)).events).toHaveLength(4);
});
it('refuses another account before opening the remote import request',async()=>{
 const counters=new IndexedDbCounterStore(`timer-other-owner-${crypto.randomUUID()}`),record=await counters.getOrCreateQuick();const snapshot=await counters.beginImport(record.localWorkItemId);await counters.finishImport(snapshot,'bob','server');
 const rpc=vi.fn(),client={auth:{getClaims:async()=>({data:{claims:{sub:uid}}})},rpc};
 await expect(new TimerImportService(new IndexedDbTimerStore(`timer-owner-${crypto.randomUUID()}`),counters,client as never,uid,async()=>false).import()).rejects.toThrow('다른 계정');expect(rpc).not.toHaveBeenCalled();
});
it('keeps originals and the frozen ID when local snapshot or acknowledgement storage fails',async()=>{
 const {store,work,sid}=await fixture(),originalPut=IDBObjectStore.prototype.put;
 let fail=true;
 const spy=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(function(this:IDBObjectStore,...args:Parameters<IDBObjectStore['put']>){if(fail&&this.name==='meta'&&String(args[0]?.key).startsWith('ui:timer-import:'))throw new Error('disk full');return originalPut.apply(this,args);});
 try{
  await expect(store.freezeTimerImport(uid,work,crypto.randomUUID())).rejects.toThrow('disk full');expect((await store.getLocal(sid)).state?.accumulatedMs).toBe(1200000);
  fail=false;const snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID()),receipt={importId:snapshot.importId,status:'imported' as const,serverWorkItemId:'server',mappings:[{localSessionId:sid,serverSessionId:'server-session'}]};
  fail=true;await expect(store.finishTimerImport(uid,snapshot,receipt)).rejects.toThrow('disk full');expect(await store.freezeTimerImport(uid,work,snapshot.counterImportId)).toEqual(snapshot);
  fail=false;await store.finishTimerImport(uid,snapshot,receipt);expect((await store.getLocal(sid)).events).toHaveLength(4);
 }finally{spy.mockRestore();}
});

it('detects an unexpected source change before acknowledging and keeps both source and snapshot',async()=>{
 const {name,store,work,sid}=await fixture(),snapshot=await store.freezeTimerImport(uid,work,crypto.randomUUID());
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name,3);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 const source=(await store.getLocal(sid)).state!;
 await new Promise<void>((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');tx.objectStore('sessions').put({...source,updatedAt:'2026-10-23T00:00:00Z'});tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);});db.close();
 await expect(store.finishTimerImport(uid,snapshot,{importId:snapshot.importId,status:'imported',serverWorkItemId:'server',mappings:[{localSessionId:sid,serverSessionId:'server-session'}]})).rejects.toThrow('원본이 달라졌습니다');
 expect((await store.readUi<{pending:unknown}>(`timer-import:${work}`))?.pending).toEqual(snapshot);
 expect((await store.getLocal(sid)).state?.updatedAt).toBe('2026-10-23T00:00:00Z');
});
