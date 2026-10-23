"use client";
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {AdjustmentStore} from '@/data/timer/adjustment-store';
import {AdjustmentSession} from '@/data/timer/adjustment-session';
import {parseAdjustmentDuration} from '@/domain/timer/adjustments';
import {formatWorkTime} from '@/domain/timer/statistics';
export function TimeAdjustmentEditor({store,sessionId,onClose,onSaved}:{store:AdjustmentStore;sessionId:string;onClose:()=>void;onSaved:()=>void}) {
  const [session]=useState(()=>new AdjustmentSession(store,sessionId));
  const view=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getServerSnapshot);
  const [hours,setHours]=useState('0'),[minutes,setMinutes]=useState('0'),[seconds,setSeconds]=useState('0'),[reason,setReason]=useState(''),[error,setError]=useState(''),[release,setRelease]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null),initialized=useRef(false);
  useEffect(()=>{session.activate();void session.load();dialog.current?.showModal();cancel.current?.focus();return()=>session.dispose();},[session]);
  useEffect(()=>{
    if(!view.snapshot || initialized.current)return;initialized.current=true;
    const ms=view.pending?.adjustedMs??view.snapshot.effectiveMs;
    setHours(String(Math.floor(ms/3600000)));setMinutes(String(Math.floor(ms/60000)%60));setSeconds(String(ms%60000/1000));setReason(view.pending?.reason??'');
  },[view.snapshot,view.pending]);
  useEffect(()=>{
    const warn=(event:BeforeUnloadEvent)=>{if(view.pending && !view.durable){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[view.pending,view.durable]);
  const busy=view.status==='loading'||view.status==='saving',memoryOnly=!!view.pending&&!view.durable,locked=busy||!!view.pending||!view.snapshot?.canAdjust;
  let proposed:number|null=null;try{proposed=parseAdjustmentDuration(hours,minutes,seconds);}catch{/* form reports validation on submit */}
  async function run(retry=false){
    setError('');try{if(retry)await session.retry();else await session.save(parseAdjustmentDuration(hours,minutes,seconds),reason);
      if(session.getSnapshot().status==='saved')onSaved();
    }catch(e){setError(e instanceof Error?e.message:'정정 값을 확인해 주세요.');}
  }
  return <dialog ref={dialog} className="project-confirm adjustment-dialog" aria-labelledby="adjustment-title" onCancel={event=>{if(busy||memoryOnly){event.preventDefault();if(memoryOnly)setError('정정 요청이 아직 메모리에만 있습니다. 같은 요청으로 재시도하여 로컬 보관을 확인한 뒤 닫아 주세요.');}}} onClose={onClose}>
    <h2 id="adjustment-title">작업 시간 정정 및 이력</h2>
    {busy && <p role="status">{view.status==='loading'?'세션·정정 이력 확인 중':'정정 저장·확인 중'}</p>}
    {view.snapshot && <>
      <p>원본 기록 <strong>{formatWorkTime(view.snapshot.session.accumulatedMs)}</strong> ({view.snapshot.session.accumulatedMs.toLocaleString()}ms)</p>
      <p>현재 유효 시간 <strong>{formatWorkTime(view.snapshot.effectiveMs)}</strong> · 정정 revision {view.snapshot.revision}</p>
      {!view.snapshot.canAdjust && <p className="notice">종료된 세션만 정정할 수 있습니다. 일시정지 세션은 먼저 종료하고, 삭제된 프로젝트·파트는 복구해 주세요.</p>}
      <p className="timer-help">원본 세션·이벤트는 유지합니다. 일별 통계는 원래 작업 비중에 따른 <strong>추정 배분</strong>이며 실제 작업 구간을 다시 구성하지 않습니다. 원본이 0이면 종료일에 배정합니다.</p>
      <form onSubmit={e=>{e.preventDefault();void run();}}>
        <fieldset disabled={locked}><legend>정정할 작업 시간</legend><div className="adjustment-duration">
          <label>시간<input inputMode="numeric" value={hours} onChange={e=>setHours(e.target.value)} maxLength={13} required /></label>
          <label>분<input inputMode="numeric" value={minutes} onChange={e=>setMinutes(e.target.value)} maxLength={2} required /></label>
          <label>초<input inputMode="decimal" value={seconds} onChange={e=>setSeconds(e.target.value)} maxLength={6} required /></label>
        </div><label>정정 사유 (선택)<textarea value={reason} onChange={e=>setReason(e.target.value)} maxLength={1000} rows={3}/></label></fieldset>
        <p>현재 {formatWorkTime(view.snapshot.effectiveMs)} → {proposed===null?'입력값 확인 필요':formatWorkTime(proposed)}{proposed!==null?` (${proposed.toLocaleString()}ms)`:''}</p>
        <button className="button" type="submit" disabled={locked}>정정 저장</button>
      </form>
      {view.status==='saved' && <p role="status">정정을 저장했고 통계 갱신을 요청했습니다.</p>}
      <h3>정정 이력</h3>{view.snapshot.adjustments.length===0?<p>아직 정정 이력이 없습니다.</p>:<ol className="time-history">{view.snapshot.adjustments.map(a=><li key={a.adjustmentId}><strong>정정 {a.revision}: {formatWorkTime(a.previousAdjustedMs)} → {formatWorkTime(a.adjustedMs)}</strong><span>{new Date(a.createdAt).toLocaleString('ko-KR')}</span><span>{a.reason||'사유 미입력'}</span><span>수행: {a.userId?'본인 계정':'이 기기'} · 요청 {a.commandId}</span></li>)}</ol>}
    </>}
    {(view.error||error) && <p className="timer-error" role="alert">{error||view.error}</p>}
    {view.pending && <div className="timer-pending"><p>미확정 정정 요청을 {view.durable?'이 기기에 보관했습니다.':'메모리에 유지하고 있습니다. 로컬 보관도 확인되지 않아 페이지를 떠나면 유실될 수 있습니다. 닫기 전에 같은 요청으로 재시도해 주세요.'} 원본 기록은 유지됩니다.</p><p>요청 ID {view.pending.requestId}</p><button type="button" disabled={busy} onClick={()=>void run(true)}>같은 요청으로 재시도</button><button type="button" disabled={busy} onClick={()=>setRelease(true)}>최신 이력 확인 후 새로 작성</button></div>}
    {!view.snapshot && !busy && <button type="button" onClick={()=>void session.load()}>이력 다시 불러오기</button>}
    {release && <div className="notice"><p>최신 이력을 읽고 이 기기의 대기 요청만 해제합니다. 서버 요청 취소가 아니며, 이미 적용된 정정을 되돌리지 않습니다. 입력값은 유지합니다.</p><button type="button" disabled={busy} onClick={()=>{void session.release().then(()=>{if(!session.getSnapshot().pending)setRelease(false);});}}>확인 후 보관 해제</button><button type="button" onClick={()=>setRelease(false)}>돌아가기</button></div>}
    <button type="button" ref={cancel} className="button button-secondary" disabled={busy||memoryOnly} onClick={()=>dialog.current?.close()}>{view.pending?'요청 보관 후 닫기':'취소·닫기'}</button>
  </dialog>;
}
