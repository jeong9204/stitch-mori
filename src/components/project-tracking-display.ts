import type { PartStatus, ProjectProgress } from "../domain/project/tracking";

export const partStatusLabels: Record<PartStatus, string> = {
  not_started: "시작 전", in_progress: "작업 중", paused: "보류", completed: "완료",
};
export function progressLabel(value: ProjectProgress): string {
  return value === null ? "진행률 미설정" : `진행률 ${value}%`;
}
/** Keep the editor's raw string until an explicit save; empty is not zero. */
export function parseProgressInput(text: string, unset: boolean): ProjectProgress {
  if (unset) return null;
  if (!/^\d+$/.test(text.trim())) throw new Error("진행률은 0~100 사이의 정수로 입력해 주세요.");
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("진행률은 0~100 사이의 정수로 입력해 주세요.");
  return value;
}
