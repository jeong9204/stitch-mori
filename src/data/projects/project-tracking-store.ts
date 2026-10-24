import type { SupabaseClient } from "@supabase/supabase-js";
import { isPartStatus, isProjectProgress, validateTrackingCommand, type ProjectTrackingCommand, type ProjectTrackingResult } from "../../domain/project/tracking";

function mapResult(data: unknown): ProjectTrackingResult {
  if (data && typeof data === "object") {
    const result = data as Record<string, unknown>;
    const revision = result.status === "conflict" ? result.latestRevision : result.projectRevision;
    if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) {
      if (result.status === "conflict") return result as ProjectTrackingResult;
      if (["applied", "unchanged", "duplicate"].includes(result.status as string) && typeof result.projectId === "string"
        && result.change && typeof result.change === "object") {
        const change = result.change as Record<string, unknown>;
        if ((change.type === "setProgress" && isProjectProgress(change.before) && isProjectProgress(change.after))
          || (change.type === "setPartStatus" && typeof change.partId === "string" && isPartStatus(change.before) && isPartStatus(change.after))) {
          return result as ProjectTrackingResult;
        }
      }
    }
  }
  throw new Error("프로젝트 진행 상태 응답이 올바르지 않습니다.");
}
/** Caller retains the exact command on failure; conflicts never trigger automatic rebasing. */
export class ProjectTrackingStore {
  constructor(private readonly client: SupabaseClient) {}
  async apply(command: ProjectTrackingCommand): Promise<ProjectTrackingResult> {
    validateTrackingCommand(command);
    const { data, error } = await this.client.rpc("apply_project_tracking_command", {
      p_project_id: command.projectId, p_request_id: command.requestId,
      p_expected_revision: command.expectedRevision, p_action: command.action,
    });
    if (error) {
      if (error.code === "P0002") throw new Error("프로젝트 또는 파트를 찾을 수 없습니다.");
      throw new Error(error.message);
    }
    return mapResult(data);
  }
}
