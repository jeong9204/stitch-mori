"use client";
import {useEffect,useRef,useState} from 'react';
import type {TimerController} from '@/data/timer/timer-controller';
import {inactivityDue,type InactivitySnapshot,type InactivityChoice} from '@/domain/timer/inactivity';
/** A durable claim precedes display. Refreshing an already shown interval never reopens it. */
export function InactivityPrompt({controller,sessionId,pending}:{controller:TimerController;sessionId:string;pending:boolean}) {
  const [prompt,setPrompt]=useState<InactivitySnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[attempt,setAttempt]=useState(0);
  const dialog=useRef<HTMLDialogElement>(null),later=useRef<HTMLButtonElement>(null),focus=useRef<HTMLElement|null>(null),returnHeading=useRef<HTMLElement|null>(null),fallback=useRef<HTMLParagraphElement>(null);
  const visiblePrompt=useRef<InactivitySnapshot|null>(null),checking=useRef(false);
  useEffect(()=>{
    let alive=true;const backend=controller.backend;
    async function check() {
      if(checking.current || document.visibilityState!=='visible' || pending)return;
      checking.current=true;
      try {
        const value=await backend.readInactivity!(sessionId);
        if(!alive)return;
        if(!visiblePrompt.current)setError('');
        if(visiblePrompt.current && (value.session.status!=='running' || value.baseline!==visiblePrompt.current.baseline)) {visiblePrompt.current=null;setPrompt(null);}
        if(value.session.revision!==controller.getSnapshot().context?.state?.revision)await controller.load();
        if(!visiblePrompt.current && !document.querySelector('dialog[open]') && inactivityDue(value)) {
          const claimed=await backend.ackInactivity!(value,'show');
          if(alive && claimed) {visiblePrompt.current=value;setPrompt(value);setError('');}
        }
      }catch {if(alive)setError('비활동 상태를 확인·저장하지 못했습니다. 자동 일시정지는 하지 않습니다. 연결을 확인해 주세요.');}
      finally{checking.current=false;}
    }
    if(!backend.readInactivity || !backend.ackInactivity)return;
    void check();const interval=setInterval(()=>void check(),15000);
    const refresh=()=>void check();window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;clearInterval(interval);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[controller,sessionId,pending,attempt]);
  useEffect(()=>{
    if(prompt && !dialog.current?.open) {focus.current=document.activeElement as HTMLElement;returnHeading.current=fallback.current?.closest("section")?.querySelector("h2")??null;dialog.current?.showModal();later.current?.focus();}
    if(!prompt && dialog.current?.open)dialog.current.close();
  },[prompt]);
  async function choose(choice:InactivityChoice) {
    if(busy || !prompt)return;setBusy(true);
    try {
      const applied=await controller.backend.ackInactivity!(prompt,choice);
      visiblePrompt.current=null;setPrompt(null);setError('');
      if(applied && choice==='pause')await controller.action('pause');
      await controller.load();
      const channel=new BroadcastChannel('stitchmori-timer-ui');channel.postMessage('changed');channel.close();
      if(choice==='pause')returnHeading.current?.focus();
    }catch {setError('선택을 저장하지 못했습니다. 타이머는 계속 실행 중입니다. 같은 선택으로 다시 시도해 주세요.');}
    finally{setBusy(false);}
  }
  return <><p ref={fallback} tabIndex={-1} className="timer-help" role={error?'alert':undefined}>{error || '30분 동안 카운트가 없으면 이 화면에서 확인해요. 백그라운드 알림은 보장되지 않습니다.'}{error && <button type="button" onClick={()=>setAttempt(n=>n+1)}>비활동 상태 다시 확인</button>}</p>
    <dialog ref={dialog} className="project-confirm inactivity-dialog" aria-labelledby="inactivity-title" aria-describedby="inactivity-description"
      onCancel={e=>{e.preventDefault();void choose('later');}}
      onClose={()=>{(focus.current?.isConnected && focus.current.matches('a[href],button:not([disabled]),input,select,textarea,[tabindex]') && !focus.current.closest('dialog')?focus.current:(returnHeading.current??fallback.current))?.focus();}}>
      <h2 id="inactivity-title">아직 뜨개질하고 있나요?</h2><p id="inactivity-description">30분 동안 카운트 기록이 없어요. 타이머는 계속 실행 중이에요.</p>
      {error && <p role="alert">{error}</p>}
      <div className="inactivity-actions"><button type="button" disabled={busy} onClick={()=>void choose('continue')}>네, 계속 작업 중이에요</button><button type="button" disabled={busy} onClick={()=>void choose('pause')}>잠시 일시정지</button><button type="button" ref={later} disabled={busy} onClick={()=>void choose('later')}>나중에 확인할게요</button></div>
    </dialog></>;
}
