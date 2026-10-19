import type { SupabaseClient } from "@supabase/supabase-js";

export type ProjectStatus = "active" | "paused" | "completed";
export type Project = {
  id: string;
  name: string;
  notes: string | null;
  status: ProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  defaultPartId: string;
  workItemId: string;
};
export type ProjectInput = { name: string; notes: string; status: ProjectStatus };
export const projectStatusLabels: Record<ProjectStatus, string> = {
  active: "진행 중", paused: "보류", completed: "완료",
};

export function validateProjectInput(input: Pick<ProjectInput, "name" | "notes">): string | null {
  if (input.name.trim().length < 1 || input.name.trim().length > 120) return "프로젝트명은 1~120자로 입력해 주세요.";
  if (input.notes.trim().length > 5000) return "메모는 5000자 이하로 입력해 주세요.";
  return null;
}

type ProjectRow = {
  id: string; name: string; notes: string | null; status: ProjectStatus; revision: number;
  created_at: string; updated_at: string; deleted_at: string | null;
  project_parts: { id: string; work_item_id: string; is_default: boolean }[];
};
function mapRow(row: ProjectRow): Project {
  const part = row.project_parts.find((candidate) => candidate.is_default);
  if (!part) throw new Error("기본 파트를 찾을 수 없습니다.");
  return { id: row.id, name: row.name, notes: row.notes, status: row.status, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
    defaultPartId: part.id, workItemId: part.work_item_id };
}
function mapResult(value: unknown): Project {
  if (!value || typeof value !== "object") throw new Error("프로젝트 응답이 올바르지 않습니다.");
  const result = value as Record<string, unknown>;
  if (typeof result.id !== "string" || typeof result.workItemId !== "string" || typeof result.defaultPartId !== "string") {
    throw new Error("프로젝트 응답이 올바르지 않습니다.");
  }
  return { id: result.id, name: result.name as string, notes: result.notes as string | null,
    status: result.status as ProjectStatus, revision: result.revision as number,
    createdAt: result.createdAt as string, updatedAt: result.updatedAt as string,
    deletedAt: result.deletedAt as string | null, defaultPartId: result.defaultPartId, workItemId: result.workItemId };
}
function throwError(error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === "40001") throw new Error("다른 화면에서 프로젝트가 변경됐습니다. 목록을 새로고침한 뒤 다시 수정해 주세요.");
  if (error.code === "P0002") throw new Error("프로젝트를 찾을 수 없습니다.");
  throw new Error(error.message);
}
export class ProjectStore {
  constructor(private readonly client: SupabaseClient) {}

  async list(): Promise<Project[]> {
    const { data, error } = await this.client.from("projects")
      .select("id,name,notes,status,revision,created_at,updated_at,deleted_at,project_parts(id,work_item_id,is_default)")
      .is("deleted_at", null).order("updated_at", { ascending: false });
    throwError(error);
    return ((data ?? []) as ProjectRow[]).map(mapRow);
  }

  async create(requestId: string, input: Pick<ProjectInput, "name" | "notes">): Promise<Project> {
    const validation = validateProjectInput(input);
    if (validation) throw new Error(validation);
    const { data, error } = await this.client.rpc("create_project", {
      p_request_id: requestId, p_name: input.name.trim(), p_notes: input.notes.trim() || null,
    });
    throwError(error);
    return mapResult(data);
  }

  async update(project: Project, input: ProjectInput): Promise<Project> {
    const validation = validateProjectInput(input);
    if (validation) throw new Error(validation);
    const { data, error } = await this.client.rpc("update_project", {
      p_project_id: project.id, p_expected_revision: project.revision,
      p_name: input.name.trim(), p_notes: input.notes.trim() || null, p_status: input.status,
    });
    throwError(error);
    return mapResult(data);
  }

  async delete(project: Project): Promise<Project> {
    const { data, error } = await this.client.rpc("delete_project", {
      p_project_id: project.id, p_expected_revision: project.revision,
    });
    throwError(error);
    return mapResult(data);
  }
}
