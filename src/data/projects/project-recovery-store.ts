import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectStatus } from "./project-store";

export type DeletedRecord = {
  id: string; name: string; deletedAt: string; revision?: number; status?: ProjectStatus;
  workItemId?: string; stitch?: number; row?: number; lastCountAt?: string | null; eventCount?: number;
};
export type RecoveryRequest = {
  projectId: string; partId?: string; requestId: string; expectedRevision: number;
};
export type RecoveryResult = { status: "restored" | "duplicate" | "unchanged"; projectRevision: number }
  | { status: "conflict"; latestRevision: number };
export class ProjectRecoveryStore {
  constructor(private readonly client: SupabaseClient) {}
  async listProjects(): Promise<DeletedRecord[]> {
    const { data, error } = await this.client.rpc("get_deleted_projects");
    if (error) throw new Error(error.message);
    if (!Array.isArray(data)) throw new Error("삭제된 프로젝트 응답이 올바르지 않습니다.");
    return data;
  }
  async listParts(projectId: string): Promise<{ projectRevision: number; items: DeletedRecord[] }> {
    const { data, error } = await this.client.rpc("get_deleted_project_parts", { p_project_id: projectId });
    if (error) throw new Error(error.code === "P0002" ? "프로젝트를 찾을 수 없습니다." : error.message);
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.projectRevision)) throw new Error("삭제된 파트 응답이 올바르지 않습니다.");
    return data;
  }
  async restore(request: RecoveryRequest): Promise<RecoveryResult> {
    const args = { p_project_id: request.projectId, p_request_id: request.requestId, p_expected_revision: request.expectedRevision };
    const { data, error } = request.partId
      ? await this.client.rpc("restore_project_part", { ...args, p_part_id: request.partId })
      : await this.client.rpc("restore_project", args);
    if (error) {
      if (error.code === "P0002") throw new Error("프로젝트 또는 파트를 찾을 수 없습니다.");
      if (error.code === "22023") throw new Error("복구할 항목의 상태를 다시 확인해 주세요. 프로젝트가 삭제됐다면 먼저 프로젝트를 복구해 주세요.");
      throw new Error(error.message);
    }
    if (!data || !["restored", "duplicate", "unchanged", "conflict"].includes(data.status)) throw new Error("복구 응답이 올바르지 않습니다.");
    return data;
  }
}
