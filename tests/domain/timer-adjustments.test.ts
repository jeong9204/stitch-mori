import {describe,it,expect} from 'vitest';
import {applyTimeAdjustment,effectiveWorkTime,allocateAdjustedDay,parseAdjustmentDuration,type AdjustmentCommand,type TimeAdjustment} from '../../src/domain/timer/adjustments';
import {applyTimerCommand} from '../../src/domain/timer/engine';
import {localTimeStatistics} from '../../src/domain/timer/statistics';
import type {TimerEvent,WorkSession} from '../../src/domain/timer/types';
function fixture(){
  let state:WorkSession|null=null;const events:TimerEvent[]=[];const sessionId=crypto.randomUUID();
  const steps=[['start','2026-10-20T23:30:00Z'],['pause','2026-10-21T00:15:00Z'],['resume','2026-10-21T01:00:00Z'],['end','2026-10-21T01:30:00Z']] as const;
  for(const [action,at] of steps){const command={commandId:crypto.randomUUID(),sessionId,workItemId:'body',expectedRevision:state?.revision??0,occurredAt:at,deviceId:'test',action};const result=applyTimerCommand(state,events,command);if(result.status!=='applied')throw new Error('fixture');events.push({eventId:command.commandId,command,effectiveAt:at,before:state,after:result.state});state=result.state;}
  return {state:state!,events};
}
function command(sessionId:string,adjustedMs=6000000,expectedRevision=0):AdjustmentCommand{return {requestId:crypto.randomUUID(),sessionId,adjustedMs,expectedRevision,reason:'작업 시간을 보정'};}
function applied(state:WorkSession,history:TimeAdjustment[],cmd=command(state.sessionId)) {const result=applyTimeAdjustment(state,history,cmd,'2026-10-23T00:00:00Z');if(result.status!=='applied')throw new Error('fixture');return result.adjustment;}
describe('audited time adjustments',()=>{
  it('preserves the measured session and stores before/after, reason, ID, actor and revision',()=>{
    const {state}=fixture(),original=structuredClone(state),cmd=command(state.sessionId);
    const adjustment=applied(state,[],cmd);expect(state).toEqual(original);
    expect(adjustment).toMatchObject({commandId:cmd.requestId,previousAdjustedMs:4500000,adjustedMs:6000000,revision:1,reason:cmd.reason,userId:null});
  });
  it('uses only the last confirmed correction, including zero and an empty reason',()=>{
    const {state}=fixture(),first=applied(state,[]),second=applied(state,[first],{...command(state.sessionId,0,1),reason:''});
    expect(second.previousAdjustedMs).toBe(6000000);expect(effectiveWorkTime(state,[first,second])).toBe(0);
  });
  it('returns duplicate for the same request and rejects changed payload reuse',()=>{
    const {state}=fixture(),cmd=command(state.sessionId),first=applied(state,[],cmd);
    expect(applyTimeAdjustment(state,[first],cmd,'2026-10-24T00:00:00Z')).toEqual({status:'duplicate',adjustment:first});
    expect(applyTimeAdjustment(state,[first],{...cmd,adjustedMs:1},'2026-10-24T00:00:00Z')).toMatchObject({status:'rejected',reason:'request_id_reused'});
  });
  it('blocks stale revision, running and paused sessions',()=>{
    const {state}=fixture(),first=applied(state,[]);
    expect(applyTimeAdjustment(state,[first],command(state.sessionId),'2026-10-23T00:00:00Z')).toMatchObject({status:'conflict',revision:1});
    for(const status of ['running','paused'] as const)expect(applyTimeAdjustment({...state,status},[],command(state.sessionId),'2026-10-23T00:00:00Z')).toMatchObject({status:'rejected',reason:'session_not_ended'});
  });
  it('rejects negative/fractional/unsafe time and invalid reasons',()=>{
    const {state}=fixture();for(const value of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(applyTimeAdjustment(state,[],command(state.sessionId,value),'2026-10-23T00:00:00Z').status).toBe('rejected');
    expect(applyTimeAdjustment(state,[],{...command(state.sessionId),reason:'x'.repeat(1001)},'2026-10-23T00:00:00Z').status).toBe('rejected');
  });
  it('parses hours/minutes/fractional seconds without dropping milliseconds',()=>{
    expect(parseAdjustmentDuration('1','02','03.456')).toBe(3723456);expect(parseAdjustmentDuration('0','0','0')).toBe(0);
    for(const [h,m,s] of [['-1','0','0'],['0','60','0'],['0','0','60'],['0','0','0.0001'],['9999999999999','0','0']])expect(()=>parseAdjustmentDuration(h,m,s)).toThrow();
  });
  it('conserves every corrected millisecond under daily proportional allocation',()=>{
    const ended='2026-10-23T00:00:00Z';const portions=[1,2,4];let before=0,total=0;
    for(const original of portions){total+=allocateAdjustedDay(7,10,before,original,ended,0,1);before+=original;}
    expect(total).toBe(10);
    expect(allocateAdjustedDay(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER-1,0,Number.MAX_SAFE_INTEGER,ended,0,1)).toBe(Number.MAX_SAFE_INTEGER-1);
  });
  it('assigns a corrected zero-original session to its end date only',()=>{
    const end='2026-10-21T00:00:00Z',at=Date.parse(end);
    expect(allocateAdjustedDay(0,1000,0,0,end,at,at+86400000)).toBe(1000);
    expect(allocateAdjustedDay(0,1000,0,0,end,at-86400000,at)).toBe(0);
  });
  it('reflects corrections in totals, recent history and both sides of midnight without double counting',()=>{
    const {state,events}=fixture(),history=[applied(state,[],command(state.sessionId,6000000))];
    const day1=localTimeStatistics([state],events,'2026-10-20T23:59:59Z','UTC',0,history),day2=localTimeStatistics([state],events,'2026-10-21T05:00:00Z','UTC',0,history);
    expect(day1.works[0].todaySavedMs).toBe(2400000);expect(day2.works[0].todaySavedMs).toBe(3600000);expect(day2.works[0].savedMs).toBe(6000000);
    expect(day2.recent[0]).toMatchObject({accumulatedMs:4500000,effectiveMs:6000000,adjustmentRevision:1});expect(state.revision).toBe(4);
  });
  it('detects a broken audit chain instead of inventing effective time',()=>{
    const {state}=fixture(),first=applied(state,[]);expect(()=>effectiveWorkTime(state,[{...first,previousAdjustedMs:0}])).toThrow();
  });
});
