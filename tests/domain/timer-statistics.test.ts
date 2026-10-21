import {describe,it,expect} from 'vitest';
import {applyTimerCommand} from '../../src/domain/timer/engine';
import {localTimeStatistics,dayBounds,dayKey} from '../../src/domain/timer/statistics';
import {activityBaseline,inactivityDue} from '../../src/domain/timer/inactivity';
import type {TimerAction,TimerEvent,WorkSession} from '../../src/domain/timer/types';
function history(steps:[TimerAction,string][],work='body') {
  let state:WorkSession|null=null;const events:TimerEvent[]=[];const sessionId=crypto.randomUUID();
  for(const [action,at] of steps) {
    const command={commandId:crypto.randomUUID(),sessionId,workItemId:work,expectedRevision:state?.revision??0,action,occurredAt:at,deviceId:'test'};
    const result=applyTimerCommand(state,events,command);if(result.status!=='applied')throw new Error('fixture');
    events.push({eventId:command.commandId,command,effectiveAt:at,before:state,after:result.state});state=result.state;
  }return {state:state!,events};
}
describe('work interval statistics',()=>{
  const sample=()=>history([['start','2026-10-20T23:30:00Z'],['pause','2026-10-21T00:15:00Z'],['resume','2026-10-21T01:00:00Z'],['end','2026-10-21T01:30:00Z']]);
  it('splits midnight and excludes paused intervals',()=>{
    const {state,events}=sample();const today=localTimeStatistics([state],events,'2026-10-21T05:00:00Z','UTC');
    expect(today.works[0]).toMatchObject({savedMs:75*60000,todaySavedMs:45*60000,liveMs:0,todayLiveMs:0});
    expect(localTimeStatistics([state],events,'2026-10-20T23:59:59Z','UTC').works[0].todaySavedMs).toBe(30*60000);
  });
  it('separates stored accumulated time from the running estimate',()=>{
    const {state,events}=history([['start','2026-10-20T14:00:00Z'],['pause','2026-10-20T14:30:00Z'],['resume','2026-10-20T14:45:00Z']]);
    expect(localTimeStatistics([state],events,'2026-10-20T15:15:00Z','UTC').works[0]).toMatchObject({savedMs:1800000,liveMs:1800000,todaySavedMs:1800000,todayLiveMs:1800000});
  });
  it('counts paused time as saved without any live interval',()=>{
    const {state,events}=history([['start','2026-10-20T14:00:00Z'],['pause','2026-10-20T14:30:00Z']]);
    expect(localTimeStatistics([state],events,'2026-10-21T14:30:00Z','UTC').works[0]).toMatchObject({savedMs:1800000,liveMs:0,todaySavedMs:0});
  });
  it('deduplicates sessions/events and preserves independent parts',()=>{
    const a=sample(),b=history([['start','2026-10-21T02:00:00Z'],['end','2026-10-21T02:10:00Z']],'sleeve');
    const result=localTimeStatistics([a.state,a.state,b.state],[...a.events,...a.events,...b.events],'2026-10-21T05:00:00Z','UTC');
    expect(result.works.map(w=>w.savedMs)).toEqual([4500000,600000]);expect(result.recent).toHaveLength(2);
  });
  it('uses IANA timezone boundaries including DST',()=>{
    const spring=dayBounds(Date.parse('2026-03-08T12:00:00Z'),'America/New_York');expect(spring[1]-spring[0]).toBe(23*3600000);
    const fall=dayBounds(Date.parse('2026-11-01T12:00:00Z'),'America/New_York');expect(fall[1]-fall[0]).toBe(25*3600000);
    expect(dayKey(Date.parse('2026-10-20T16:00:00Z'),'Asia/Seoul')).toBe('2026-10-21');
  });
  it('does not treat ending an already paused session as recent working time',()=>{
    const {state,events}=history([['start','2026-10-20T14:00:00Z'],['pause','2026-10-20T14:30:00Z'],['end','2026-10-21T12:00:00Z']]);
    expect(localTimeStatistics([state],events,'2026-10-21T13:00:00Z','UTC').works[0].lastWorkedAt).toBe('2026-10-20T14:30:00.000Z');
  });
  it('rejects missing event revisions instead of inventing daily time',()=>{
    const {state,events}=sample();expect(()=>localTimeStatistics([state],events.slice(1),'2026-10-21T05:00:00Z','UTC')).toThrow();
  });
  it('returns empty real data and pages completed sessions',()=>{
    expect(localTimeStatistics([],[],'2026-10-21T00:00:00Z','UTC').works).toEqual([]);
    const {state,events}=sample();expect(localTimeStatistics([state],events,'2026-10-21T05:00:00Z','UTC',20).recent).toEqual([]);
  });
});
describe('inactivity clock',()=>{
  const {state}=history([['start','2026-10-20T14:00:00Z']]);
  it('uses start without counts; exact 30 minute boundary is due',()=>{
    const baseline=activityBaseline(state,null);
    expect(inactivityDue({session:state,baseline,shown:false,now:'2026-10-20T14:29:59Z'})).toBe(false);
    expect(inactivityDue({session:state,baseline,shown:false,now:'2026-10-20T14:30:00Z'})).toBe(true);
  });
  it('uses a new count/explicit continue as a new interval',()=>{
    expect(activityBaseline(state,'2026-10-20T14:10:00Z')).toBe('2026-10-20T14:10:00.000Z');
    expect(activityBaseline(state,'2026-10-20T14:10:00Z','2026-10-20T14:31:00Z')).toBe('2026-10-20T14:31:00.000Z');
  });
  it('suppresses shown, paused and ended intervals',()=>{
    const context={session:state,baseline:state.startedAt,shown:false,now:'2026-10-21T14:00:00Z'};
    expect(inactivityDue({...context,shown:true})).toBe(false);
    expect(inactivityDue({...context,session:{...state,status:'paused'}})).toBe(false);
    expect(inactivityDue({...context,session:{...state,status:'ended'}})).toBe(false);
  });
});
