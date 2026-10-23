import type {SessionTimeAdjustment,WorkSession} from './types';
export type TimeAdjustment=SessionTimeAdjustment & {userId:string|null;revision:number};
export type AdjustmentCommand={requestId:string;sessionId:string;expectedRevision:number;adjustedMs:number;reason:string};
export type AdjustmentSnapshot={session:WorkSession;adjustments:TimeAdjustment[];effectiveMs:number;revision:number;canAdjust:boolean};
export type AdjustmentResult={status:'applied'|'duplicate';adjustment:TimeAdjustment}|{status:'conflict';revision:number}|{status:'rejected';reason:string};
export function validAdjustment(command:AdjustmentCommand):boolean {
  return typeof command.requestId==='string' && command.requestId.length>0 && typeof command.sessionId==='string' && command.sessionId.length>0
    && Number.isSafeInteger(command.expectedRevision) && command.expectedRevision>=0 && command.expectedRevision<Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(command.adjustedMs) && command.adjustedMs>=0 && typeof command.reason==='string' && command.reason.length<=1000;
}
export function effectiveWorkTime(session:WorkSession,history:readonly TimeAdjustment[]):number {
  const ordered=history.filter(a=>a.sessionId===session.sessionId).sort((a,b)=>a.revision-b.revision);
  let effective=session.accumulatedMs;
  for(let i=0;i<ordered.length;i++) {
    const a=ordered[i];if(a.revision!==i+1 || a.previousAdjustedMs!==effective || !Number.isSafeInteger(a.adjustedMs) || a.adjustedMs<0)throw new Error('정정 이력의 순서 또는 시간이 일치하지 않습니다.');
    effective=a.adjustedMs;
  }return effective;
}
export function applyTimeAdjustment(session:WorkSession,history:readonly TimeAdjustment[],command:AdjustmentCommand,at:string):AdjustmentResult {
  if(!validAdjustment(command))return {status:'rejected',reason:'invalid_adjustment'};
  const prior=history.find(a=>a.commandId===command.requestId);
  if(prior)return prior.sessionId===command.sessionId && prior.revision===command.expectedRevision+1 && prior.adjustedMs===command.adjustedMs && prior.reason===command.reason.trim()
    ? {status:'duplicate',adjustment:prior}:{status:'rejected',reason:'request_id_reused'};
  if(session.sessionId!==command.sessionId)return {status:'rejected',reason:'session_identity_mismatch'};
  if(session.status!=='ended')return {status:'rejected',reason:'session_not_ended'};
  const own=history.filter(a=>a.sessionId===session.sessionId),previous=effectiveWorkTime(session,own);
  if(own.length!==command.expectedRevision)return {status:'conflict',revision:own.length};
  if(!Number.isFinite(Date.parse(at)))return {status:'rejected',reason:'invalid_timestamp'};
  return {status:'applied',adjustment:{adjustmentId:command.requestId,commandId:command.requestId,sessionId:session.sessionId,userId:session.userId,
    previousAdjustedMs:previous,adjustedMs:command.adjustedMs,reason:command.reason.trim(),createdAt:at,revision:own.length+1}};
}
/** Cumulative integer allocation conserves the corrected total across all dates.
 * This is a proportional estimate, not a reconstruction of actual work intervals. */
export function allocateAdjustedDay(originalMs:number,effectiveMs:number,beforeDayMs:number,duringDayMs:number,endedAt:string,from:number,to:number):number {
  if(![originalMs,effectiveMs,beforeDayMs,duringDayMs].every(n=>Number.isSafeInteger(n)&&n>=0) || beforeDayMs+duringDayMs>originalMs)throw new Error('invalid_adjustment_allocation');
  if(originalMs===0)return Date.parse(endedAt)>=from && Date.parse(endedAt)<to?effectiveMs:0;
  const original=BigInt(originalMs),effective=BigInt(effectiveMs),before=BigInt(beforeDayMs),during=BigInt(duringDayMs);
  return Number(effective*(before+during)/original-effective*before/original);
}
export function parseAdjustmentDuration(hours:string,minutes:string,seconds:string):number {
  if(!/^\d{1,13}$/.test(hours) || !/^\d{1,2}$/.test(minutes) || Number(minutes)>59 || !/^\d{1,2}(?:\.\d{1,3})?$/.test(seconds) || Number(seconds)>=60)throw new Error('시간은 0 이상, 분·초는 60 미만으로 입력해 주세요.');
  const [whole,fraction='']=seconds.split('.');
  const value=BigInt(hours)*BigInt(3600000)+BigInt(minutes)*BigInt(60000)+BigInt(whole)*BigInt(1000)+BigInt(fraction.padEnd(3,'0'));
  if(value>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('정정 시간이 허용 범위를 넘습니다.');return Number(value);
}
