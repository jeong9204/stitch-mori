import { applyCounterCommand, initialCounterState } from '../../../src/domain/counter/engine';
import type { CounterCommand, CounterEvent, CounterState } from '../../../src/domain/counter/types';
import { applyTimerCommand } from '../../../src/domain/timer/engine';
import type { TimerEvent, WorkSession } from '../../../src/domain/timer/types';
export type { CounterCommand, CounterEvent, CounterState, TimerEvent, WorkSession };
export type Snapshot = {format:1;project:{id:string;name:string};part:{id:string;name:string};counter:CounterState;events:CounterEvent[];sessions:WorkSession[];timerEvents:TimerEvent[];photo:Photo|null};
export type Photo = {blob:Blob;width:number;height:number;sha256:string};
export const DB_NAME='stitchmori-storage-poc-v1';
export const MAX_HISTORY=5000;
export const same=(a:unknown,b:unknown):boolean=>{
  const normalize=(v:unknown):unknown=>Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,normalize(x)])):v;
  return JSON.stringify(normalize(a))===JSON.stringify(normalize(b));
};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export function validateSnapshot(value:unknown):asserts value is Snapshot {
  if(!value||typeof value!=='object')throw new Error('백업 구조가 올바르지 않습니다.');
  const s=value as Snapshot;
  if(s.format!==1||!uuid(s.project?.id)||!uuid(s.part?.id)||typeof s.project.name!=='string'||!s.project.name.trim()||s.project.name.length>120||s.part.name!=='기본 파트'||!uuid(s.counter?.workItemId)||!Array.isArray(s.events)||!Array.isArray(s.sessions)||!Array.isArray(s.timerEvents)||s.events.length+s.timerEvents.length>MAX_HISTORY)throw new Error('지원하지 않는 구조·ID·이름 또는 이력 한도(5,000건)입니다.');
  let current=initialCounterState(s.counter.workItemId);const seen=new Set<string>();
  for(const e of s.events){
    if(!uuid(e.eventId)||e.eventId!==e.commandId||seen.has(e.eventId)||!same(e.before,current)||e.workItemId!==current.workItemId)throw new Error('카운터 이벤트 연결이 올바르지 않습니다.');
    const command:CounterCommand={commandId:e.commandId,workItemId:e.workItemId,expectedRevision:e.before.revision,occurredAt:e.occurredAt,deviceId:e.deviceId,action:e.action};
    const applied=applyCounterCommand(current,s.events.filter(x=>seen.has(x.eventId)),command);
    if(applied.status!=='applied'||!same(applied.event,e))throw new Error('카운터 이력을 재현할 수 없습니다.');
    current=applied.state;seen.add(e.eventId);
  }
  if(!same(current,s.counter))throw new Error('카운터 최종 값과 이력이 다릅니다.');
  const states=new Map<string,WorkSession>(),timerSeen:TimerEvent[]=[];let active:string|null=null;
  for(const e of s.timerEvents){
    const c=e.command;if(!c||!uuid(c.commandId)||!uuid(c.sessionId)||e.eventId!==c.commandId||seen.has(e.eventId)||c.workItemId!==current.workItemId||!same(e.before,states.get(c.sessionId)??null))throw new Error('타이머 이벤트 연결이 올바르지 않습니다.');
    if(c.action==='start'&&active)throw new Error('활성 타이머가 중복됩니다.');
    const result=applyTimerCommand(states.get(c.sessionId)??null,timerSeen,c,e.effectiveAt);
    if(result.status!=='applied'||!same(result.state,e.after))throw new Error('타이머 이력을 재현할 수 없습니다.');
    states.set(c.sessionId,result.state);active=result.state.status==='ended'?null:c.sessionId;timerSeen.push(e);seen.add(e.eventId);
  }
  if(!same([...states.values()],s.sessions))throw new Error('타이머 최종 상태와 이력이 다릅니다.');
  if(s.photo!==null&&(!s.photo||!(s.photo.blob instanceof Blob)||s.photo.blob.type!=='image/jpeg'||s.photo.blob.size<=0||s.photo.blob.size>2*1024*1024||![s.photo.width,s.photo.height].every(x=>Number.isInteger(x)&&x>0&&x<=1600)||!/^[0-9a-f]{64}$/.test(s.photo.sha256)))throw new Error('사진 메타데이터가 올바르지 않습니다.');
}
export function createSnapshot(name:string):Snapshot {
  const trimmed=name.trim();if(!trimmed||trimmed.length>120)throw new Error('프로젝트명은 1~120자로 입력해 주세요.');
  return {format:1,project:{id:crypto.randomUUID(),name:trimmed},part:{id:crypto.randomUUID(),name:'기본 파트'},counter:initialCounterState(crypto.randomUUID()),events:[],sessions:[],timerEvents:[],photo:null};
}
