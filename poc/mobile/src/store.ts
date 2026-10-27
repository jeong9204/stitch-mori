import { applyCounterCommand } from '../../../src/domain/counter/engine';
import { applyTimerCommand } from '../../../src/domain/timer/engine';
import type { TimerCommand } from '../../../src/domain/timer/types';
import {createSnapshot,DB_NAME,same,validateSnapshot,type Snapshot,type CounterCommand,type Photo,type TimerEvent} from './model';
const request=<T>(r:IDBRequest<T>)=>new Promise<T>((ok,no)=>{r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error??new Error('IndexedDB 요청 실패'));});
export class RejectedCommand extends Error {}
export class PocStore {
  private opened:Promise<IDBDatabase>|null=null;
  constructor(private name=DB_NAME){}
  private db(){return this.opened??=new Promise<IDBDatabase>((ok,no)=>{
    const r=indexedDB.open(this.name,1);r.onupgradeneeded=()=>r.result.createObjectStore('workspace');
    r.onsuccess=()=>{r.result.onversionchange=()=>{r.result.close();this.opened=null;};ok(r.result);};
    r.onerror=()=>{this.opened=null;no(r.error);};r.onblocked=()=>{this.opened=null;no(new Error('다른 PoC 탭을 닫은 뒤 다시 시도해 주세요.'));};
  });}
  private async tx<T>(mode:IDBTransactionMode,work:(s:IDBObjectStore)=>Promise<T>):Promise<T>{
    const db=await this.db(),tx=db.transaction('workspace',mode,mode==='readwrite'?{durability:'strict'}:undefined);
    const done=new Promise<void>((ok,no)=>{tx.oncomplete=()=>ok();tx.onerror=tx.onabort=()=>no(tx.error??new Error('로컬 저장이 중단됐습니다.'));});void done.catch(()=>undefined);
    try{const value=await work(tx.objectStore('workspace'));await done;return value;}catch(e){try{tx.abort();}catch{/* already settled */}throw e;}
  }
  async read():Promise<Snapshot|null>{return this.tx('readonly',async s=>(await request(s.get('snapshot')))??null);}
  async device(){return this.tx('readwrite',async s=>{let id=await request(s.get('device')) as string|undefined;if(!id){id=crypto.randomUUID();s.put(id,'device');}return id;});}
  async create(name:string){const candidate=createSnapshot(name);return this.tx('readwrite',async s=>{if(await request(s.get('snapshot')))throw new Error('PoC는 프로젝트 1개만 지원합니다.');await request(s.put(candidate,'snapshot'));});}
  private async change(work:(value:Snapshot)=>void){return this.tx('readwrite',async s=>{const value=await request(s.get('snapshot')) as Snapshot|undefined;if(!value)throw new Error('프로젝트를 먼저 만들어 주세요.');work(value);await request(s.put(value,'snapshot'));});}
  async counter(command:CounterCommand){await this.change(value=>{
    const duplicate=value.events.find(e=>e.commandId===command.commandId);
    if(duplicate&&!same(command,{commandId:duplicate.commandId,workItemId:duplicate.workItemId,expectedRevision:duplicate.before.revision,occurredAt:duplicate.occurredAt,deviceId:duplicate.deviceId,action:duplicate.action}))throw new Error('같은 명령 ID의 내용이 다릅니다.');
    const result=applyCounterCommand(value.counter,value.events,command);
    if(result.status==='conflict')throw new Error('다른 PoC 탭에서 변경됐습니다. 원래 명령을 유지합니다.');
    if(result.status==='rejected')throw new RejectedCommand(result.reason);
    if(result.status==='applied'&&result.event){value.counter=result.state;value.events.push(result.event);}
  });}
  async timer(command:TimerCommand){await this.change(value=>{
    if(command.workItemId!==value.counter.workItemId)throw new Error('작업 ID가 다릅니다.');
    const active=value.sessions.find(s=>s.status!=='ended');
    const state=value.sessions.find(s=>s.sessionId===command.sessionId)??null;
    const result=applyTimerCommand(state,value.timerEvents,command);
    if(result.status==='conflict')throw new Error('타이머가 다른 탭에서 변경됐습니다.');
    if(result.status==='rejected')throw new RejectedCommand(result.reason);
    if(result.status==='applied'){if(command.action==='start'&&active&&active.sessionId!==command.sessionId)throw new Error('이미 실행 중인 타이머가 있습니다.');const event:TimerEvent={eventId:command.commandId,command,effectiveAt:result.state.updatedAt,before:state,after:result.state};value.timerEvents.push(event);value.sessions=value.sessions.filter(s=>s.sessionId!==command.sessionId);value.sessions.push(result.state);}
  });}
  async photo(photo:Photo){await this.change(value=>{value.photo=photo;});}
  async restore(snapshot:Snapshot){validateSnapshot(snapshot);await this.tx('readwrite',async s=>{await request(s.put(snapshot,'snapshot'));});}
}
