import type {SupabaseClient} from '@supabase/supabase-js';
import type {AdjustmentCommand,AdjustmentResult,AdjustmentSnapshot} from '../../domain/timer/adjustments';
import {IndexedDbTimerStore} from './indexeddb-timer-store';
export interface AdjustmentStore {
  scope:string;load(sessionId:string):Promise<AdjustmentSnapshot>;pending(sessionId:string):Promise<AdjustmentCommand|null>;
  submit(command:AdjustmentCommand):Promise<AdjustmentResult>;release(sessionId:string,requestId:string):Promise<void>;
}
export class LocalAdjustmentStore implements AdjustmentStore {
  readonly scope='local';
  constructor(private readonly store=new IndexedDbTimerStore()){}
  load(sessionId:string){return this.store.adjustmentSnapshot(sessionId);}
  pending(sessionId:string){return this.store.pendingAdjustment(this.scope,sessionId);}
  async submit(command:AdjustmentCommand){await this.store.retainAdjustment(this.scope,command);return this.store.applyLocalAdjustment(command);}
  release(sessionId:string,requestId:string){return this.store.releaseAdjustment(this.scope,sessionId,requestId);}
}
export class AccountAdjustmentStore implements AdjustmentStore {
  readonly scope:string;
  constructor(private readonly client:SupabaseClient,private readonly userId:string,private readonly store=new IndexedDbTimerStore()){this.scope=`account:${userId}`;}
  private async auth(){const {data,error}=await this.client.auth.getClaims();if(error||data?.claims?.sub!==this.userId)throw new Error('로그인 계정이 변경되었습니다.');}
  async load(sessionId:string):Promise<AdjustmentSnapshot>{
    await this.auth();const {data,error}=await this.client.rpc('get_work_time_adjustments',{p_session_id:sessionId});
    if(error)throw new Error(error.message);await this.auth();
    if(data?.session?.userId!==this.userId || data.session.sessionId!==sessionId || !Array.isArray(data.adjustments) || data.adjustments.some((a:{userId:string})=>a.userId!==this.userId))throw new Error('정정 응답의 소유권을 확인할 수 없습니다.');return data;
  }
  async pending(sessionId:string){await this.auth();const pending=await this.store.pendingAdjustment(this.scope,sessionId);await this.auth();return pending;}
  async submit(command:AdjustmentCommand):Promise<AdjustmentResult>{
    await this.auth();await this.store.retainAdjustment(this.scope,command);
    const {data,error}=await this.client.rpc('adjust_work_session_time',{p_request_id:command.requestId,p_session_id:command.sessionId,p_expected_revision:command.expectedRevision,p_adjusted_ms:command.adjustedMs,p_reason:command.reason});
    if(error)throw new Error(error.message);await this.auth();
    if(!data || !['applied','duplicate','conflict','rejected'].includes(data.status))throw new Error('정정 결과를 확인할 수 없습니다.');
    if(data.status==='applied'||data.status==='duplicate'){
      if(data.adjustment?.commandId!==command.requestId || data.adjustment.sessionId!==command.sessionId || data.adjustment.userId!==this.userId || data.adjustment.revision!==command.expectedRevision+1 || data.adjustment.adjustedMs!==command.adjustedMs)throw new Error('정정 결과가 요청과 일치하지 않습니다.');
      await this.store.releaseAdjustment(this.scope,command.sessionId,command.requestId);
    }return data;
  }
  async release(sessionId:string,requestId:string){await this.auth();await this.load(sessionId);await this.store.releaseAdjustment(this.scope,sessionId,requestId);}
}
