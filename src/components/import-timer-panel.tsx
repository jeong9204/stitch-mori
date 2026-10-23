"use client";
import Link from 'next/link';
import {useEffect,useRef,useState,useCallback} from 'react';
import {createClient} from '@/lib/supabase/client';
import {quickCounterStore} from '@/data/local/quick-session';
import {hasPendingQuickTab} from '@/data/local/quick-import-guard';
import {IndexedDbTimerStore} from '@/data/timer/indexeddb-timer-store';
import {hasPendingTimerChanges} from "@/data/timer/timer-import-guard";
import {TimerImportService} from '@/data/timer/timer-import-service';
import type {LocalCounterRecord} from '@/data/local/types';
import type {TimerImportReceipt,TimerImportSnapshot} from '@/domain/timer/imports';
import {effectiveWorkTime} from '@/domain/timer/adjustments';
import {formatWorkTime} from '@/domain/timer/statistics';
type Journal={userId:string;pending:TimerImportSnapshot|null;sources:string[];receipt?:TimerImportReceipt};
export function ImportTimerPanel({userId}:{userId:string}){
 const [client]=useState(createClient),[store]=useState(()=>new IndexedDbTimerStore());
 const [record,setRecord]=useState<LocalCounterRecord|null>(null),[journal,setJournal]=useState<Journal|null>(null);
 const [info,setInfo]=useState({count:0,ms:0,adjustments:0,last:'',active:false}),[target,setTarget]=useState('');
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[authorized,setAuthorized]=useState(true);
 const heading=useRef<HTMLHeadingElement>(null);
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),cancel=useRef<HTMLButtonElement>(null),inFlight=useRef(false);
 const refresh=useCallback(async()=>{
  const local=await quickCounterStore.getQuickIfExists();setRecord(local);
  if(!local){setLoading(false);return;}
  const j=await store.readUi<Journal>(`timer-import:${local.localWorkItemId}`);setJournal(j);
  const source=await store.localStatisticsSource();const states=source.states.filter(s=>s.workItemId===local.localWorkItemId);
  const candidates=j?.pending?.sessions.map(b=>b.state)??states.filter(s=>s.status==='ended'&&!j?.sources.includes(s.sessionId));
  const corrections=j?.pending?.sessions.flatMap(b=>b.adjustments)??source.adjustments;
  setInfo({count:candidates.length,ms:candidates.reduce((sum,s)=>sum+effectiveWorkTime(s,corrections),0),adjustments:corrections.filter(a=>candidates.some(s=>s.sessionId===a.sessionId)).length,last:candidates.map(s=>s.endedAt!).sort().at(-1)??'',active:states.some(s=>s.status!=='ended')});
  if(local.serverWorkItemId&&local.importedByUserId===userId){
   const {data,error}=await client.from('work_items').select('id').eq('id',local.serverWorkItemId).single();
   if(error)setTarget(`연결 작업 ID ${local.serverWorkItemId} · 삭제 여부를 확인해 주세요.`);
   else {const link=await client.rpc('get_counter_project_link',{p_work_item_id:local.serverWorkItemId});if(link.error)throw new Error(link.error.message);setTarget(link.data?`${link.data.projectName} · 연결된 파트 / 작업 ${data?.id??local.serverWorkItemId}${link.data.deleted?' · 삭제 상태':''}`:`일반 계정 작업 ${data?.id??local.serverWorkItemId}`);}
  }else setTarget('카운터를 먼저 가져온 뒤 생성된 계정 작업에 연결');setLoading(false);
 },[client,store,userId]);
 useEffect(()=>{let alive=true;queueMicrotask(()=>{if(alive)void refresh().catch(e=>{if(alive){setError(e.message);setLoading(false);}});});const {data}=client.auth.onAuthStateChange((event,session)=>{if(event==='SIGNED_OUT'||(event==='SIGNED_IN'&&session?.user.id!==userId)){setAuthorized(false);dialog.current?.close();}});return()=>{alive=false;data.subscription.unsubscribe();};},[client,refresh,userId]);
 async function run(){if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');try{await new TimerImportService(store,quickCounterStore,client,userId,async()=>await hasPendingQuickTab()||await hasPendingTimerChanges(userId)).import();window.dispatchEvent(new Event("stitchmori-counter-imported"));await refresh();dialog.current?.close();}catch(e){setError(e instanceof Error?e.message:'가져오기에 실패했습니다.');window.dispatchEvent(new Event("stitchmori-counter-imported"));await refresh().catch(()=>{});}finally{inFlight.current=false;setBusy(false);}}
 if(!authorized)return <p role="status">계정이 변경되어 타이머 가져오기 정보를 숨겼습니다.</p>;
 const other=(record?.importedByUserId&&record.importedByUserId!==userId)||(journal&&journal.userId!==userId);
 return <section className="import-card timer-import-panel" aria-label="로컬 작업 시간 가져오기"><p className="eyebrow">이 기기 → 계정 보관</p><h2 ref={heading} tabIndex={-1}>작업 시간 가져오기</h2>
 {loading?<p role="status">종료 세션을 확인하고 있어요.</p>:<><dl className="import-facts"><div><dt>가져올 종료 세션</dt><dd>{info.count}개</dd></div><div><dt>최종 적용 시간 합계</dt><dd>{formatWorkTime(info.ms)}</dd></div><div><dt>시간 정정 이력</dt><dd>{info.adjustments}건</dd></div><div><dt>마지막 작업</dt><dd>{info.last?new Date(info.last).toLocaleString('ko-KR'):'없음'}</dd></div></dl>
 <p>연결 대상: {target||'로컬 카운터 없음'}</p><p className="timer-help">원본 세션·이벤트·정정 이력을 보존합니다. 로컬 원본은 삭제하지 않습니다. 계정의 기존 세션과 시간이 겹쳐도 병합하지 않아 중복 기록일 수 있습니다. 로컬·계정 통계를 합산하지 마세요.</p>
 {info.active&&<p className="notice">실행 중·일시정지 세션을 먼저 종료한 뒤 가져와 주세요.</p>}
 {other?<p className="notice">다른 계정에 연결된 로컬 기록입니다. 원래 계정에서 확인해 주세요.</p>:<>
 {journal?.pending&&<p className="notice">미확정 가져오기 스냅샷을 보관했습니다. 같은 요청으로 재시도합니다. 완료 전 이 작업의 로컬 타이머 시작·정정을 잠시 제한합니다.</p>}
 {info.count>0?<button className="button" ref={trigger} type="button" disabled={busy||info.active} onClick={()=>{dialog.current?.showModal();cancel.current?.focus();}}>{journal?.pending?'같은 가져오기 재시도':'작업 시간 가져오기'}</button>:<p role="status">{journal?.receipt?'모든 종료 세션이 계정에 보관되었습니다.':'가져올 종료 세션이 없습니다.'}</p>}
 {journal?.receipt&&<p className="import-connected">계정에 보관한 세션 {journal.sources.length}개 · 연결됨 · 로컬 원본 유지. <Link href={`/account/${journal.receipt.serverWorkItemId}`}>가져온 계정 세션 확인</Link></p>}
 </>}
 <button className="button button-secondary" type="button" disabled={busy} onClick={()=>{setError('');setLoading(true);void refresh().catch(e=>{setError(e.message);setLoading(false);});}}>세션 다시 확인</button> <Link href="/">지금은 건너뛰기</Link></>}
 {error&&<p className="timer-error" role="alert">{error} 로컬 원본과 저장된 스냅샷은 유지합니다.</p>}
 <dialog ref={dialog} className="project-confirm adjustment-dialog" aria-labelledby="timer-import-title" onCancel={e=>{if(busy)e.preventDefault();}} onClose={()=>(trigger.current?.isConnected?trigger.current:heading.current)?.focus()}><h2 id="timer-import-title">작업 시간을 계정으로 가져올까요?</h2><p>{info.count}개 세션 · {formatWorkTime(info.ms)} · 정정 이력 {info.adjustments}건</p><p>{target}</p><p>카운터가 아직 연결되지 않았다면 카운터를 먼저 가져옵니다. 타이머 묶음은 전체 성공 또는 전체 취소로 처리합니다. 실패 후 같은 스냅샷으로 재시도합니다.</p><p>계정 기록과 작업 구간이 겹칠 수 있으며 자동 병합하지 않습니다. 가져온 세션의 이후 정정은 계정에서 진행하세요.</p>{error&&<p role="alert">{error}</p>}{busy&&<p role="status">계정에 저장·확인 중입니다.</p>}<button className="button" disabled={busy} onClick={()=>void run()}>{journal?.pending?'같은 요청 재시도':'가져오기 확인'}</button><button className="button button-secondary" ref={cancel} disabled={busy} onClick={()=>dialog.current?.close()}>취소</button></dialog>
 </section>;
}
