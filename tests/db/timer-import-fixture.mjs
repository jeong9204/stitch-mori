import {randomUUID} from 'node:crypto';
export function timerBundle(workItemId,minutes=30){
 const sessionId=randomUUID(),events=[];let state=null;
 for(const [i,action] of ['start','pause','resume','end'].entries()){
  const at=new Date(Date.UTC(2026,9,22,14,40+i*minutes)).toISOString();
  const command={commandId:randomUUID(),sessionId,workItemId,expectedRevision:i,occurredAt:at,deviceId:'local-fixture',action};
  const before=state;state=i===0?{sessionId,workItemId,userId:null,status:'running',startedAt:at,endedAt:null,accumulatedMs:0,lastResumedAt:at,lastTransitionAt:at,revision:1,createdAt:at,updatedAt:at}:{...state,status:action==='pause'?'paused':action==='resume'?'running':'ended',accumulatedMs:state.accumulatedMs+(state.status==='running'?Date.parse(at)-Date.parse(state.lastResumedAt):0),lastResumedAt:action==='resume'?at:null,endedAt:action==='end'?at:null,lastTransitionAt:at,updatedAt:at,revision:i+1};
  events.push({eventId:command.commandId,command,effectiveAt:at,before,after:state});
 }
 const adjustments=[{adjustmentId:randomUUID(),commandId:randomUUID(),sessionId,userId:null,previousAdjustedMs:state.accumulatedMs,adjustedMs:7200000,reason:'블로킹 후 기록 정정',createdAt:'2026-10-23T05:00:00.000Z',revision:1},{adjustmentId:randomUUID(),commandId:randomUUID(),sessionId,userId:null,previousAdjustedMs:7200000,adjustedMs:5400000,reason:'다시 확인',createdAt:'2026-10-23T06:00:00.000Z',revision:2}];
 return {state,events,adjustments};
}
export function counterSnapshot(localWorkItemId=randomUUID(),importId=randomUUID()){
 return {importId,localWorkItemId,state:{workItemId:localWorkItemId,revision:0,stitch:{current:0,target:null},row:{current:0,target:null}},events:[]};
}
