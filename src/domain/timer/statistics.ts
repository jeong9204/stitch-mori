import { effectiveWorkTime,allocateAdjustedDay,type TimeAdjustment } from './adjustments';
import { elapsedMilliseconds } from './engine';
import type { TimerEvent, WorkSession } from './types';
export type WorkTimeSummary = {workItemId:string; name:string; projectId:string|null; partId:string|null; deleted:boolean; savedMs:number; liveMs:number; todaySavedMs:number; todayLiveMs:number; lastWorkedAt:string|null; active:WorkSession|null;adjustedSessions?:number};
export type TimeStatistics = {zone:string; day:string; serverNow:string; works:WorkTimeSummary[]; recent:(WorkSession & {effectiveMs?:number;adjustmentRevision?:number;sourceLocalSessionId?:string})[]; hasMore:boolean};
const formatters=new Map<string,Intl.DateTimeFormat>();
export function dayKey(at:number,zone:string):string {
  if(!formatters.has(zone))formatters.set(zone,new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}));
  const parts=formatters.get(zone)!.formatToParts(at);
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
/** Find actual local midnight boundaries, including 23/25 hour DST days. */
export function dayBounds(at:number,zone:string):[number,number] {
  const day=dayKey(at,zone),next=new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
  function boundary(key:string) {const anchor=Date.parse(`${key}T00:00:00Z`);let lo=anchor-36*3600000,hi=anchor+36*3600000;while(lo<hi){const mid=Math.floor((lo+hi)/2);if(dayKey(mid,zone)<key)lo=mid+1;else hi=mid;}return lo;}
  return [boundary(day),boundary(next)];
}
export function overlapMs(start:number,end:number,from:number,to:number) {return Math.max(0,Math.min(end,to)-Math.max(start,from));}
export function localTimeStatistics(states:readonly WorkSession[],events:readonly TimerEvent[],at:string,zone:string,offset=0,adjustments:readonly TimeAdjustment[]=[]):TimeStatistics {
  const now=Date.parse(at),[from,to]=dayBounds(now,zone),works=new Map<string,WorkTimeSummary>();
  for(const state of new Map(states.map(s=>[s.sessionId,s])).values()) {
    const summary=works.get(state.workItemId)??{workItemId:state.workItemId,name:'이 기기의 간편 카운터',projectId:null,partId:null,deleted:false,savedMs:0,liveMs:0,todaySavedMs:0,todayLiveMs:0,lastWorkedAt:null,active:null,adjustedSessions:0};
    const ownAdjustments=adjustments.filter(a=>a.sessionId===state.sessionId);
    const effective=effectiveWorkTime(state,ownAdjustments);
    summary.savedMs+=effective;
    summary.adjustedSessions=(summary.adjustedSessions??0)+(ownAdjustments.length?1:0);
    summary.liveMs+=elapsedMilliseconds(state,at)-state.accumulatedMs;
    if(state.status!=='ended')summary.active=state;

    const ordered=[...new Map(events.filter(e=>e.command.sessionId===state.sessionId).map(e=>[e.eventId,e])).values()].sort((a,b)=>a.after.revision-b.after.revision);
    let measured=0,beforeDay=0,duringDay=0;
    for(let i=0;i<ordered.length;i++) {
      const e=ordered[i];if(e.after.revision!==i+1)throw new Error('작업 시간 이벤트 순서를 확인할 수 없습니다.');
      if(e.after.status!=='running')continue;
      const start=Date.parse(e.effectiveAt),next=ordered[i+1],end=next?Date.parse(next.effectiveAt):now;
      if(!next && state.status!=='running')throw new Error('작업 시간 이벤트가 누락되었습니다.');
      if(end<start)throw new Error('작업 시간의 시각 순서가 올바르지 않습니다.');
      measured+=end-start;
      const workedAt=new Date(end).toISOString();
      if(!summary.lastWorkedAt || summary.lastWorkedAt<workedAt)summary.lastWorkedAt=workedAt;
      if(next){beforeDay+=Math.max(0,Math.min(end,from)-start);duringDay+=overlapMs(start,end,from,to);}else summary.todayLiveMs+=overlapMs(start,end,from,to);
    }
    if(measured!==elapsedMilliseconds(state,at))throw new Error('작업 시간과 세션 기록이 일치하지 않습니다.');
    summary.todaySavedMs+=ownAdjustments.length?allocateAdjustedDay(state.accumulatedMs,effective,beforeDay,duringDay,state.endedAt!,from,to):duringDay;
    works.set(state.workItemId,summary);
  }
  const ended=[...new Map(states.map(s=>[s.sessionId,s])).values()].filter(s=>s.status==='ended').sort((a,b)=>b.endedAt!.localeCompare(a.endedAt!));
  return {zone,day:dayKey(now,zone),serverNow:at,works:[...works.values()],recent:ended.slice(offset,offset+20).map(session=>({...session,effectiveMs:effectiveWorkTime(session,adjustments),adjustmentRevision:adjustments.filter(a=>a.sessionId===session.sessionId).length})),hasMore:ended.length>offset+20};
}
export function formatWorkTime(ms:number) {const seconds=Math.floor(Math.max(0,ms)/1000);return `${Math.floor(seconds/3600)}시간 ${Math.floor(seconds/60)%60}분 ${seconds%60}초`;}
