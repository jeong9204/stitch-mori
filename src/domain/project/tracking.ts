/** Manual metadata only: neither progress nor part status drives counting or timers. */
export const partStatuses = ["not_started", "in_progress", "paused", "completed"] as const;
export type PartStatus = typeof partStatuses[number];
export type ProjectProgress = number | null;
export type ProjectTrackingAction =
  | { type: "setProgress"; value: ProjectProgress }
  | { type: "setPartStatus"; partId: string; status: PartStatus };
export type ProjectTrackingCommand = {
  projectId: string;
  /** Stable across retries; shares the existing project-part request ID namespace. */
  requestId: string;
  expectedRevision: number;
  action: ProjectTrackingAction;
};
export type ProjectTrackingChange =
  | { type: "setProgress"; before: ProjectProgress; after: ProjectProgress }
  | { type: "setPartStatus"; partId: string; before: PartStatus; after: PartStatus };
export type ProjectTrackingResult =
  | { status: "applied" | "unchanged" | "duplicate"; projectId: string; projectRevision: number; change: ProjectTrackingChange }
  | { status: "conflict"; latestRevision: number };

export function isProjectProgress(value: unknown): value is ProjectProgress {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100);
}
export function isPartStatus(value: unknown): value is PartStatus {
  return typeof value === "string" && partStatuses.includes(value as PartStatus);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateTrackingCommand(command: ProjectTrackingCommand): void {
  if (!uuid.test(command.projectId) || !uuid.test(command.requestId)
    || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new Error("프로젝트 명령 ID 또는 revision이 올바르지 않습니다.");
  }
  const action = command.action;
  if (action?.type === "setProgress" && Object.keys(action).length === 2 && isProjectProgress(action.value)) return;
  if (action?.type === "setPartStatus" && Object.keys(action).length === 3 && uuid.test(action.partId) && isPartStatus(action.status)) return;
  throw new Error("진행률은 미설정 또는 0~100 정수, 파트 상태는 지원하는 상태로 입력해 주세요.");
}
