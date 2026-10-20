import type { IndexedDbCounterStore } from "../local/indexeddb-counter-store";
import { CounterImportService, type CounterImportRemote } from "../import/import-service";
import type { ServerCommandQueue } from "../remote/server-command-queue";
import type { ConversionJournal } from "./conversion-journal";
import type { CounterConversionRemote } from "./counter-conversion-store";
import { assertNoPendingCounterCommands } from "./pending-deletion-guard";

export class CounterConversionService {
  constructor(private readonly journal:ConversionJournal,private readonly remote:CounterConversionRemote,
    private readonly queue:Pick<ServerCommandQueue,"pending">,private readonly local:IndexedDbCounterStore,
    private readonly importer:CounterImportRemote,private readonly pendingLocal:()=>Promise<boolean>,
    private readonly sameUser:()=>Promise<boolean>=async()=>true) {}
  async execute(userId:string,source:string,name:string,workItemId:string|null,expectedRevision:number|null,localId?:string) {
    const ensureAccount=async()=>{if(!await this.sameUser())throw new Error("로그인 계정이 변경됐습니다. 원래 계정으로 다시 확인해 주세요.");};
    await ensureAccount();
    if(!name.trim()||name.trim().length>120)throw new Error("프로젝트명은 1~120자로 입력해 주세요.");
    if(localId){
      const record=await this.local.getQuickIfExists();
      if(!record||record.localWorkItemId!==localId)throw new Error("로컬 기록을 찾을 수 없습니다.");
      if(record.importedByUserId&&record.importedByUserId!==userId)throw new Error("다른 계정에 연결된 로컬 기록입니다.");
    }
    if(localId&&await this.pendingLocal())throw new Error("로컬 저장이 끝나지 않았습니다. 간편 카운터에서 저장 상태를 확인해 주세요.");
    if(workItemId)await assertNoPendingCounterCommands(this.queue,userId,[workItemId]);
    let intent=await this.journal.begin(userId,source,name.trim(),workItemId,expectedRevision);
    if(intent.name!==name.trim())throw new Error("진행 중인 전환의 이름은 변경할 수 없습니다. 최신 상태 확인 후 새 요청으로 시작해 주세요.");
    if(!intent.workItemId){
      const record=await this.local.getQuickIfExists();
      if(!record||record.localWorkItemId!==localId)throw new Error("로컬 기록을 찾을 수 없습니다.");
      if(record.importedByUserId&&record.importedByUserId!==userId)throw new Error("다른 계정에 연결된 로컬 기록입니다.");
      if(record.importStatus==="imported"&&record.serverWorkItemId){
        intent={...intent,workItemId:record.serverWorkItemId,expectedRevision:intent.expectedRevision ?? record.importedRevision ?? null};
      }else{
        const receipt=await new CounterImportService(this.local,{ importSnapshot: async(snapshot)=>{
          await ensureAccount();const receipt=await this.importer.importSnapshot(snapshot);await ensureAccount();return receipt;
        }}).import(record.localWorkItemId,userId);
        intent={...intent,workItemId:receipt.serverWorkItemId,expectedRevision:intent.expectedRevision ?? receipt.importedRevision};
      }
      await this.journal.save(intent);
    }
    if(!intent.workItemId||intent.expectedRevision===null)throw new Error("서버 작업의 revision을 확인해 주세요.");
    await assertNoPendingCounterCommands(this.queue,userId,[intent.workItemId]);
    await ensureAccount();
    const result=await this.remote.convert(intent.workItemId,intent.requestId,intent.expectedRevision,intent.name);
    await ensureAccount();
    if(result.status!=="conflict")await this.journal.save({...intent,projectId:result.projectId});
    return result;
  }
}
