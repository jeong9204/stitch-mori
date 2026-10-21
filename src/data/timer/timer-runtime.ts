import type { SupabaseClient } from "@supabase/supabase-js";
import { TimerController } from "./timer-controller";
import { AccountTimerBackend, LocalTimerBackend } from "./timer-ui-backend";
const timers=new Map<string,TimerController>();
const accountSubscriptions=new Map<string,()=>void>();
export function localTimer(workItemId: string,baselineRevision: number): TimerController {
  const key=`local:${workItemId}`;
  if(!timers.has(key))timers.set(key,new TimerController(new LocalTimerBackend(workItemId),baselineRevision));
  return timers.get(key)!;
}
export function accountTimer(client: SupabaseClient,userId: string,workItemId: string,baselineRevision: number): TimerController {
  if(!accountSubscriptions.has(userId)) {
    const {data}=client.auth.onAuthStateChange((event,session)=>{
      if(event==="SIGNED_OUT" || (event==="SIGNED_IN" && session?.user.id!==userId))hideAccountTimers(userId);
    });
    accountSubscriptions.set(userId,()=>data.subscription.unsubscribe());
  }
  const key=`account:${userId}:${workItemId}`;
  if(!timers.has(key))timers.set(key,new TimerController(new AccountTimerBackend(client,userId,workItemId),baselineRevision));
  return timers.get(key)!;
}
export function hideAccountTimers(userId: string) {
  accountSubscriptions.get(userId)?.();accountSubscriptions.delete(userId);
  for(const [key,controller] of timers)if(key.startsWith(`account:${userId}:`)){controller.dispose();timers.delete(key);}
}
