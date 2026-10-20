import "fake-indexeddb/auto";
import { describe,expect,it,vi } from "vitest";
import { CounterConversionService } from "../../src/data/projects/counter-conversion-service";
import { IndexedDbConversionJournal } from "../../src/data/projects/conversion-journal";
import { IndexedDbCounterStore } from "../../src/data/local/indexeddb-counter-store";
import { QuickCounterSession } from "../../src/data/local/quick-counter-session";
import type { LocalImportSnapshot } from "../../src/data/import/types";
const user="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",work="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function fixture(){
  const local=new IndexedDbCounterStore(`local-convert-${crypto.randomUUID()}`);
  const journal=new IndexedDbConversionJournal(`intent-${crypto.randomUUID()}`);
  const importer={importSnapshot:vi.fn(async(snapshot:LocalImportSnapshot)=>({status:"imported" as const,importId:snapshot.importId,localWorkItemId:snapshot.localWorkItemId,serverWorkItemId:work,importedRevision:snapshot.state.revision}))};
  const remote={convert:vi.fn(async()=>({status:"converted" as const,projectId:"project",partId:"part",workItemId:work,revision:1}))};
  const queue={pending:vi.fn().mockResolvedValue([])};const pendingLocal=vi.fn().mockResolvedValue(false);
  const service=new CounterConversionService(journal,remote,queue,local,importer,pendingLocal);
  return{local,journal,importer,remote,queue,pendingLocal,service};
}
async function saved(local:IndexedDbCounterStore){const session=new QuickCounterSession(local);await session.load();session.enqueue({type:"change",counter:"stitch",delta:1});await session.whenSettled();return (await local.getQuickIfExists())!;}
describe("counter conversion orchestration",()=>{
  it("converts the existing account work item without importing or creating counters",async()=>{const f=fixture();await f.service.execute(user,`account:${work}`,"가디건",work,7);expect(f.remote.convert).toHaveBeenCalledWith(work,expect.any(String),7,"가디건");expect(f.importer.importSnapshot).not.toHaveBeenCalled();});
  it("keeps a successful import and the request ID after conversion failure and page reopen",async()=>{
    const f=fixture(),record=await saved(f.local);f.remote.convert.mockRejectedValueOnce(new Error("network lost"));
    await expect(f.service.execute(user,`local:${record.localWorkItemId}`,"소매",null,null,record.localWorkItemId)).rejects.toThrow("network lost");
    const intent=await f.journal.get(user,`local:${record.localWorkItemId}`);expect(intent?.workItemId).toBe(work);
    expect((await f.local.getQuickIfExists())?.importStatus).toBe("imported");
    const reopened=new CounterConversionService(f.journal,f.remote,f.queue,f.local,f.importer,f.pendingLocal);
    await reopened.execute(user,`local:${record.localWorkItemId}`,"소매",null,null,record.localWorkItemId);
    expect(f.importer.importSnapshot).toHaveBeenCalledTimes(1);expect(f.remote.convert.mock.calls[0]).toEqual(f.remote.convert.mock.calls[1]);
    expect((await f.local.getQuickIfExists())?.state).toEqual(record.state);
  });
  it("reuses an already imported local work item and excludes later local edits",async()=>{
    const f=fixture(),record=await saved(f.local);const snapshot=await f.local.beginImport(record.localWorkItemId);await f.local.finishImport(snapshot,user,work);
    const session=new QuickCounterSession(f.local);await session.load();session.enqueue({type:"change",counter:"stitch",delta:1});await session.whenSettled();
    await f.service.execute(user,`local:${record.localWorkItemId}`,"기존 기록",work,9,record.localWorkItemId);
    expect(f.importer.importSnapshot).not.toHaveBeenCalled();expect(f.remote.convert).toHaveBeenCalledWith(work,expect.any(String),9,"기존 기록");expect((await f.local.getQuickIfExists())?.state.stitch.current).toBe(2);
  });
  it("retries the exact frozen import snapshot after response loss",async()=>{
    const f=fixture(),record=await saved(f.local);f.importer.importSnapshot.mockRejectedValueOnce(new Error("import response lost"));
    await expect(f.service.execute(user,`local:${record.localWorkItemId}`,"뜨개",null,null,record.localWorkItemId)).rejects.toThrow("import response lost");
    await f.service.execute(user,`local:${record.localWorkItemId}`,"뜨개",null,null,record.localWorkItemId);
    expect(f.importer.importSnapshot.mock.calls[0]).toEqual(f.importer.importSnapshot.mock.calls[1]);
  });
  it("blocks local unsaved changes and server pending commands without deleting them",async()=>{
    const f=fixture(),record=await saved(f.local);f.pendingLocal.mockResolvedValue(true);
    await expect(f.service.execute(user,`local:${record.localWorkItemId}`,"뜨개",null,null,record.localWorkItemId)).rejects.toThrow("로컬 저장");expect(f.importer.importSnapshot).not.toHaveBeenCalled();
    f.queue.pending.mockResolvedValue([{id:1}]);await expect(f.service.execute(user,`account:${work}`,"뜨개",work,0)).rejects.toThrow("미확정");expect(f.remote.convert).not.toHaveBeenCalled();
  });
  it("keeps local records isolated from another account",async()=>{const f=fixture(),record=await saved(f.local);const snapshot=await f.local.beginImport(record.localWorkItemId);await f.local.finishImport(snapshot,user,work);
    await expect(f.service.execute("other",`local:${record.localWorkItemId}`,"뜨개",work,1,record.localWorkItemId)).rejects.toThrow("다른 계정");expect(f.remote.convert).not.toHaveBeenCalled();});
  it("does not import when saving the conversion intent fails",async()=>{const f=fixture(),record=await saved(f.local);vi.spyOn(f.journal,"begin").mockRejectedValue(new Error("storage full"));
    await expect(f.service.execute(user,`local:${record.localWorkItemId}`,"뜨개",null,null,record.localWorkItemId)).rejects.toThrow("storage full");expect(f.importer.importSnapshot).not.toHaveBeenCalled();});
  it("does not acknowledge a local import into the wrong account when auth changes during upload",async()=>{
    const f=fixture(),record=await saved(f.local);let active=true;
    const original=f.importer.importSnapshot.getMockImplementation()!;
    f.importer.importSnapshot.mockImplementation(async(snapshot)=>{const receipt=await original(snapshot);active=false;return receipt;});
    const service=new CounterConversionService(f.journal,f.remote,f.queue,f.local,f.importer,f.pendingLocal,async()=>active);
    await expect(service.execute(user,`local:${record.localWorkItemId}`,"뜨개",null,null,record.localWorkItemId)).rejects.toThrow("로그인 계정");
    expect((await f.local.getQuickIfExists())?.importedByUserId).toBeFalsy();expect(f.remote.convert).not.toHaveBeenCalled();
  });
  it("persists one stable intent per account and source across journal instances",async()=>{const db=`journal-${crypto.randomUUID()}`,journal=new IndexedDbConversionJournal(db);const first=await journal.begin(user,"local:1","프로젝트",null,null);
    expect((await new IndexedDbConversionJournal(db).begin(user,"local:1","무시되는 재요청",null,null)).requestId).toBe(first.requestId);expect(await journal.get("other","local:1")).toBeNull();});
});
