import type { CounterEvent } from "../../domain/counter/types";
import type { TimerAction, TimerCommand } from "../../domain/timer/types";
import { createTimerClock, elapsedMilliseconds } from "../../domain/timer/engine";
import type { TimerContext, TimerMode, TimerUiBackend } from "./timer-ui-backend";
export type TimerView = { status: "loading" | "ready" | "saving" | "failed" | "conflict"; context: TimerContext | null; pending: TimerCommand | null; durable: boolean; error: string };
const INITIAL: TimerView={status:"loading",context:null,pending:null,durable:false,error:""};
export function isCountChange(event: CounterEvent): boolean {
  return event.action.type!=="setTarget" && (event.before.stitch.current!==event.after.stitch.current || event.before.row.current!==event.after.row.current);
}
const messages: Record<string,string>={active_session_exists:"다른 작업에 미종료 타이머가 있습니다. 먼저 해당 작업의 세션을 종료해 주세요.",invalid_transition:"다른 화면에서 타이머 상태가 바뀌었습니다. 최신 상태를 확인해 주세요.",session_ended:"이미 종료된 세션입니다.",project_or_part_unavailable:"진행 중이며 삭제되지 않은 프로젝트·파트에서만 시작하거나 재개할 수 있습니다.",clock_before_last_transition:"기기 시각이 이전 기록보다 이릅니다. 시각을 확인해 주세요.",pending_timer_command_requires_resolution:"보관된 타이머 요청을 먼저 확인해 주세요."};
export class TimerController {
  private view: TimerView=INITIAL;
  private listeners=new Set<()=>void>();
  private loading: Promise<void> | null=null;
  private loaded=false;
  private busy=false;
  private operationVersion=0;
  private active=true;
  private floor: number;
  private clock: ()=>string=()=>new Date().toISOString();
  private confirmations: Promise<void>=Promise.resolve();
  constructor(public readonly backend: TimerUiBackend, baselineRevision: number,
    private readonly now=()=>new Date().toISOString(), private readonly id=()=>crypto.randomUUID()) { this.floor=baselineRevision; }
  getSnapshot=()=>this.view;
  getServerSnapshot=()=>INITIAL;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private publish(next: TimerView) {
    if(!this.active)return;
    if(next.context && next.context!==this.view.context) {
      this.clock=this.backend.server ? createTimerClock(next.context.serverNow,()=>performance.now()) : this.now;
    }
    this.view=next;for(const fn of this.listeners)fn();
  }
  dispose() {this.active=false;this.view=INITIAL;this.listeners.forEach(fn=>fn());this.listeners.clear();}
  private begin() {this.busy=true;this.operationVersion++;}
  private async context(): Promise<TimerContext> {
    const context=await this.backend.load();
    if (!this.active) throw new Error("타이머 계정 상태를 다시 확인해 주세요.");
    return context;
  }
  load(): Promise<void> {
    if(this.loading)return this.loading;
    if(this.busy)return Promise.resolve();
    this.loading=this.loadNow().finally(()=>{this.loading=null;});return this.loading;
  }
  private async loadNow() {
    const version=this.operationVersion;
    try {
      const [context,pending,marker]=await Promise.all([this.context(),this.backend.pending(),this.backend.readMarker()]);
      this.floor=Math.max(this.floor,marker);this.loaded=true;
      // A background refresh must not overwrite a newer user operation.
      if(this.busy || version!==this.operationVersion)return;
      const preserved=pending ?? this.view.pending;
      this.publish({context,pending:preserved,durable:!!pending,status:preserved?"failed":"ready",error:preserved?"미확정 타이머 요청을 보존했습니다. 최신 상태를 확인한 뒤 같은 요청으로 재시도해 주세요.":""});
    } catch(e) {if(!this.busy && version===this.operationVersion)this.fail(e);}
  }
  private fail(error: unknown) {
    const raw=error instanceof Error?error.message:String(error);
    this.publish({...this.view,status:"failed",error:messages[raw] ?? (/fetch|network/i.test(raw)?"서버에 연결하지 못했습니다. 연결을 확인하고 재시도해 주세요.":raw)});
  }
  elapsed(): number {
    return this.view.context?.state ? elapsedMilliseconds(this.view.context.state,this.clock()) : 0;
  }
  async setMode(mode: TimerMode): Promise<void> {
    if(this.busy || this.view.pending || !this.view.context)return;
    this.begin();this.publish({...this.view,status:"saving",error:""});
    try {await this.backend.setMode(mode,this.view.context.modeRevision);const context=await this.context();this.publish({...this.view,context,status:"ready",error:""});}
    catch(e){this.fail(e);}finally{this.busy=false;}
  }
  async action(action: TimerAction): Promise<void> {
    if(this.busy || this.view.pending || !this.active)return;
    this.begin();this.publish({...this.view,status:"saving",error:""});
    try {
      // Build from the last confirmed snapshot so offline pause/end is retained
      // before network I/O. The server validates the unchanged revision.
      const context=this.view.context ?? await this.context();
      this.publish({...this.view,context});
      if((action==="start" || action==="resume") && !context.canStart)throw new Error("project_or_part_unavailable");
      if(context.active && context.active.workItemId!==this.backend.workItemId)throw new Error("active_session_exists");
      const state=context.state;
      if(action!=="start" && (!state || state.status==="ended"))throw new Error("session_ended");
      await this.send({commandId:this.id(),sessionId:action==="start"?this.id():state!.sessionId,
        workItemId:this.backend.workItemId,expectedRevision:action==="start"?0:state!.revision,
        action,occurredAt:this.now(),deviceId:await this.backend.deviceId()});
    }catch(e){this.fail(e);}finally{this.busy=false;}
  }
  private async send(command: TimerCommand) {
    if(!this.active)return;
    this.publish({...this.view,status:"saving",pending:command,durable:false,error:""});
    try {
      const result=await this.backend.send(command);
      if(!this.active)return;
      if(result.status==="conflict" || result.status==="rejected") {
        const context=await this.context();
        this.publish({...this.view,context,pending:command,durable:true,status:result.status==="conflict"?"conflict":"failed",
          error:result.status==="conflict"?"다른 화면에서 세션이 변경됐습니다. 보관된 명령은 새 revision에 자동 적용하지 않습니다.":messages[result.reason] ?? result.reason});
        return;
      }
      // Acknowledgement may refer to an old event. Always reload latest state.
      const context=await this.context();
      this.publish({context,pending:null,durable:false,status:"ready",error:""});
    } catch(e) {
      let durable=false;try{durable=(await this.backend.pending())?.commandId===command.commandId;}catch{/* Keep the in-memory envelope. */}
      this.publish({...this.view,pending:command,durable});this.fail(e);
    }
  }
  async retry(): Promise<void> {
    if(this.busy || !this.view.pending)return;
    if(this.view.pending.workItemId!==this.backend.workItemId){this.fail(new Error("보관된 요청이 속한 작업에서 확인해 주세요."));return;}
    this.begin();try{await this.send(this.view.pending);}finally{this.busy=false;}
  }
  async releasePending(): Promise<void> {
    if(this.busy || !this.view.pending || this.view.pending.workItemId!==this.backend.workItemId)return;
    this.begin();
    try {await this.context();await this.backend.release(this.view.pending.commandId);this.publish({...this.view,pending:null});}
    catch(e){this.fail(e);}finally{this.busy=false;}
    if(!this.view.pending)await this.load();
  }
  /** Only persistence acknowledgements call this; historical loads and optimistic previews do not. */
  confirmed(event: CounterEvent): Promise<void> {
    const eligibleAtReceipt=!this.busy;
    const task=this.confirmations.then(async()=>{
      let ownsBusy=false;
      if(!this.active || event.workItemId!==this.backend.workItemId || !isCountChange(event))return;
      if(!this.loaded)await this.load();
      if(!this.loaded || event.after.revision<=this.floor)return;
      this.floor=event.after.revision;
      try {
        if(this.view.context?.mode!=="auto")return;
        await this.backend.writeMarker(this.floor);
        if(!eligibleAtReceipt || this.busy || this.view.pending || this.view.context?.mode!=="auto" || (this.view.context.state && this.view.context.state.status!=="ended"))return;
        this.begin();ownsBusy=true;
        const context=await this.context();this.publish({...this.view,context});
        if(context.mode!=="auto" || event.after.revision<=context.activationRevision || !context.canStart)return;
        if(context.state && context.state.status!=="ended")return;
        if(context.active){this.fail(new Error("active_session_exists"));return;}
        this.begin();
        await this.send({commandId:event.commandId,sessionId:event.commandId,workItemId:this.backend.workItemId,
          expectedRevision:0,action:"start",occurredAt:event.occurredAt,deviceId:event.deviceId});
      }catch(e){
        if(eligibleAtReceipt && !this.view.pending && this.view.context?.mode==="auto" && (!this.view.context.state || this.view.context.state.status==="ended")) {
          this.publish({...this.view,pending:{commandId:event.commandId,sessionId:event.commandId,workItemId:this.backend.workItemId,
            expectedRevision:0,action:"start",occurredAt:event.occurredAt,deviceId:event.deviceId},durable:false});
        }
        this.fail(e);
      }finally{if(ownsBusy)this.busy=false;}
    });
    this.confirmations=task.catch(()=>undefined);return this.confirmations;
  }
}
