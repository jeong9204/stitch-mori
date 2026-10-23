import {it,expect} from 'vitest';
import {observeTimerImportBlocker,hasPendingTimerChanges} from '../../src/data/timer/timer-import-guard';
it('detects memory-only pending changes in another editor without mixing account scopes',async()=>{
 const close=observeTimerImportBlocker('alice',()=>true);
 try{expect(await hasPendingTimerChanges('alice')).toBe(true);expect(await hasPendingTimerChanges('bob')).toBe(false);}finally{close();}
});
it('blocks local pending changes for any account and clears when the editor resolves them',async()=>{
 let pending=true;const close=observeTimerImportBlocker(null,()=>pending);
 try{expect(await hasPendingTimerChanges('alice')).toBe(true);pending=false;expect(await hasPendingTimerChanges('alice')).toBe(false);}finally{close();}
});
