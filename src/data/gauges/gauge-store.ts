import type { SupabaseClient } from "@supabase/supabase-js";

export type GaugeData = {
  kind: "pattern" | "sample"; name: string | null;
  stitches: number; rows: number; width: number; height: number; unit: "cm" | "inch";
  needle_size_mm: number | null; needle_label: string | null; yarn: string | null;
  technique: string | null; blocking: "before" | "after" | "unspecified";
  measured_on: string | null; notes: string | null;
};
export type Gauge = GaugeData & { id: string; created_at: string; updated_at: string };
export type GaugeCollection = { revision: number; items: Gauge[] };
export type GaugeCommand = { projectId: string; requestId: string; expectedRevision: number;
  action: { type: "save"; id: string; data: GaugeData } | { type: "delete"; id: string } };
export type GaugeResult = { status: "applied" | "duplicate"; revision: number; gaugeId: string }
  | { status: "conflict"; latestRevision: number };
export const blockingLabels = { before: "블로킹 전", after: "블로킹 후", unspecified: "블로킹 미지정" };
export function emptyGauge(kind: GaugeData["kind"]): GaugeData {
  return { kind, name: kind === "sample" ? "" : null, stitches: 0, rows: 0, width: 0, height: 0,
    unit: "cm", needle_size_mm: null, needle_label: null, yarn: null, technique: null,
    blocking: "unspecified", measured_on: null, notes: null };
}
function decimal(value: number, max: number) {
  return Number.isFinite(value) && value > 0 && value <= max && Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001;
}
export function validateGauge(data: GaugeData): string | null {
  if (!["pattern", "sample"].includes(data.kind)) return "게이지 종류를 확인해 주세요.";
  if (data.kind === "sample" && (!data.name?.trim() || data.name.trim().length > 120)) return "샘플 이름은 1~120자로 입력해 주세요.";
  if (![data.stitches, data.rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000000)) return "코수·단수는 1~1,000,000의 정수로 입력해 주세요.";
  if (![data.width, data.height].every(n => decimal(n, 10000))) return "폭·높이는 0보다 크고 10,000 이하인 수로, 소수 셋째 자리까지 입력해 주세요.";
  if (!["cm", "inch"].includes(data.unit)) return "측정 단위를 확인해 주세요.";
  if (data.needle_size_mm !== null && !decimal(data.needle_size_mm, 100)) return "바늘 크기는 0 초과 100mm 이하, 소수 셋째 자리까지 입력해 주세요.";
  if (!["before", "after", "unspecified"].includes(data.blocking)) return "블로킹 상태를 확인해 주세요.";
  for (const [value, max] of [[data.name,120],[data.needle_label,80],[data.yarn,200],[data.technique,200],[data.notes,5000]] as const) {
    if (value && value.trim().length > max) return `텍스트는 ${max}자 이하로 입력해 주세요.`;
  }
  if (data.measured_on && (!/^\d{4}-\d{2}-\d{2}$/.test(data.measured_on) || data.measured_on < "1900-01-01" || !Number.isFinite(Date.parse(data.measured_on)) || new Date(data.measured_on).toISOString().slice(0,10) !== data.measured_on)) return "올바른 측정일을 입력해 주세요.";
  if (data.kind === "pattern" && (data.name !== null || data.needle_size_mm !== null || data.needle_label !== null || data.yarn !== null || data.blocking !== "unspecified" || data.measured_on !== null)) return "도안 게이지의 샘플 전용 항목을 비워 주세요.";
  return null;
}
export function normalizeGauge(data: GaugeData): GaugeData {
  const clean = (s: string | null) => s?.trim() || null;
  return { ...data, name: clean(data.name), needle_label: clean(data.needle_label), yarn: clean(data.yarn), technique: clean(data.technique), notes: clean(data.notes) };
}
export class GaugeRejectedError extends Error {}
function fail(error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === "P0002") throw new GaugeRejectedError("프로젝트 또는 게이지를 찾을 수 없습니다. 삭제 상태와 로그인 계정을 확인해 주세요.");
  if (["23514", "23502", "22007", "22008", "22P02", "22023"].includes(error.code ?? "")) throw new GaugeRejectedError("입력값을 확인해 주세요. 수치 범위와 측정일이 올바르지 않습니다.");
  if (error.code === "23505") throw new GaugeRejectedError("도안 게이지가 이미 있습니다. 최신 목록을 확인해 주세요.");
  throw new Error(error.message);
}
export class GaugeStore {
  constructor(private readonly client: SupabaseClient) {}
  async list(projectId: string): Promise<GaugeCollection> {
    const { data, error } = await this.client.rpc("get_project_gauges", { p_project_id: projectId });
    fail(error);
    if (!data || !Number.isSafeInteger(data.revision) || !Array.isArray(data.items)) throw new Error("게이지 응답이 올바르지 않습니다.");
    return data;
  }
  async apply(command: GaugeCommand): Promise<GaugeResult> {
    if (command.action.type === "save") {
      const validation = validateGauge(command.action.data);
      if (validation) throw new Error(validation);
    }
    const { data, error } = await this.client.rpc("apply_project_gauge_command", {
      p_project_id: command.projectId, p_request_id: command.requestId,
      p_expected_revision: command.expectedRevision, p_action: command.action,
    });
    fail(error);
    if (!data || !["applied", "duplicate", "conflict"].includes(data.status)) throw new Error("게이지 저장 응답이 올바르지 않습니다.");
    return data;
  }
}
