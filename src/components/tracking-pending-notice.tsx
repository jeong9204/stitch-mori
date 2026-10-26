"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { IndexedDbTrackingOutbox, watchTrackingOutbox, type TrackingEntry } from "@/data/projects/tracking-outbox";
export function TrackingPendingNotice({userId,projects}:{userId:string;projects:{id:string;name:string}[]}) {
  const [store]=useState(()=>new IndexedDbTrackingOutbox());
  const [reload,setReload]=useState(0);
  const [items,setItems]=useState<TrackingEntry[]>([]),[error,setError]=useState("");
  useEffect(()=>{
    let active=true,version=0;
    const load=async()=>{const current=++version;try{const loaded=await store.list(userId);if(active&&current===version){setItems(loaded);setError("");}}catch(e){if(active&&current===version)setError(e instanceof Error?e.message:"대기 요청을 확인하지 못했습니다.");}};
    void load();const stop=watchTrackingOutbox(()=>void load());return()=>{active=false;stop();};
  },[reload,store,userId]);
  if(error)return <aside className="tracking-warning" role="alert">기기에 보관된 요청 목록을 확인하지 못했어요. 원본은 삭제하지 않았습니다. {error}<button className="button button-secondary" onClick={()=>setReload(n=>n+1)}>대기 요청 목록 다시 확인</button></aside>;
  if(!items.length)return null;
  return <aside className="tracking-warning" aria-label="기기에 보관된 프로젝트 요청"><p>확인이 필요한 프로젝트 요청 {items.length}개</p><p>기기 보관과 서버 저장은 다릅니다. 자동 전송하지 않으니 해당 프로젝트에서 확인해 주세요.</p><ul>{items.map(item=><li key={item.projectId}><Link href={`/projects/${item.projectId}`}>{projects.find(p=>p.id===item.projectId)?.name ?? `프로젝트 ${item.projectId.slice(0,8)}`} · {item.command.action.type==="setProgress"?"진행률":"파트 상태"} 요청 확인 · {item.stage==="conflict"?"충돌 확인 필요":item.stage==="confirmed"?"서버 확정 후 조회·정리 대기":"재시도 가능"}</Link></li>)}</ul></aside>;
}
