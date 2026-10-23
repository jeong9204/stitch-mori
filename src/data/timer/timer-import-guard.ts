import {hasPendingTimerRuntime} from './timer-runtime';
/** UI-only failures may not have reached IndexedDB. Query mounted editors in other tabs too. */
export function observeTimerImportBlocker(userId:string|null,blocked:()=>boolean){
 const channel=new BroadcastChannel('stitchmori-timer-import-check');
 channel.onmessage=(event:MessageEvent<{type:string;userId:string;nonce:string}>)=>{
  if(event.data.type==='check'&&(!userId||event.data.userId===userId)&&blocked())channel.postMessage({type:'blocked',nonce:event.data.nonce});
 };return()=>channel.close();
}
export async function hasPendingTimerChanges(userId:string):Promise<boolean>{
 if(hasPendingTimerRuntime(userId))return true;
 const channel=new BroadcastChannel('stitchmori-timer-import-check'),nonce=crypto.randomUUID();let blocked=false;
 channel.onmessage=(event:MessageEvent<{type:string;nonce:string}>)=>{if(event.data.type==='blocked'&&event.data.nonce===nonce)blocked=true;};
 channel.postMessage({type:'check',nonce,userId});await new Promise(resolve=>setTimeout(resolve,250));channel.close();return blocked;
}
