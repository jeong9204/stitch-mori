import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProjectStatus } from "./project-store";

export type ProjectPart = {
  id: string; name: string; position: number; isDefault: boolean; workItemId: string;
  workItemRevision: number; stitch: number; row: number;
  lastCountAt: string | null; lastEventCreatedAt: string | null;
};
export type ProjectDetail = {
  id: string; name: string; notes: string | null; status: ProjectStatus;
  revision: number; updatedAt: string; parts: ProjectPart[];
};
export type PartAction =
  | { type: "create"; name: string }
  | { type: "rename"; partId: string; name: string }
  | { type: "move"; partId: string; direction: "up" | "down" }
  | { type: "delete"; partId: string };
export type PartCommand = { projectId: string; requestId: string; expectedRevision: number; action: PartAction };
export type PartCommandResult = { status: "applied" | "duplicate" | "unchanged"; projectRevision: number; partId?: string; workItemId?: string }
  | { status: "conflict"; latestRevision: number };

export function validatePartName(name: string): string | null {
  return name.trim().length >= 1 && name.trim().length <= 120 ? null : "파트명은 1~120자로 입력해 주세요.";
}
export function lastWorkedPart(detail: ProjectDetail): ProjectPart | null {
  return detail.parts.filter((part) => part.lastEventCreatedAt)
    .sort((a, b) => b.lastEventCreatedAt!.localeCompare(a.lastEventCreatedAt!))[0]
    ?? detail.parts.find((part) => part.isDefault) ?? detail.parts[0] ?? null;
}
function mapDetail(value: unknown): ProjectDetail | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("프로젝트 상세 응답이 올바르지 않습니다.");
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== "string" || !Array.isArray(candidate.parts)) throw new Error("프로젝트 상세 응답이 올바르지 않습니다.");
  return candidate as ProjectDetail;
}
export class ProjectPartStore {
  constructor(private readonly client: SupabaseClient) {}
  async detail(projectId: string): Promise<ProjectDetail | null> {
    const { data, error } = await this.client.rpc("get_project_detail", { p_project_id: projectId });
    if (error) throw new Error(error.message);
    return mapDetail(data);
  }
  async apply(command: PartCommand): Promise<PartCommandResult> {
    const action = command.action.type === "create" || command.action.type === "rename"
      ? { ...command.action, name: command.action.name.trim() } : command.action;
    if ((action.type === "create" || action.type === "rename") && validatePartName(action.name)) {
      throw new Error(validatePartName(action.name)!);
    }
    const { data, error } = await this.client.rpc("apply_project_part_command", {
      p_project_id: command.projectId, p_request_id: command.requestId,
      p_expected_revision: command.expectedRevision, p_action: action,
    });
    if (error) {
      if (error.code === "P0002") throw new Error("프로젝트 또는 파트를 찾을 수 없습니다.");
      throw new Error(error.message);
    }
    if (!data || typeof data !== "object") throw new Error("파트 변경 응답이 올바르지 않습니다.");
    const response = data as PartCommandResult;
    if (!["applied", "duplicate", "unchanged", "conflict"].includes(response.status)) throw new Error("파트 변경 응답이 올바르지 않습니다.");
    return response;
  }
}
