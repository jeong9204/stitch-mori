import type { WorkSession } from './types';
export const INACTIVITY_MS=30*60*1000;
export type InactivityChoice='continue'|'later'|'pause';
export type InactivityRecord={baseline:string;shown:boolean;continuedAt?:string;choice?:InactivityChoice};
export type InactivitySnapshot={session:WorkSession;baseline:string;shown:boolean;now:string};
export function activityBaseline(session:WorkSession,lastCountAt:string|null,continuedAt?:string):string {
  return new Date(Math.max(Date.parse(session.startedAt),lastCountAt?Date.parse(lastCountAt):0,continuedAt?Date.parse(continuedAt):0)).toISOString();
}
export function inactivityDue(value:InactivitySnapshot):boolean {
  return value.session.status==='running' && !value.shown && Date.parse(value.now)-Date.parse(value.baseline)>=INACTIVITY_MS;
}
