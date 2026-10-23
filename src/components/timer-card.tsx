"use client";
import {observeTimerImportBlocker} from "@/data/timer/timer-import-guard";
import Link from "next/link";
import { timerDisplay } from "./timer-display";
import { InactivityPrompt } from "./inactivity-prompt";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TimerController } from "@/data/timer/timer-controller";
const labels={running:"작업 중",paused:"일시정지",ended:"종료"};
function ControlIcon({kind}:{kind:"start"|"pause"|"end"}) {
  return <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">{kind==="pause" ? <><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></> : kind==="end" ? <rect x="5" y="5" width="14" height="14" rx="3"/> : <path d="M8 4.5v15l12-7.5z"/>}</svg>;
}
export function TimerCard({controller,readOnlyReason}: {controller:TimerController;readOnlyReason?:string}) {
  const view=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getServerSnapshot);
  const [,tick]=useState(0);
  const [modal,setModal]=useState<"end"|"release"|null>(null);
  const heading=useRef<HTMLHeadingElement>(null);
  const dialog=useRef<HTMLDialogElement>(null), cancel=useRef<HTMLButtonElement>(null), trigger=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>observeTimerImportBlocker(controller.backend.server?controller.backend.scope.split(":")[1]:null,()=>!!controller.getSnapshot().pending||controller.getSnapshot().status==="saving"),[controller]);
  useEffect(()=>{
    void Promise.resolve().then(()=>controller.load());
    const refresh=()=>{void controller.load();};
    const channel=new BroadcastChannel("stitchmori-timer-ui");channel.onmessage=refresh;
    const visible=()=>{if(document.visibilityState==="visible")refresh();};
    window.addEventListener("focus",refresh);document.addEventListener("visibilitychange",visible);
    const interval=setInterval(()=>tick(n=>n+1),1000);
    return()=>{clearInterval(interval);channel.close();window.removeEventListener("focus",refresh);document.removeEventListener("visibilitychange",visible);};
  },[controller]);
  useEffect(()=>{
    if(modal && !dialog.current?.open){dialog.current?.showModal();cancel.current?.focus();}
    if(!modal && dialog.current?.open)dialog.current.close();
  },[modal]);
  const context=view.context, state=context?.state;
  const other=context?.active && context.active.workItemId!==controller.backend.workItemId;
  const foreignPending=view.pending && view.pending.workItemId!==controller.backend.workItemId;
  const busy=view.status==="loading" || view.status==="saving";
  const locked=busy || !!view.pending || !!other;
  let elapsed=0,clockError="";
  try{elapsed=controller.elapsed();}catch{clockError="기기 시각을 확인해 주세요. 경과 시간을 안전하게 계산할 수 없습니다.";}
  const {time,lastSessionTime}=timerDisplay(state,view.pending,elapsed);
  function changed(task:Promise<void>){void task.finally(()=>{const channel=new BroadcastChannel("stitchmori-timer-ui");channel.postMessage("changed");channel.close();});}
  return <section className="timer-card" aria-label="작업 타이머">
    <header className="timer-heading"><h2 ref={heading} tabIndex={-1}>작업 타이머</h2><span className="timer-state">{state?labels[state.status]:"시작 전"}</span></header>
    <p className="timer-work">{context?.workName ?? "작업 확인 중"}</p>
    <div className="timer-main">
      <div className="timer-clock"><output aria-label={`경과 시간 ${time}`}>{time}</output></div>
      <div className="timer-primary-controls">
        {!state || state.status==="ended" ? <button className="timer-round timer-round-primary" type="button" aria-label={state?"새 작업 시작":"시작"} title={state?"새 작업 시작":"시작"} disabled={locked||!!readOnlyReason||!context?.canStart} onClick={()=>changed(controller.action("start"))}><ControlIcon kind="start"/></button> : <>
          <button className="timer-round timer-round-primary" type="button" aria-label={state.status==="running"?"일시정지":"재개"} title={state.status==="running"?"일시정지":"재개"} disabled={locked||(state.status==="paused"&&(!!readOnlyReason||!context?.canStart))} onClick={()=>changed(controller.action(state.status==="running"?"pause":"resume"))}><ControlIcon kind={state.status==="running"?"pause":"start"}/></button>
          <button className="timer-round" type="button" aria-label="종료" title="종료" disabled={locked} onClick={e=>{trigger.current=e.currentTarget;setModal("end");}}><ControlIcon kind="end"/></button>
        </>}
      </div>
    </div>
    {lastSessionTime !== null && <p className="timer-help">마지막 작업 <strong>{lastSessionTime}</strong> · {controller.backend.server?"계정 서버":"이 기기"}에 저장 완료</p>}
    <div className="timer-save-line"><p className="timer-storage" role="status"><span>{controller.backend.server?"계정 서버":"이 기기"} · </span>{view.status==="saving"?"타이머 저장·확인 중":view.status==="loading"?"타이머 불러오는 중":view.pending?view.status==="conflict"?"타이머 충돌 · 요청 보존":"타이머 미확정 · 요청 보존":view.status==="failed"?"타이머 확인 실패":state?"타이머 저장 완료":"시작 전 · 저장된 타이머 없음"}</p><button className="timer-refresh" type="button" disabled={busy} onClick={()=>void controller.load()}>최신 상태 확인</button></div>
    {controller.backend.server && state?.status==="running" && <p className="timer-help">서버에서 확인한 작업 중 상태의 예상 경과 시간입니다. 최종 작업 시간은 서버가 확정합니다.</p>}
    {other && <p className="notice">다른 작업에서 {context?.active?.status==="paused"?"일시정지된":"진행 중인"} 세션이 있습니다: <strong>{context?.activeName}</strong>. 먼저 종료해 주세요. <Link href={controller.backend.server?`/account/${context?.active?.workItemId}`:"/quick"}>활성 작업 열기</Link></p>}
    {view.pending && <div className="timer-pending">{view.pending.action==="start" && view.pending.commandId===view.pending.sessionId && <p><strong>카운트는 저장됐지만 자동 타이머 시작은 아직 확정되지 않았습니다.</strong></p>}<p>미확정 요청: {view.pending.action} · {new Date(view.pending.occurredAt).toLocaleString("ko-KR")}</p><p>{view.durable?"요청을 이 기기에 보관했습니다.":"요청의 로컬 보관도 확인되지 않았습니다. 페이지를 떠나면 요청이 사라질 수 있습니다."}</p>
      {controller.backend.server && <p>화면은 마지막 서버 확인 상태를 표시합니다. 오프라인 pause/end는 서버 도착 시 처리되므로 실제 작업보다 시간이 길게 기록될 수 있습니다.</p>}
      {foreignPending && <Link href={`/account/${view.pending.workItemId}`}>보관된 요청의 작업 열기</Link>}
    </div>}
    {(view.error||clockError) && <p className="timer-error" role="alert">{view.error||clockError} 카운터 저장과 타이머 저장은 별개입니다.</p>}
    <div className="timer-controls">
      {view.pending && !foreignPending && <><button type="button" disabled={busy} onClick={()=>changed(controller.retry())}>같은 요청으로 재시도</button><button type="button" disabled={busy} onClick={e=>{trigger.current=e.currentTarget;setModal("release");}}>보관된 요청 확인</button></>}
    </div>
    <details className="timer-settings"><summary>시작 방식·설정 <span>{context?.mode==="auto"?"자동 시작":"수동 시작"}</span></summary>
    <label className="timer-mode">시작 방식<select value={context?.mode??"manual"} disabled={busy||!!view.pending||!context||!!readOnlyReason} onChange={e=>changed(controller.setMode(e.target.value as "manual"|"auto"))}><option value="manual">수동 시작</option><option value="auto">자동 시작</option></select></label>
    <p className="timer-help">자동 모드는 실제 코수·단수 변경이 저장된 뒤 시작합니다. 일시정지 상태를 자동 재개하지 않습니다. 로컬과 서버 타이머는 별개이며 동시에 실행될 수 있습니다.</p>
    </details>
    {readOnlyReason && <p className="timer-help">{readOnlyReason} 타이머 시작·재개가 제한됩니다.</p>}
    {state?.status==="running" && <InactivityPrompt key={state.sessionId} controller={controller} sessionId={state.sessionId} pending={!!view.pending} />}
    <dialog ref={dialog} className="project-confirm" aria-labelledby="timer-confirm-title" onCancel={()=>setModal(null)} onClose={()=>{setModal(null);(trigger.current?.isConnected && !trigger.current.disabled ? trigger.current : heading.current)?.focus();}}>
      <h2 id="timer-confirm-title">{modal==="end"?"이번 작업을 종료할까요?":"미확정 요청 보관을 해제할까요?"}</h2>
      <p>{modal==="end"?"종료한 세션은 재개할 수 없습니다. 다음 작업은 새 세션으로 기록합니다.":"최신 상태를 조회한 뒤 이 기기의 대기 요청만 해제합니다. 서버 요청을 취소하는 동작이 아니며 이미 적용됐거나 나중에 도착할 수 있습니다. 서버 상태와 카운터 기록은 삭제하지 않습니다."}</p>
      <div className="project-form-actions"><button type="button" className="button" onClick={()=>{const choice=modal;setModal(null);changed(choice==="end"?controller.action("end"):controller.releasePending());}}>{modal==="end"?"작업 종료":"확인 후 보관 해제"}</button><button ref={cancel} type="button" className="button button-secondary" onClick={()=>setModal(null)}>취소</button></div>
    </dialog>
  </section>;
}
