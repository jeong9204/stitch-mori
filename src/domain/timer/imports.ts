import {applyTimerCommand} from './engine';
import {effectiveWorkTime,type TimeAdjustment} from './adjustments';
import type {TimerEvent,WorkSession} from './types';
export type TimerImportSession={state:WorkSession;events:TimerEvent[];adjustments:TimeAdjustment[]};
export type TimerImportSnapshot={importId:string;counterImportId:string;localWorkItemId:string;sessions:TimerImportSession[]};
export type TimerImportReceipt={importId:string;serverWorkItemId:string;status:'imported'|'duplicate';mappings:{localSessionId:string;serverSessionId:string}[]};
/** Validate the complete immutable history, rather than trusting a submitted total. */
export function validateTimerImport(bundle:TimerImportSession,workItemId:string){
  let state:WorkSession|null=null;const seen=new Set<string>();
  if(bundle.state.userId!==null || bundle.state.workItemId!==workItemId || bundle.state.status!=='ended' || !bundle.events.length)throw new Error('종료된 로컬 세션만 가져올 수 있습니다.');
  for(const event of bundle.events){
    if(seen.has(event.eventId)||event.eventId!==event.command.commandId||event.command.sessionId!==bundle.state.sessionId||event.command.workItemId!==workItemId)throw new Error('타이머 이벤트 식별자가 일치하지 않습니다.');
    seen.add(event.eventId);
    const result=applyTimerCommand(state,[],event.command,event.effectiveAt);
    if(result.status!=='applied'||JSON.stringify(event.before)!==JSON.stringify(state)||JSON.stringify(event.after)!==JSON.stringify(result.state))throw new Error('타이머 이벤트 순서·시간이 일치하지 않습니다.');
    state=result.state;
  }
  if(JSON.stringify(state)!==JSON.stringify(bundle.state))throw new Error('세션과 이벤트가 일치하지 않습니다.');
  if(bundle.adjustments.some(a=>a.sessionId!==bundle.state.sessionId||a.userId!==null||!Number.isFinite(Date.parse(a.createdAt))||a.reason.length>1000))throw new Error('정정 이력이 올바르지 않습니다.');
  return effectiveWorkTime(bundle.state,bundle.adjustments);
}
