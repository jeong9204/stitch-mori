"use client";
import Link from 'next/link';
import {useCallback,useEffect,useMemo,useState} from 'react';
import {IndexedDbTimerStore} from '@/data/timer/indexeddb-timer-store';
import {loadAccountTimeStatistics} from '@/data/timer/time-statistics-store';
import {dayKey,dayBounds,overlapMs,localTimeStatistics,formatWorkTime,type TimeStatistics} from '@/domain/timer/statistics';
import {createClient} from '@/lib/supabase/client';
type LocalSource=Awaited<ReturnType<IndexedDbTimerStore['localStatisticsSource']>>;
export function TimeStatisticsPanel({userId,projectId,workItemId}:{userId?:string;projectId?:string;workItemId?:string}) {
  const [store]=useState(()=>new IndexedDbTimerStore()),[client]=useState(()=>userId?createClient():null);
  const [snapshot,setSnapshot]=useState<TimeStatistics|null>(null),[local,setLocal]=useState<LocalSource|null>(null),[anchor,setAnchor]=useState(0);
  const [error,setError]=useState(''),[loading,setLoading]=useState(true),[authorized,setAuthorized]=useState(true),[pending,setPending]=useState(false),[offset,setOffset]=useState(0),[tick,setTick]=useState({mono:0,wall:0});
  const zone=useMemo(()=>Intl.DateTimeFormat().resolvedOptions().timeZone,[]);
  const load=useCallback(async()=>{
    if(userId && client){
      const data=await loadAccountTimeStatistics(client,userId,projectId,workItemId,offset);
      return {data,pending:!!(await store.pending(userId)),source:null};
    }
    const source=await store.localStatisticsSource();
    return {data:localTimeStatistics(source.states,source.events,new Date().toISOString(),zone,offset),pending:!!source.pending,source};
  },[client,userId,projectId,workItemId,offset,store,zone]);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    let alive=true,allowed=true,busy=false;
    async function refresh(){
      if(busy || !allowed || document.visibilityState!=='visible')return;busy=true;
      try{const result=await load();if(alive && allowed){setSnapshot(result.data);setAnchor(performance.now());setTick({mono:performance.now(),wall:Date.now()});setLocal(result.source);setPending(result.pending);setError('');}}
      catch {if(alive && allowed){setError('작업 시간을 불러오지 못했습니다. 표시된 값은 마지막 확인 기록이며 현재 상태는 미확정입니다.');}}
      finally{busy=false;if(alive)setLoading(false);}
    }
    const {data:subscription}=client?.auth.onAuthStateChange((event,session)=>{
      if(event==='SIGNED_OUT' || (event==='SIGNED_IN' && session?.user.id!==userId)){allowed=false;setAuthorized(false);setSnapshot(null);setLocal(null);}
    })??{};
    void refresh();const refreshEvent=()=>void refresh(),interval=setInterval(refreshEvent,15000);
    const channel=new BroadcastChannel('stitchmori-timer-ui');channel.onmessage=refreshEvent;
    window.addEventListener('focus',refreshEvent);document.addEventListener('visibilitychange',refreshEvent);
    return()=>{alive=false;allowed=false;clearInterval(interval);channel.close();subscription?.subscription.unsubscribe();window.removeEventListener('focus',refreshEvent);document.removeEventListener('visibilitychange',refreshEvent);};
  },[client,load,retry,userId]);
  useEffect(()=>{const id=setInterval(()=>setTick({mono:performance.now(),wall:Date.now()}),1000);return()=>clearInterval(id);},[]);
  // Every render recalculates elapsed time, never accumulates timer ticks.
  if(!authorized)return <p role="status">계정이 변경되어 작업 시간을 숨겼습니다.</p>;
  let data=snapshot,calculationError='';
  const now=snapshot?Date.parse(snapshot.serverNow)+Math.max(0,tick.mono-anchor):tick.wall;
  try{if(local)data=localTimeStatistics(local.states,local.events,new Date(tick.wall || Date.parse(snapshot!.serverNow)).toISOString(),zone,offset);}catch{calculationError='작업 시간 기록의 정합성을 확인할 수 없습니다.';data=null;}
  const newDay=!!data && dayKey(now,data.zone)!==data.day;
  const bounds=data?dayBounds(Date.parse(data.serverNow),data.zone):[0,0];
  const works=data?.works.map(work=>{
    const active=work.active,delta=active?.status==='running'?Math.max(0,now-Date.parse(data!.serverNow)):0;
    const [from,to]=bounds;
    return {...work,liveMs:work.liveMs+delta,todayLiveMs:work.todayLiveMs+(active?.status==='running'?overlapMs(Date.parse(data!.serverNow),now,from,to):0)};
  })??[];
  const total=works.reduce((a,w)=>({saved:a.saved+w.savedMs,live:a.live+w.liveMs,today:a.today+w.todaySavedMs,todayLive:a.todayLive+w.todayLiveMs}),{saved:0,live:0,today:0,todayLive:0});
  return <section className="time-statistics" aria-label={userId?'계정 작업 시간':'이 기기 작업 시간'}>
    <header><div><p className="eyebrow">한 코씩 쌓인 시간 · {userId?'계정 서버':'이 기기'}</p><h2>{projectId?'프로젝트 작업 시간':workItemId?'이 작업의 시간':'오늘의 작업 시간'}</h2></div><button type="button" onClick={()=>{setLoading(true);setRetry(r=>r+1);}}>시간 새로고침</button></header>
    {loading && <p role="status">작업 시간 확인 중</p>}
    {(error||calculationError) && <p className="timer-error" role="alert">{error||calculationError} <button type="button" onClick={()=>setRetry(r=>r+1)}>다시 시도</button></p>}
    {data && <><p className="timer-help">{data.day} · {data.zone} 기준. 로컬·계정 시간을 따로 표시하며 합산하지 않습니다.</p>
      {newDay?<p role="status">날짜가 바뀌었습니다. 오늘 통계는 새로고침 후 표시합니다.</p>:<div className="time-summary"><p>오늘 합계 · 진행 중 포함 예상<strong>{formatWorkTime(total.today+total.todayLive)}</strong></p><p>오늘 저장된 시간<strong>{formatWorkTime(total.today)}</strong></p><p>오늘 진행 중 구간 · 예상<strong>{formatWorkTime(total.todayLive)}</strong></p></div>}
      <p>누적 저장 시간 <strong>{formatWorkTime(total.saved)}</strong></p><p>현재 실행 구간 · 예상 <strong>{formatWorkTime(total.live)}</strong></p>
      <p className="timer-help">실행 중 구간은 서버·로컬 확인 상태에서 계산한 예상값이며 확정 누적에 포함하지 않았습니다. 일시정지 구간은 제외합니다.</p><p className="timer-help">마지막 조회 {new Date(data.serverNow).toLocaleString('ko-KR',{timeZone:data.zone})} · 다른 화면의 변경은 다음 조회에 반영됩니다.</p>
      {pending && <p className="notice" role="status">미확정 타이머 명령이 이 기기에 있습니다. pause/end가 서버에 도착할 때까지 시간이 더 기록될 수 있습니다. 카운터 화면에서 같은 요청을 확인해 주세요.</p>}
      {!works.length && <p>아직 기록된 작업 세션이 없습니다.</p>}
      {works.map(work=><article className="time-work" key={work.workItemId}><h3>{work.name}{work.deleted?' · 삭제된 기록':''}</h3><p>저장 {formatWorkTime(work.savedMs)}{work.liveMs>0?` · 진행 중 예상 ${formatWorkTime(work.liveMs)}`:''}</p><p>최근 작업 {work.lastWorkedAt?new Date(work.lastWorkedAt).toLocaleString('ko-KR',{timeZone:data.zone}):'없음'}</p>
        {work.active && <p>{work.active.status==='running'?'작업 중':'일시정지'} · 현재 세션 <Link href={userId?`/account/${work.workItemId}`:'/quick'}>타이머 확인</Link></p>}</article>)}
      <h3>최근 완료 세션</h3>{!data.recent.length?<p>완료된 세션이 없습니다.</p>:<ol className="time-history">{data.recent.map(session=><li key={session.sessionId}><strong>{works.find(w=>w.workItemId===session.workItemId)?.name??'작업 기록'}</strong><span>{new Date(session.startedAt).toLocaleString('ko-KR',{timeZone:data.zone})} → {new Date(session.endedAt!).toLocaleString('ko-KR',{timeZone:data.zone})}</span><span>{formatWorkTime(session.accumulatedMs)}</span></li>)}</ol>}
      <div className="project-form-actions"><button type="button" disabled={offset===0} onClick={()=>setOffset(n=>Math.max(0,n-20))}>이전 세션</button><button type="button" disabled={!data.hasMore} onClick={()=>setOffset(n=>n+20)}>다음 세션</button></div>
    </>}
  </section>;
}
