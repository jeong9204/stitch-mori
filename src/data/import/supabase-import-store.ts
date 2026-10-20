import type { SupabaseClient } from "@supabase/supabase-js";
import type { CounterImportRemote } from "./import-service";
import type { ImportedWorkItem, LocalImportSnapshot } from "./types";

export interface AccountWorkItemSummary {
  id: string;
  revision: number;
  createdAt: string;
  stitch: number;
  row: number;
}

export class SupabaseImportStore implements CounterImportRemote {
  constructor(private readonly client: SupabaseClient) {}

  async importSnapshot(snapshot: LocalImportSnapshot): Promise<ImportedWorkItem> {
    let response;
    try {
      response = await this.client.rpc("import_counter_snapshot", { p_payload: snapshot });
    } catch (cause) {
      if (cause instanceof TypeError) throw new Error("서버 연결에 실패했습니다. 연결 상태를 확인하고 다시 시도해 주세요.");
      throw cause;
    }
    const { data, error } = response;
    if (error) {
      if (/failed to fetch|fetch failed|networkerror/i.test(error.message)) {
        throw new Error("서버 연결에 실패했습니다. 연결 상태를 확인하고 다시 시도해 주세요.");
      }
      throw new Error(error.message);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("가져오기 응답 형식이 올바르지 않습니다.");
    if (data.status === "rejected") throw new Error(String(data.reason));
    if ((data.status !== "imported" && data.status !== "duplicate")
      || typeof data.importId !== "string" || typeof data.localWorkItemId !== "string"
      || typeof data.serverWorkItemId !== "string" || !Number.isSafeInteger(data.importedRevision)) {
      throw new Error("가져오기 응답 형식이 올바르지 않습니다.");
    }
    return {
      status: data.status, importId: data.importId, localWorkItemId: data.localWorkItemId,
      serverWorkItemId: data.serverWorkItemId, importedRevision: data.importedRevision,
    };
  }

  async listWorkItems(): Promise<AccountWorkItemSummary[]> {
    const { data, error } = await this.client.rpc("list_account_counters");
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("계정 카운터 목록 응답이 올바르지 않습니다.");
    return data.map((item) => ({ id: String(item.id), revision: Number(item.revision),
      createdAt: String(item.createdAt), stitch: Number(item.stitch), row: Number(item.row) }));
  }
}
