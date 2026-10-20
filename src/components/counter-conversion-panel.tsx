"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { CounterConversionStore, type CounterProjectLink } from "@/data/projects/counter-conversion-store";
import { IndexedDbConversionJournal, type ConversionIntent } from "@/data/projects/conversion-journal";
import { CounterConversionService } from "@/data/projects/counter-conversion-service";
import { SupabaseCounterStore } from "@/data/remote/supabase-counter-store";
import { IndexedDbServerCommandQueue } from "@/data/remote/server-command-queue";
import { SupabaseImportStore } from "@/data/import/supabase-import-store";
import { quickCounterStore } from "@/data/local/quick-session";
import { hasPendingQuickTab } from "@/data/local/quick-import-guard";
import { lastCountOccurredAt } from "@/domain/counter/engine";
import type { CounterState } from "@/domain/counter/types";

export function CounterConversionPanel({ userId, workItemId }: { userId:string;workItemId?:string }) {
  const router=useRouter();
  const [client]=useState(createClient);
  const [remote]=useState(()=>new CounterConversionStore(client));
  const [counters]=useState(()=>new SupabaseCounterStore(client));
  const [journal]=useState(()=>new IndexedDbConversionJournal());
  const [service]=useState(()=>new CounterConversionService(journal,remote,new IndexedDbServerCommandQueue(),quickCounterStore,new SupabaseImportStore(client),hasPendingQuickTab,async()=>{const {data}=await client.auth.getClaims();return data?.claims?.sub===userId;}));
  const [state,setState]=useState<CounterState|null>(null);
  const [facts,setFacts]=useState<{count:number;last:string|null}>({count:0,last:null});
  const [source,setSource]=useState("");const [localId,setLocalId]=useState<string>();
  const [serverId,setServerId]=useState<string|null>(workItemId ?? null);
  const [intent,setIntent]=useState<ConversionIntent|null>(null);
  const [link,setLink]=useState<CounterProjectLink|null>(null);
  const [name,setName]=useState("");const [loading,setLoading]=useState(true);const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");const [warning,setWarning]=useState("");const [authorized,setAuthorized]=useState(true);
  const [confirming,setConfirming]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);const trigger=useRef<HTMLButtonElement>(null);
  const back=workItemId?`/account/${workItemId}`:"/quick";
  const checkUser=useCallback(async()=>{const {data}=await client.auth.getClaims();if(data?.claims?.sub!==userId)throw new Error("로그인 계정이 변경됐습니다.");},[client,userId]);
  const load=useCallback(async()=>{
    setLoading(true);setError("");setWarning("");setLink(null);
    try{
      await checkUser();let server=workItemId ?? null;let key=workItemId?`account:${workItemId}`:"";
      if(!workItemId){
        const record=await quickCounterStore.getQuickIfExists();if(!record)throw new Error("이 기기에 저장된 간편 기록이 없습니다.");
        if(record.importedByUserId&&record.importedByUserId!==userId)throw new Error("이 로컬 기록은 다른 계정에 연결되어 있습니다. 현재 계정으로 복사하지 않습니다.");
        setLocalId(record.localWorkItemId);key=`local:${record.localWorkItemId}`;
        server=record.importStatus==="imported"?record.serverWorkItemId:null;
        const frozen=await quickCounterStore.getImportSnapshot(record.importId);
        const events=frozen?.events ?? await quickCounterStore.getEvents(record.localWorkItemId);
        setState(frozen?.state ?? record.state);setFacts({count:events.length,last:lastCountOccurredAt(events)});
        if(frozen&&record.state.revision>frozen.state.revision)setWarning(`가져오기 스냅샷 이후의 로컬 변경 ${record.state.revision-frozen.state.revision}건은 서버로 추가 업로드하지 않습니다. 프로젝트에서는 기존 서버 기록을 사용합니다.`);
      }
      setSource(key);const saved=await journal.get(userId,key);setIntent(saved);if(saved)setName(saved.name);
      server=server ?? saved?.workItemId ?? null;setServerId(server);
      if(server){
        const connected=await remote.link(server);if(connected){setLink(connected);return;}
        const current=await counters.getWorkItem(server);if(!current)throw new Error("서버 카운터를 찾을 수 없습니다.");
        const events=await counters.getEvents(server);setState(current);setFacts({count:events.length,last:lastCountOccurredAt(events)});
      }
      await checkUser();
    }catch(cause){setError(cause instanceof Error?cause.message:"전환할 기록을 읽지 못했습니다.");setState(null);}
    finally{setLoading(false);}
  },[checkUser,counters,journal,remote,userId,workItemId]);
  useEffect(()=>{void Promise.resolve().then(load);const {data}=client.auth.onAuthStateChange((event,session)=>{
    if(event==="SIGNED_OUT"||(event==="SIGNED_IN"&&session?.user.id!==userId)){setAuthorized(false);setState(null);router.replace("/login");router.refresh();}
  });return()=>data.subscription.unsubscribe();},[client,load,router,userId]);
  useEffect(()=>{if(confirming&&dialog.current&&!dialog.current.open)dialog.current.showModal();if(!confirming&&dialog.current?.open)dialog.current.close();},[confirming]);
  async function convert(){
    if(busy||!state)return;setBusy(true);setError("");setConfirming(false);
    const channel=!workItemId?new BroadcastChannel("stitchmori-import-v1"):null;
    try{
      await checkUser();channel?.postMessage({type:"import-start"});
      const result=await service.execute(userId,source,name,serverId,serverId?state.revision:null,localId);
      await checkUser();
      if(result.status==="conflict")throw new Error("서버 카운터가 변경됐습니다. 최신 상태 확인 후 새 요청으로 다시 전환해 주세요.");
      router.push(`/projects/${result.projectId}`);router.refresh();
    }catch(cause){setIntent(await journal.get(userId,source).catch(()=>null));setError(cause instanceof Error?cause.message:"전환을 확인하지 못했습니다. 같은 요청으로 재시도해 주세요.");}
    finally{channel?.postMessage({type:"import-end"});channel?.close();setBusy(false);}
  }
  if(!authorized)return <p role="status">로그인 계정을 확인하고 있습니다.</p>;
  return <div className="import-page conversion-page"><header className="import-heading"><p className="eyebrow">기록을 프로젝트로</p><h1>프로젝트로 전환</h1><p>{workItemId?"계정에 저장된 카운터를 새 프로젝트의 기본 파트로 연결합니다.":"이 기기의 간편 기록을 계정에 보관한 뒤 새 프로젝트로 연결합니다."}</p></header>
    {loading&&<p className="notice" role="status">저장된 기록을 확인하는 중입니다.</p>}
    {busy&&<p className="notice" role="status">기록을 확인하고 프로젝트에 연결하는 중입니다. 완료될 때까지 기다려 주세요.</p>}
    {error&&<div className="quick-error-box" role="alert"><p>{error}</p><p>원본 기록은 유지됩니다. 가져오기가 이미 끝났다면 같은 서버 기록을 사용해 이어서 처리합니다.</p><div className="project-form-actions">
      {intent&&state&&<button type="button" disabled={busy} onClick={()=>void convert()}>같은 요청으로 재시도</button>}
      <button type="button" disabled={busy} onClick={()=>void load()}>최신 상태 확인</button>
      {intent&&<button type="button" disabled={busy} onClick={()=>{void journal.clear(userId,source).then(load);}}>최신 상태 확인 후 새 요청으로 시작</button>}
    </div></div>}
    {link?<section className="import-card"><h2>이미 프로젝트에 연결된 기록입니다</h2><p>{link.projectName}</p>{!workItemId&&<p>로컬 원본은 이 기기에 남아 있으며, 이후 간편 카운터 입력은 프로젝트로 자동 동기화되지 않습니다.</p>}<p>{link.deleted?"프로젝트 또는 파트가 삭제된 상태입니다. 프로젝트 관리에서 먼저 복구해 주세요.":"추가 프로젝트를 만들지 않고 기존 프로젝트에서 이어갈 수 있습니다."}</p><Link className="button" href={link.deleted?"/projects":`/projects/${link.projectId}`}>{link.deleted?"프로젝트 관리·복구":"프로젝트 열기"}</Link></section>:state&&!loading&&<section className="import-card"><p className="eyebrow">{serverId?"계정 서버에 저장된 기록":"이 기기에 저장된 스냅샷"}</p>
      <div className="import-stats"><div><span>현재 코수</span><strong>{state.stitch.current}</strong></div><div><span>완료 단수</span><strong>{state.row.current}</strong></div></div>
      <dl className="import-facts"><div><dt>목표 코수·단수</dt><dd>{state.stitch.target ?? "없음"} · {state.row.target ?? "없음"}</dd></div><div><dt>변경 이력</dt><dd>{facts.count}건</dd></div><div><dt>마지막 카운트</dt><dd>{facts.last?new Date(facts.last).toLocaleString("ko-KR"):"아직 없음"}</dd></div></dl>
      {warning&&<p className="notice">{warning}</p>}
      <p className="conversion-preservation">현재 값·목표·변경 이력·실행 취소 관계를 유지합니다. 전환 후 새 카운트는 프로젝트 서버 카운터에서 진행해 주세요. 간편 카운터는 계속 이 기기의 별도 기록이며 로컬 원본을 삭제하지 않습니다.</p>
      <form className="conversion-form" onSubmit={(event)=>{event.preventDefault();if(name.trim())setConfirming(true);}}><label htmlFor="conversion-name">프로젝트명</label><input id="conversion-name" required maxLength={120} value={name} disabled={busy||!!intent} onChange={(event)=>setName(event.target.value)} />
        <div className="project-form-actions"><button ref={trigger} className="button" type="submit" disabled={busy||!name.trim()}>프로젝트로 전환</button><Link className="button button-secondary" href={back} aria-disabled={busy} onClick={(event)=>{if(busy)event.preventDefault();}}>취소하고 카운터로</Link></div></form>
    </section>}
    <dialog ref={dialog} className="project-confirm" aria-labelledby="conversion-title" onCancel={()=>setConfirming(false)} onClose={()=>{setConfirming(false);trigger.current?.focus();}}><h2 id="conversion-title">프로젝트로 전환할까요?</h2><p>{name}의 기본 파트로 코수 {state?.stitch.current} · 단수 {state?.row.current} 기록을 연결합니다. 기존 기록을 덮어쓰거나 로컬 원본을 삭제하지 않습니다.</p><div className="project-form-actions"><button className="button conversion-confirm" type="button" disabled={busy} onClick={()=>void convert()}>확인하고 전환</button><button className="button button-secondary" autoFocus type="button" onClick={()=>setConfirming(false)}>취소</button></div></dialog>
  </div>;
}
