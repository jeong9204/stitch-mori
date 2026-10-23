import type {SupabaseClient} from '@supabase/supabase-js';
import {CounterImportService} from '../import/import-service';
import {SupabaseImportStore} from '../import/supabase-import-store';
import type {IndexedDbCounterStore} from '../local/indexeddb-counter-store';
import {IndexedDbServerCommandQueue} from '../remote/server-command-queue';
import {IndexedDbTimerStore} from './indexeddb-timer-store';
import type {TimerImportReceipt,TimerImportSnapshot} from '../../domain/timer/imports';
export class TimerImportService {
 constructor(private readonly timers:IndexedDbTimerStore,private readonly counters:IndexedDbCounterStore,private readonly client:SupabaseClient,
 private readonly userId:string,private readonly localPending:()=>Promise<boolean>,private readonly queue=new IndexedDbServerCommandQueue()){}
 private async auth(){const {data,error}=await this.client.auth.getClaims();if(error||data?.claims?.sub!==this.userId)throw new Error('로그인 계정이 변경되었습니다.');}
 async import():Promise<TimerImportReceipt>{
  await this.auth();
  const record=await this.counters.getQuickIfExists();if(!record)throw new Error('연결할 로컬 카운터가 없습니다.');
  if(record.importedByUserId&&record.importedByUserId!==this.userId)throw new Error('다른 계정에 연결된 기록입니다.');
  if(await this.localPending())throw new Error('로컬 카운터 저장을 먼저 완료해 주세요.');
  if(record.serverWorkItemId&&(await this.queue.pending(this.userId,record.serverWorkItemId)).length)throw new Error('서버 미확정 카운터 명령을 먼저 처리해 주세요.');
  const snapshot=await this.timers.freezeTimerImport(this.userId,record.localWorkItemId,record.importId);
  let serverId=record.serverWorkItemId;
  if(!serverId){
   const importer=new CounterImportService(this.counters,{importSnapshot:async source=>{await this.auth();const receipt=await new SupabaseImportStore(this.client).importSnapshot(source);await this.auth();return receipt;}});
   serverId=(await importer.import(record.localWorkItemId,this.userId)).serverWorkItemId;
  }
  if((await this.queue.pending(this.userId,serverId)).length||await this.timers.pending(this.userId))throw new Error('계정의 미확정 명령을 먼저 처리해 주세요. 가져오기 스냅샷은 보관했습니다.');
  await this.auth();const receipt=await this.send(snapshot);await this.auth();
  if(receipt.serverWorkItemId!==serverId)throw new Error('연결할 서버 작업이 일치하지 않습니다.');
  await this.timers.finishTimerImport(this.userId,snapshot,receipt);return receipt;
 }
 private async send(snapshot:TimerImportSnapshot):Promise<TimerImportReceipt>{
  const {data,error}=await this.client.rpc('import_timer_snapshot',{p_payload:snapshot});if(error)throw new Error(error.code==='23505'?'다른 계정에 연결되었거나 중복된 로컬 세션입니다. 원래 계정의 기록을 확인해 주세요.':error.message);
  if(!data||!['imported','duplicate'].includes(data.status)||data.importId!==snapshot.importId||!Array.isArray(data.mappings)||data.mappings.some((m:{localSessionId?:string;serverSessionId?:string})=>!m.localSessionId||!m.serverSessionId))throw new Error('가져오기 응답을 확인하지 못했습니다. 같은 요청으로 재시도해 주세요.');return data;
 }
}
