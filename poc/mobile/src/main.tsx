import React,{useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {Capacitor} from '@capacitor/core';
import {App as NativeApp} from '@capacitor/app';
import {lastUndoableEvent} from '../../../src/domain/counter/engine';
import {elapsedMilliseconds} from '../../../src/domain/timer/engine';
import {PocSession} from './session';
import {preparePhoto} from './photo';
import {exportZip,importZip} from './backup';
import {saveBackup} from './files';
import {DB_NAME,type Snapshot} from './model';
import './style.css';
const session=new PocSession();
function App(){
  const view=useSyncExternalStore(session.subscribe,session.snapshot,session.snapshot),s=view.snapshot;
  const [name,setName]=useState(''),[tab,setTab]=useState<'stitch'|'row'>('stitch'),[working,setWorking]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState(''),[photo,setPhoto]=useState(''),[tick,setTick]=useState(0),[restore,setRestore]=useState<Snapshot|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLElement|null>(null),cancel=useRef<HTMLButtonElement>(null),fileRef=useRef<HTMLInputElement>(null),restoreFile=useRef<HTMLInputElement>(null),job=useRef(false);
  const [modal,setModal]=useState<'row'|'end'|'restore'|null>(null);
  useEffect(()=>{void session.load();const reload=()=>void session.load();window.addEventListener('focus',reload);document.addEventListener('visibilitychange',reload);const interval=setInterval(()=>setTick(n=>n+1),1000);let stop:(()=>void)|undefined;let alive=true;
    if(Capacitor.isNativePlatform())void NativeApp.addListener('appStateChange',()=>{reload();setTick(n=>n+1);}).then(handle=>{if(alive)stop=()=>void handle.remove();else void handle.remove();});
    return()=>{alive=false;stop?.();clearInterval(interval);window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload);};},[]);
  useEffect(()=>{const guard=(e:BeforeUnloadEvent)=>{if(view.pending||working){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[view.pending,working]);
  useEffect(()=>{if(!s?.photo){setPhoto('');return;}const url=URL.createObjectURL(s.photo.blob);setPhoto(url);return()=>URL.revokeObjectURL(url);},[s?.photo]);
  useEffect(()=>{if(modal&&!dialog.current?.open){dialog.current?.showModal();cancel.current?.focus();}if(!modal&&dialog.current?.open)dialog.current.close();},[modal]);
  async function jobRun(task:()=>Promise<void>){if(job.current||view.pending)return;job.current=true;setWorking(true);setMessage('');setError('');try{await task();}catch(e){setError(e instanceof Error?e.message:'처리에 실패했습니다.');}finally{setWorking(false);job.current=false;}}
  function open(kind:typeof modal){trigger.current=document.activeElement as HTMLElement;setModal(kind);}
  function close(){setModal(null);}
  const active=s?.sessions.find(x=>x.status!=='ended'),last=s?.sessions.at(-1);let time='00:00:00',timeError='';
  try{const ms=active?elapsedMilliseconds(active,new Date().toISOString()):0,seconds=Math.floor(ms/1000);time=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(x=>String(x).padStart(2,'0')).join(':');}catch{timeError='기기 시간이 마지막 기록보다 이전입니다. 기기 시각을 확인해 주세요.';}
  void tick;
  const locked=working||!!view.error||!view.initialized;
  return <main><header><p>별도 검증 앱 · 로그인·서버 연결 없음</p><h1>StitchMori <small>Storage PoC</small></h1></header>
    <p className="status" role="status">{!view.initialized?'저장소 확인 필요':view.error?(view.rejected?'입력 적용 거부 · 기존 기록 유지':'저장 실패 · 미확정 입력 보존'):view.pending?`이 기기에 저장 중 · 대기 ${view.pending}건`:working?'파일 처리 중 · 완료 전 앱을 닫지 마세요':'이 기기에 저장됨 · 클라우드 동기화 없음'}</p>
    {(view.error||error)&&<section className="warning" role="alert"><p>{view.error||error}</p>{view.error&&<><p>확정되지 않은 입력은 메모리에 남습니다. 이 탭·앱을 종료하면 유실될 수 있어요. 기존 저장 기록은 유지합니다.</p><button onClick={()=>void session.retry()}>같은 명령으로 재시도</button>{view.rejected&&<button onClick={()=>session.dismissRejected()}>적용되지 않은 입력 취소</button>}</>}</section>}
    {message&&<p role="status">{message}</p>}
    {!s&&view.initialized&&<form onSubmit={e=>{e.preventDefault();if(!name.trim()){setError('프로젝트명을 입력해 주세요.');return;}session.create(name);}}><label htmlFor="name">PoC 프로젝트명</label><input id="name" value={name} maxLength={120} required onChange={e=>setName(e.target.value)}/><button disabled={locked||!!view.pending}>프로젝트와 기본 파트 생성</button></form>}
    {s&&<><section><h2>{s.project.name}</h2><p>{s.part.name} · PoC는 프로젝트와 파트 각각 1개를 지원합니다.</p><div className="tabs" role="group" aria-label="표시할 카운터"><button aria-pressed={tab==='stitch'} onClick={()=>setTab('stitch')}>코수</button><button aria-pressed={tab==='row'} onClick={()=>setTab('row')}>단수</button></div><p className="number" aria-label={`현재 ${tab==='stitch'?'코수':'단수'}`}>{s.counter[tab].current}</p><p>코수 {s.counter.stitch.current} · 완료 단수 {s.counter.row.current}</p>
      <div className="buttons"><button disabled={locked||s.counter[tab].current===0} onClick={()=>session.counter({type:'change',counter:tab,delta:-1})}>−1</button><button className="primary" disabled={locked} onClick={()=>tab==='row'?open('row'):session.counter({type:'change',counter:'stitch',delta:1})}>{tab==='row'?'다음 단으로 +1':'+1'}</button></div><button disabled={locked||(!view.pending&&!lastUndoableEvent(s.events))} onClick={()=>session.counter('undo')}>직전 변경 실행 취소</button><button disabled={locked} onClick={()=>open('row')}>한 단 완료</button><p>저장된 카운터 이력 {s.events.length}건 · 마지막 변경 {s.events.at(-1)?.occurredAt??'없음'}</p><details><summary>최근 저장 이력</summary><ol>{s.events.slice(-5).reverse().map(e=><li key={e.eventId}>{e.action.type==='undo'?'실행 취소':e.action.type==='completeRow'?'단 완료':'카운트'}: {e.before.stitch.current}코/{e.before.row.current}단 → {e.after.stitch.current}코/{e.after.row.current}단</li>)}</ol></details></section>
    <section><h2>작업 타이머</h2><p className="clock">{time}</p><p>{active?'작업 중 · 앱 종료 후에도 경과 시간을 계산합니다.':'시작 전 또는 종료됨'}</p>{last?.status==='ended'&&<p>마지막 확정 작업 시간 {(last.accumulatedMs/1000).toFixed(1)}초 · 세션 {s.sessions.length}개 보존</p>}{timeError&&<p role="alert">{timeError}</p>}<button disabled={locked||!!view.pending||!!timeError} onClick={()=>active?open('end'):session.timer('start')}>{active?'작업 종료':'새 작업 시작'}</button></section>
    <section><h2>대표 사진</h2>{photo?<img src={photo} alt="PoC 프로젝트 대표 사진"/>:<p>사진 미등록</p>}<label htmlFor="photo">사진 선택·교체 (JPEG·PNG·WebP, 10MiB 이하)</label><input ref={fileRef} id="photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={locked||!!view.pending} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void jobRun(async()=>{const prepared=await preparePhoto(file);session.photo(prepared);await session.settled();});}}/>{s.photo&&<p>{s.photo.width}×{s.photo.height} · {(s.photo.blob.size/1024).toFixed(0)}KiB · 선택 파일 원본은 별도 보관하지 않습니다.</p>}</section>
    <section><h2>ZIP 백업·복원</h2><p>PoC 기록만 포함합니다. ZIP은 암호화되지 않습니다. 복원은 현재 PoC 데이터 전체를 교체하며 기존 StitchMori 데이터는 읽거나 변경하지 않습니다.</p><button disabled={locked||!!view.pending} onClick={()=>void jobRun(async()=>{const current=await session.store.read();if(!current)throw new Error('백업할 기록이 없습니다.');setMessage(await saveBackup(await exportZip(current)));})}>ZIP 백업 파일 저장·공유</button><label htmlFor="backup">백업 ZIP 선택</label><input ref={restoreFile} id="backup" type="file" accept=".zip,application/zip" disabled={locked||!!view.pending} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void jobRun(async()=>{const prepared=await importZip(file);setRestore(prepared);open('restore');});}}/></section></>}
    {!s&&<section><h2>기존 PoC 백업 복원</h2><input aria-label="백업 ZIP 선택" type="file" accept=".zip" disabled={locked||!!view.pending} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void jobRun(async()=>{setRestore(await importZip(file));open('restore');});}}/></section>}
    <aside><p>PoC 저장소: <code>{DB_NAME}</code></p><p>기기 저장은 영구 보관을 보장하지 않습니다. 저장 공간 정리·앱 삭제 전 외부 ZIP 백업을 확인하세요. 웹 셸은 서버에서 최초 로드해야 하며 설치형 앱의 첫 오프라인 실행은 실기기 검증 대상입니다.</p></aside>
    <dialog ref={dialog} aria-labelledby="modal-title" onCancel={e=>{e.preventDefault();close();}} onClose={()=>trigger.current?.isConnected&&trigger.current.focus()}><h2 id="modal-title">{modal==='row'?'한 단을 완료할까요?':modal==='end'?'작업을 종료할까요?':'PoC 기록을 전체 교체할까요?'}</h2>
      {modal==='row'&&<><p>{s?.counter.row.current}단 → {(s?.counter.row.current??0)+1}단 · 현재 코수 {s?.counter.stitch.current}</p><button onClick={()=>{close();session.counter({type:'completeRow',stitch:'reset'});}}>코수 0으로 초기화</button><button onClick={()=>{close();session.counter({type:'completeRow',stitch:'keep'});}}>현재 코수 유지</button></>}
      {modal==='end'&&<><p>실제 기록은 보존하며 다음 시작은 새 세션입니다.</p><button onClick={()=>{close();session.timer('end');}}>작업 종료 확정</button></>}
      {modal==='restore'&&restore&&<><p>{restore.project.name} · {restore.counter.stitch.current}코/{restore.counter.row.current}단 · 카운터 이력 {restore.events.length}건 · 세션 {restore.sessions.length}개 · 사진 {restore.photo?1:0}장</p><p>현재 PoC 기록을 먼저 백업하세요. 실행 중인 타이머도 백업 당시 상태로 복원되어 이후 경과 시간이 포함될 수 있습니다.</p><button onClick={()=>{session.restore(restore);close();}}>위험을 확인하고 전체 교체</button></>}
      <button ref={cancel} onClick={close}>취소</button></dialog>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
