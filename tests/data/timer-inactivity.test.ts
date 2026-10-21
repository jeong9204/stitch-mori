import 'fake-indexeddb/auto';
import {it,expect,vi,afterEach} from 'vitest';
import {IndexedDbTimerStore} from '../../src/data/timer/indexeddb-timer-store';
import {LocalTimerBackend} from '../../src/data/timer/timer-ui-backend';
import {applyCounterCommand,initialCounterState} from '../../src/domain/counter/engine';
import {inactivityDue} from '../../src/domain/timer/inactivity';
import type {CounterEvent} from '../../src/domain/counter/types';
const at='2026-10-20T14:00:00.000Z';
afterEach(()=>vi.useRealTimers());
async function setup() {
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-10-20T14:31:00Z');
  const name=`activity-${crypto.randomUUID()}`,store=new IndexedDbTimerStore(name),work=crypto.randomUUID(),session=crypto.randomUUID();
  await store.applyLocal({action:'start',commandId:crypto.randomUUID(),sessionId:session,workItemId:work,expectedRevision:0,occurredAt:at,deviceId:'test'});
  const events:CounterEvent[]=[];const counters={getEvents:async()=>events};
  return {name,store,work,session,events,counters,backend:new LocalTimerBackend(work,store,counters as never)};
}
it('claims once across tabs, keeps running, and does not repeat after reopening',async()=>{
  const {name,store,work,session,counters,backend}=await setup();const context=await backend.readInactivity(session);expect(inactivityDue(context)).toBe(true);
  const second=new LocalTimerBackend(work,new IndexedDbTimerStore(name),counters as never);
  expect((await Promise.all([backend.ackInactivity(context,'show'),second.ackInactivity(context,'show')])).filter(Boolean)).toHaveLength(1);
  expect((await store.getLocal(session)).state?.status).toBe('running');await store.close();
  expect(inactivityDue(await second.readInactivity(session))).toBe(false);
});
it('continue resets the baseline; later suppresses only that interval; a real count starts another',async()=>{
  const {backend,session,events,work}=await setup();let context=await backend.readInactivity(session);await backend.ackInactivity(context,'show');await backend.ackInactivity(context,'continue');
  context=await backend.readInactivity(session);expect(context.baseline).toBe('2026-10-20T14:31:00.000Z');expect(inactivityDue(context)).toBe(false);
  vi.setSystemTime('2026-10-20T15:02:00Z');context=await backend.readInactivity(session);await backend.ackInactivity(context,'show');await backend.ackInactivity(context,'later');expect(inactivityDue(await backend.readInactivity(session))).toBe(false);
  const result=applyCounterCommand(initialCounterState(work),[],{commandId:crypto.randomUUID(),workItemId:work,expectedRevision:0,occurredAt:'2026-10-20T15:03:00Z',deviceId:'test',action:{type:'change',counter:'stitch',delta:1}});
  if(result.status!=='applied'||!result.event)throw new Error('fixture');events.push(result.event);
  vi.setSystemTime('2026-10-20T15:34:00Z');expect(inactivityDue(await backend.readInactivity(session))).toBe(true);
});
it('target-only edits do not reset inactivity; stale/foreign/ended prompts are rejected',async()=>{
  const {backend,session,events,work,store}=await setup();const context=await backend.readInactivity(session);
  const result=applyCounterCommand(initialCounterState(work),[],{commandId:crypto.randomUUID(),workItemId:work,expectedRevision:0,occurredAt:'2026-10-20T14:25:00Z',deviceId:'test',action:{type:'setTarget',counter:'stitch',value:20}});
  if(result.status!=='applied'||!result.event)throw new Error('fixture');events.push(result.event);expect((await backend.readInactivity(session)).baseline).toBe(at);
  await expect(new LocalTimerBackend('other',store,{getEvents:async()=>events} as never).readInactivity(session)).rejects.toThrow();
  await store.applyLocal({action:'end',commandId:crypto.randomUUID(),sessionId:session,workItemId:work,expectedRevision:1,occurredAt:'2026-10-20T14:31:00Z',deviceId:'test'});
  expect(await backend.ackInactivity(context,'show')).toBe(false);
});
it('failed acknowledgement is not recorded; retry and pause decision preserve the timer until a pause command',async()=>{
  const {backend,session,store}=await setup();const context=await backend.readInactivity(session);
  vi.spyOn(store,'updateUi').mockRejectedValueOnce(new Error('disk full'));await expect(backend.ackInactivity(context,'show')).rejects.toThrow();
  expect(inactivityDue(await backend.readInactivity(session))).toBe(true);await backend.ackInactivity(context,'show');expect(await backend.ackInactivity(context,'pause')).toBe(true);
  // If the choice response was lost before issuing pause, the identical choice may continue.
  expect(await backend.ackInactivity(context,'pause')).toBe(true);expect(await backend.ackInactivity(context,'later')).toBe(false);
  expect((await store.getLocal(session)).state?.status).toBe('running');
});
