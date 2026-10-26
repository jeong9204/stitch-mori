import type { ProjectTrackingCommand, ProjectTrackingResult } from "../domain/project/tracking";
import type { ProjectDetail } from "../data/projects/project-part-store";
import { TrackingOccupiedError, type TrackingContext, type TrackingDraft, type TrackingEntry, type TrackingLock, type TrackingOutbox } from "../data/projects/tracking-outbox";
import { parseProgressInput } from "./project-tracking-display";
export type { TrackingDraft } from "../data/projects/tracking-outbox";
export type TrackingTarget = TrackingDraft["target"];
type Phase = "editing" | "saving" | "failed" | "conflict" | "review" | "refresh_failed" | "saved" | "storage_failed" | "recovery_failed" | "blocked";
export type TrackingEditorState = {
  draft: TrackingDraft | null; server: TrackingContext | null; latest: TrackingContext | null;
  refreshing: boolean; restoring: boolean; initialized: boolean; durable: boolean; restored: boolean;
  phase: Phase; pending: ProjectTrackingCommand | null; peer: TrackingEntry | null; error: string; replacedRequestId: string | null;
};
type Dependencies = {
  userId: string; projectId: string; outbox: TrackingOutbox; lock: TrackingLock;
  apply: (command: ProjectTrackingCommand) => Promise<ProjectTrackingResult>;
  detail: () => Promise<ProjectDetail | null>; checkUser: () => Promise<void>; onSaved: (detail: ProjectDetail) => void; requestId?: () => string;
};
const blank = (): TrackingEditorState => ({ draft:null,server:null,latest:null,refreshing:false,restoring:false,initialized:false,durable:false,restored:false,phase:"editing",pending:null,peer:null,error:"",replacedRequestId:null });
function context(detail:TrackingContext,target:TrackingTarget):TrackingContext {
  return {id:detail.id,revision:detail.revision,progressPercent:detail.progressPercent,parts:target.type==="part"?detail.parts.filter(p=>p.id===target.partId).map(p=>({id:p.id,status:p.status})):[]};
}
/** One durable unresolved command per account/project; never auto-replays or touches counter queues. */
export class ProjectTrackingSession {
  private state=blank(); private entry:TrackingEntry|null=null; private latestDetail:ProjectDetail|null=null;
  private listeners=new Set<()=>void>(); private active=true; private generation=0; private inFlight=false; private restoring:Promise<void>|null=null;
  constructor(private readonly deps:Dependencies) {}
  snapshot=()=>this.state;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  activate(){this.active=true;}
  deactivate(){this.active=false;this.generation++;this.inFlight=false;this.restoring=null;}
  private patch(patch:Partial<TrackingEditorState>){if(this.active){this.state={...this.state,...patch};this.listeners.forEach(fn=>fn());}}
  private valid(epoch:number){return this.active&&epoch===this.generation;}
  private adopt(entry:TrackingEntry){
    this.entry=entry;this.latestDetail=null;
    this.patch({draft:entry.draft,server:entry.base,latest:entry.latest,pending:entry.command,peer:null,durable:true,restored:true,initialized:true,
      phase:entry.stage==="conflict"?"conflict":entry.stage==="confirmed"?"refresh_failed":"failed",error:"보관된 요청을 복원했습니다. 내용을 확인한 뒤 같은 요청으로 재시도해 주세요."});
  }
  async restore():Promise<void>{
    if(this.inFlight)return;
    if(this.restoring)return this.restoring;
    const epoch=this.generation;this.patch({restoring:true});
    this.restoring=(async()=>{try{
      const entry=await this.deps.outbox.read(this.deps.userId,this.deps.projectId);
      if(!this.valid(epoch))return;
      if(entry){
        if(this.state.pending?.requestId===entry.command.requestId && this.entry?.version===entry.version && this.state.durable){this.patch({initialized:true});return;}
        if((this.state.draft&&!this.state.pending)||(this.state.pending&&entry.command.requestId!==this.state.pending.requestId)){this.patch({peer:entry,phase:"blocked",initialized:true,error:"다른 탭의 미확정 요청이 있습니다. 현재 편집 중인 입력은 별도로 유지하고 있어요."});}
        else this.adopt(entry);
      }else if(this.state.pending){this.patch({initialized:true,durable:false,phase:this.entry?.stage==="conflict"?"conflict":"failed",error:"다른 탭에서 보관 상태가 바뀌었습니다. 원래 요청을 유지했어요. 같은 요청으로 결과를 확인해 주세요."});}
      else this.patch({initialized:true,error:"",phase:this.state.phase==="saved"?"saved":"editing",peer:null});
    }catch(e){if(this.valid(epoch))this.patch({phase:"recovery_failed",initialized:false,error:this.message(e)});}
    finally{if(this.valid(epoch)){this.restoring=null;this.patch({restoring:false});}}})();
    return this.restoring;
  }
  async useStored(){
    if(this.inFlight)return;
    this.inFlight=true;const epoch=this.generation;
    try{await this.deps.checkUser();const entry=await this.deps.outbox.read(this.deps.userId,this.deps.projectId);if(!this.valid(epoch))return;
      if(entry)this.adopt(entry);else{const latest=await this.deps.detail();await this.deps.checkUser();if(!this.valid(epoch))return;if(latest)this.deps.onSaved(latest);this.entry=null;this.patch({...blank(),initialized:true});}
    }catch(e){if(this.valid(epoch))this.patch({error:this.message(e)});}finally{if(this.valid(epoch))this.inFlight=false;}
  }
  open(target:TrackingTarget,server:ProjectDetail){
    if(this.state.pending||this.state.peer||!this.state.initialized)return;
    const part=target.type==="part"?server.parts.find(p=>p.id===target.partId):null;if(target.type==="part"&&!part)return;
    this.entry=null;this.latestDetail=null;
    this.patch({...blank(),initialized:true,server:context(server,target),draft:{target,text:server.progressPercent?.toString()??"",unset:server.progressPercent===null,partStatus:part?.status??"not_started"}});
  }
  edit(patch:Partial<Pick<TrackingDraft,"text"|"unset"|"partStatus">>){
    if(this.state.draft&&this.state.phase==="editing"&&!this.inFlight)this.patch({draft:{...this.state.draft,...patch},error:""});
  }
  async cancel():Promise<boolean>{
    if(this.inFlight)return false;
    if(!this.state.pending){this.patch({...blank(),initialized:this.state.initialized});return true;}
    if(!["conflict","review"].includes(this.state.phase)||!this.entry)return false;
    this.inFlight=true;const epoch=this.generation;
    try{
      let followup:TrackingEntry|null=null;
      await this.deps.lock(this.scope(),async()=>{
        await this.deps.checkUser();if(!this.valid(epoch))return;
        const current=await this.deps.outbox.read(this.deps.userId,this.deps.projectId);
        if(!current){if(this.entry!.stage!=="conflict")throw new Error("요청 상태를 다시 확인해 주세요.");}
        else if(current.command.requestId!==this.entry!.command.requestId){
          if(this.entry!.stage!=="conflict"||current.replacesRequestId!==this.entry!.command.requestId)throw new Error("다른 탭의 요청을 먼저 확인해 주세요.");
          followup=current; // Acknowledge only this already-rejected conflict; never delete its replacement.
        }else await this.deps.outbox.resolve(this.entry!);
        const latest=await this.deps.detail();await this.deps.checkUser();if(this.valid(epoch)&&latest)this.latestDetail=latest;
      });
      if(!this.valid(epoch))return false;
      if(this.latestDetail)this.deps.onSaved(this.latestDetail);
      if(followup)this.adopt(followup);else{this.entry=null;this.patch({...blank(),initialized:true});}return true;
    }catch(e){if(this.valid(epoch))this.patch({error:this.message(e)});return false;}finally{if(this.valid(epoch))this.inFlight=false;}
  }
  private command(revision:number):ProjectTrackingCommand{
    const {draft}=this.state;if(!draft)throw new Error("수정할 입력이 없습니다.");
    return{projectId:this.deps.projectId,requestId:this.deps.requestId?.()??crypto.randomUUID(),expectedRevision:revision,
      action:draft.target.type==="progress"?{type:"setProgress",value:parseProgressInput(draft.text,draft.unset)}:{type:"setPartStatus",partId:draft.target.partId,status:draft.partStatus}};
  }
  private envelope(command:ProjectTrackingCommand,base:TrackingContext):TrackingEntry{
    const now=new Date().toISOString();return{userId:this.deps.userId,projectId:this.deps.projectId,command,draft:structuredClone(this.state.draft!),base:context(base,this.state.draft!.target),createdAt:now,updatedAt:now,version:0,stage:"queued",latest:null,replacesRequestId:this.state.replacedRequestId};
  }
  async save(){
    if(!this.state.initialized){await this.restore();return;}
    if(this.inFlight||this.state.pending||this.state.peer||!this.state.server)return;
    try{await this.send(this.command(this.state.server.revision));}catch(e){this.patch({error:this.message(e)});}
  }
  async retry(){
    if(!this.state.pending||this.inFlight||!this.state.initialized||["conflict","review"].includes(this.state.phase))return;
    await this.send(this.state.pending);
  }
  async confirmReviewedSave(){
    const {latest,draft,pending}=this.state;
    if(this.state.phase!=="review"||!latest||!draft||!pending||!this.entry||this.inFlight)return;
    if(draft.target.type==="part"&&!latest.parts.some(p=>p.id===(draft.target as {partId:string}).partId))return;
    const previous=this.entry;
    try{this.patch({replacedRequestId:pending.requestId});await this.send(this.command(latest.revision),previous,latest);}catch(e){this.patch({error:this.message(e)});}
  }
  async refreshLatest(){
    if(this.inFlight||!this.state.pending)return;
    this.inFlight=true;this.patch({refreshing:true});const epoch=this.generation;
    try{await this.deps.lock(this.scope(),async()=>{
      await this.deps.checkUser();if(!this.valid(epoch))return;
      const detail=await this.deps.detail();await this.deps.checkUser();if(!this.valid(epoch))return;
      if(!detail)throw new Error("프로젝트를 조회할 수 없습니다. 삭제 여부와 계정을 확인해 주세요.");
      const latest=context(detail,this.state.draft!.target);
      if(this.entry)this.entry=await this.deps.outbox.update(this.entry,{latest});
      if(!this.valid(epoch))return;
      this.latestDetail=detail;this.patch({latest,restored:false,error:"",phase:["conflict","review"].includes(this.state.phase)?"review":this.state.phase});
    });}catch(e){if(this.valid(epoch))this.patch({error:this.message(e)});}finally{if(this.valid(epoch)){this.inFlight=false;this.patch({refreshing:false});}}
  }
  private scope(){return`${this.deps.userId}:${this.deps.projectId}`;}
  private message(e:unknown){return e instanceof Error?e.message:"저장 결과를 확인하지 못했습니다. 요청을 보존했어요.";}
  private async send(command:ProjectTrackingCommand,replace?:TrackingEntry,base?:TrackingContext){
    this.inFlight=true;const epoch=this.generation;this.patch({phase:"saving",pending:command,error:"",restored:false});
    let confirmed=false,stored=!!(!replace&&this.state.durable&&this.entry?.command.requestId===command.requestId);
    try{await this.deps.lock(this.scope(),async()=>{
      await this.deps.checkUser();if(!this.valid(epoch))return;
      const candidate=this.envelope(command,base??this.state.server!);
      this.entry=replace?await this.deps.outbox.replace(replace,candidate):await this.deps.outbox.reserve(candidate);
      stored=true;if(!this.valid(epoch))return;this.patch({durable:true});
      if(this.entry.stage==="conflict"){this.adopt(this.entry);return;}
      confirmed=this.entry.stage==="confirmed";
      if(!confirmed)this.entry=await this.deps.outbox.update(this.entry,{stage:"sending"});
      {
        await this.deps.checkUser();if(!this.valid(epoch))return;
        const result=await this.deps.apply(command);await this.deps.checkUser();if(!this.valid(epoch))return;
        if(result.status==="conflict"){
          this.entry=await this.deps.outbox.update(this.entry,{stage:"conflict",latest:null});
          if(this.valid(epoch))this.patch({phase:"conflict",latest:null,error:"다른 화면에서 프로젝트가 변경됐습니다. 입력과 요청을 기기에 보관했어요. 최신 값을 확인해 주세요."});return;
        }
        confirmed=true;this.entry=await this.deps.outbox.update(this.entry,{stage:"confirmed"});
      }
      const latest=await this.deps.detail();await this.deps.checkUser();if(!this.valid(epoch))return;
      if(!latest)throw new Error("서버 저장은 확인됐지만 프로젝트를 다시 조회하지 못했습니다.");
      await this.deps.outbox.resolve(this.entry);if(!this.valid(epoch))return;
      const savedContext=context(latest,this.state.draft!.target);this.entry=null;this.deps.onSaved(latest);this.patch({phase:"saved",draft:null,server:savedContext,pending:null,peer:null,durable:false,latest:savedContext,error:""});
    });}catch(e){
      if(!this.valid(epoch))return;
      if(e instanceof TrackingOccupiedError){this.patch({phase:"blocked",durable:false,error:e.message});}
      else{
        if(stored&&this.entry&&!confirmed&&this.entry.stage==="sending"){
          try{this.entry=await this.deps.lock(this.scope(),()=>this.deps.outbox.update(this.entry!,{stage:"waiting"}));}catch{/* Preserve the committed command even if status journaling fails. */}
        }
        if(this.valid(epoch))this.patch({phase:confirmed?"refresh_failed":stored?"failed":"storage_failed",durable:stored,error:this.message(e)});
      }
    }finally{if(this.valid(epoch))this.inFlight=false;}
  }
}
