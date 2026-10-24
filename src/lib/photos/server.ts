import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { PhotoError } from "./image";

export const PHOTO_BUCKET = "project-photos";
export { photoUuid as uuid } from "./requests";
import { photoUuid as uuid, isSamePhotoOrigin } from "./requests";
export async function photoContext(request: Request, projectId: string, mutation = false) {
  if (!uuid.test(projectId)) throw new PhotoError("프로젝트를 찾을 수 없습니다.", 404);
  if (mutation && !isSamePhotoOrigin(request)) throw new PhotoError("요청 출처를 확인할 수 없습니다.", 403);
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new PhotoError("로그인 후 다시 시도해 주세요.", 401);
  const { data: project, error: projectError } = await client.from("projects").select("id,revision,cover_photo_id,deleted_at").eq("id", projectId).eq("user_id", user.id).is("deleted_at", null).maybeSingle();
  if (projectError) throw new PhotoError("프로젝트를 불러오지 못했습니다.", 503);
  if (!project) throw new PhotoError("프로젝트를 찾을 수 없습니다.", 404);
  return { client, userId: user.id, project };
}
export function photoAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new PhotoError("사진 서버 설정이 필요합니다. 관리자에게 문의해 주세요.", 503);
  return createSupabaseClient(getSupabaseEnv().url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) }) } });
}
export function requestIdentity(request: Request) {
  const requestId = request.headers.get("x-photo-request-id") ?? "";
  const expectedRevision = Number(request.headers.get("x-project-revision"));
  if (!uuid.test(requestId) || request.headers.get("x-project-revision") === null || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new PhotoError("사진 변경 요청 정보가 올바르지 않습니다.");
  return { requestId, expectedRevision };
}
export function photoResponseError(error: unknown) {
  const known = error instanceof PhotoError;
  return Response.json({ error: known ? error.message : "사진 처리에 실패했습니다. 기존 사진은 유지됩니다. 같은 요청으로 재시도해 주세요.", code: known ? error.code : "photo_unavailable" }, { status: known ? error.status : 503, headers: { "Cache-Control": "no-store" } });
}
