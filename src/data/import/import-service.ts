import type { IndexedDbCounterStore } from "@/data/local/indexeddb-counter-store";
import type { ImportedWorkItem, LocalImportSnapshot } from "./types";

export interface CounterImportRemote {
  importSnapshot(snapshot: LocalImportSnapshot): Promise<ImportedWorkItem>;
}

/** Local snapshot survives any remote or acknowledgment failure. */
export class CounterImportService {
  constructor(private readonly local: IndexedDbCounterStore, private readonly remote: CounterImportRemote) {}

  async import(localWorkItemId: string, userId: string): Promise<ImportedWorkItem> {
    const record = await this.local.getQuickIfExists();
    if (!record || record.localWorkItemId !== localWorkItemId) throw new Error("로컬 기록을 찾을 수 없습니다.");
    if (record.importedByUserId && record.importedByUserId !== userId) {
      throw new Error("이 로컬 기록은 다른 계정에 연결되어 있습니다.");
    }
    const snapshot = await this.local.beginImport(localWorkItemId);
    try {
      const result = await this.remote.importSnapshot(snapshot);
      if (result.importId !== snapshot.importId || result.localWorkItemId !== snapshot.localWorkItemId
        || result.importedRevision !== snapshot.state.revision) {
        throw new Error("서버 가져오기 응답이 로컬 기록과 일치하지 않습니다.");
      }
      await this.local.finishImport(snapshot, userId, result.serverWorkItemId);
      return result;
    } catch (error) {
      // The frozen snapshot remains. A retry sends the same import ID and exact payload.
      try { await this.local.releaseImport(localWorkItemId); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
}
