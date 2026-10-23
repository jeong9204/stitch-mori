import {validAdjustment,type AdjustmentCommand,type AdjustmentSnapshot} from '../../domain/timer/adjustments';
import type {AdjustmentStore} from './adjustment-store';
export type AdjustmentView={status:'loading'|'ready'|'saving'|'saved'|'failed'|'conflict';snapshot:AdjustmentSnapshot|null;pending:AdjustmentCommand|null;durable:boolean;error:string};
const INITIAL:AdjustmentView={status:'loading',snapshot:null,pending:null,durable:false,error:''};
export class AdjustmentSession {
  private view=INITIAL;private listeners=new Set<()=>void>();private active=true;private busy=false;
  constructor(readonly store:AdjustmentStore,readonly sessionId:string,private readonly id=()=>crypto.randomUUID()){}
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  getSnapshot=()=>this.view;getServerSnapshot=()=>INITIAL;
  private publish(next:AdjustmentView){if(this.active){this.view=next;this.listeners.forEach(fn=>fn());}}
  activate(){this.active=true;}
  dispose(){this.active=false;this.view=INITIAL;this.listeners.clear();}
  async load(){
    if(this.busy)return;this.busy=true;
    try{const [snapshot,pending]=await Promise.all([this.store.load(this.sessionId),this.store.pending(this.sessionId)]);
      const retained=pending??this.view.pending;this.publish({snapshot,pending:retained,durable:!!pending,status:retained?'failed':'ready',error:retained?'보관된 미확정 정정 요청이 있습니다. 같은 요청으로 재시도해 주세요.':''});
    }catch(e){this.fail(e);}finally{this.busy=false;}
  }
  private fail(e:unknown){this.publish({...this.view,status:'failed',error:e instanceof Error?e.message:'정정을 저장하지 못했습니다.'});}
  async save(adjustedMs:number,reason:string){
    if(this.busy || this.view.pending || !this.view.snapshot?.canAdjust)return;
    const command={requestId:this.id(),sessionId:this.sessionId,expectedRevision:this.view.snapshot.revision,adjustedMs,reason:reason.trim()};
    if(!validAdjustment(command)){this.fail(new Error('정정 값이나 사유가 올바르지 않습니다.'));return;}
    await this.submit(command);
  }
  private async submit(command:AdjustmentCommand){
    if(this.busy || !this.active)return;this.busy=true;this.publish({...this.view,status:'saving',pending:command,error:''});
    try{
      const result=await this.store.submit(command);
      if(result.status==='conflict' || result.status==='rejected') {
        const snapshot=await this.store.load(this.sessionId);
        this.publish({...this.view,snapshot,pending:command,durable:true,status:result.status==='conflict'?'conflict':'failed',error:result.status==='conflict'?'다른 기기에서 정정됐습니다. 요청을 보존했습니다. 최신 이력을 확인한 후 결정해 주세요.':'종료된 세션만 정정할 수 있습니다.'});
      }else{
        const snapshot=await this.store.load(this.sessionId);this.publish({snapshot,pending:null,durable:false,status:'saved',error:''});
      }
    }catch(e){
      let durable=false;try{durable=(await this.store.pending(this.sessionId))?.requestId===command.requestId;}catch{/* preserve in memory */}
      this.publish({...this.view,pending:command,durable});this.fail(e);
    }finally{this.busy=false;}
  }
  async retry(){if(this.view.pending)await this.submit(this.view.pending);else await this.load();}
  async release(){
    if(this.busy || !this.view.pending)return;this.busy=true;
    try{const snapshot=await this.store.load(this.sessionId);await this.store.release(this.sessionId,this.view.pending.requestId);this.publish({snapshot,pending:null,durable:false,status:'ready',error:''});}
    catch(e){this.fail(e);}finally{this.busy=false;}
  }
}
