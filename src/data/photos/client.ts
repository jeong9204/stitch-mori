export type PhotoMetadata = { photo: { id: string; width: number; height: number; byte_size: number; created_at: string } | null; revision: number; cleanupPending: boolean; receipt?: { status: string } | null };
export type PhotoRequest = { requestId: string; expectedRevision: number; action: "upload" | "delete"; fileName?: string };
export function photoJournalKey(userId: string, projectId: string) { return `stitchmori:photo:${userId}:${projectId}`; }
export async function photoFetch(url: string, init?: RequestInit) {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(45_000), cache: "no-store" }); }
  catch { throw Object.assign(new Error("연결이 끊겼거나 응답 시간이 초과됐습니다. 저장 결과는 미확정이므로 같은 요청으로 재시도해 주세요. 기존 사진은 유지됩니다."), { code: "network_unconfirmed" }); }
  let data;
  try { data = await response.json(); }
  catch { throw Object.assign(new Error("서버 저장 결과를 읽지 못했습니다. 같은 요청으로 재시도하거나 최신 상태를 확인해 주세요."), { code: "unconfirmed" }); }
  if (!response.ok) throw Object.assign(new Error(data.error ?? "사진 요청에 실패했습니다."), { code: data.code, status: response.status });
  return data;
}
