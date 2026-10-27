import {lastUndoableEvent} from '../../../src/domain/counter/engine';
import type {CounterAction,CounterCommand} from '../../../src/domain/counter/types';
import type {TimerCommand} from '../../../src/domain/timer/types';
import {PocStore,RejectedCommand} from './store';
import type {Photo,Snapshot} from './model';
type Task={kind:'counter';action:CounterAction|'undo';command?:CounterCommand}|{kind:'timer';action:'start'|'end';command?:TimerCommand}|{kind:'photo';photo:Photo}|{kind:'create';name:string}|{kind:'restore';snapshot:Snapshot};
export class PocSession{
  private state:{snapshot:Snapshot|null;pending:number;busy:boolean;error:string;initialized:boolean;rejected:boolean}={snapshot:null,pending:0,busy:false,error:'',initialized:false,rejected:false};
  private listeners=new Set<()=>void>();private queue:Task[]=[];private draining:Promise<void>|null=null;private loading:Promise<void>|null=null;
  constructor(readonly store=new PocStore()){}
  snapshot=()=>this.state;subscribe=(f:()=>void)=>{this.listeners.add(f);return()=>{this.listeners.delete(f);};};
  private publish(patch:Partial<typeof this.state>){this.state={...this.state,...patch};this.listeners.forEach(f=>f());}
  load(){if(this.draining||this.queue.length)return Promise.resolve();return this.loading??=this.store.read().then(snapshot=>this.publish({snapshot,initialized:true,error:''})).catch(e=>this.publish({error:String(e instanceof Error?e.message:e),initialized:false})).finally(()=>{this.loading=null;});}
  counter(action:CounterAction|'undo'){return this.add({kind:'counter',action});}
  timer(action:'start'|'end'){if(this.state.pending)return false;return this.add({kind:'timer',action});}
  photo(photo:Photo){return this.add({kind:'photo',photo});}
  create(name:string){return this.add({kind:'create',name});}
  restore(snapshot:Snapshot){if(this.state.pending)return false;return this.add({kind:'restore',snapshot});}
  private add(task:Task){if(!this.state.initialized||this.state.error)return false;this.queue.push(task);this.publish({pending:this.queue.length,busy:true});void this.drain();return true;}
  dismissRejected(){if(!this.state.rejected||this.draining)return;this.queue.shift();this.publish({error:'',rejected:false,pending:this.queue.length});void this.drain();}
  retry(){if(!this.queue.length)return this.load();this.publish({error:'',rejected:false});return this.drain();}
  settled(){return this.draining??Promise.resolve();}
  private drain(){return this.draining??=this.run().finally(()=>{this.draining=null;});}
  private async run(){
    while(this.queue.length){const task=this.queue[0];try{
      if(task.kind==='create')await this.store.create(task.name);
      else if(task.kind==='photo')await this.store.photo(task.photo);
      else if(task.kind==='restore')await this.store.restore(task.snapshot);
      else{
        const value=await this.store.read();if(!value)throw new Error('프로젝트를 먼저 만들어 주세요.');
        if(task.kind==='counter'){
          if(!task.command){const action=task.action==='undo'?{type:'undo' as const,eventId:lastUndoableEvent(value.events)?.eventId??''}:task.action;task.command={commandId:crypto.randomUUID(),workItemId:value.counter.workItemId,expectedRevision:value.counter.revision,occurredAt:new Date().toISOString(),deviceId:await this.store.device(),action};}
          await this.store.counter(task.command);
        }else{
          if(!task.command){const active=value.sessions.find(s=>s.status!=='ended');if(task.action==='end'&&!active)throw new Error('실행 중인 세션이 없습니다.');task.command={commandId:crypto.randomUUID(),sessionId:task.action==='start'?crypto.randomUUID():active!.sessionId,workItemId:value.counter.workItemId,expectedRevision:task.action==='start'?0:active!.revision,occurredAt:new Date().toISOString(),deviceId:await this.store.device(),action:task.action};}
          await this.store.timer(task.command);
        }
      }
      const snapshot=await this.store.read();this.queue.shift();this.publish({snapshot,pending:this.queue.length,error:''});
    }catch(e){this.publish({rejected:e instanceof RejectedCommand,error:e instanceof Error?e.message:'저장 실패',pending:this.queue.length,busy:false});return;}}
    this.publish({busy:false});
  }
}
