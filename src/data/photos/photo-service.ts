import type { SupabaseClient } from "@supabase/supabase-js";
import { hashPhoto, PhotoError } from "../../lib/photos/image";

export const PHOTO_BUCKET = "project-photos";
type Identity = { userId: string; projectId: string; requestId: string; expectedRevision: number };
export type PreparedPhoto = { data: Buffer; width: number; height: number; byteSize: number; sourceHash: string; contentHash: string };
async function rpc(client: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    if (error.code === "40001") throw new PhotoError("프로젝트가 다른 곳에서 변경됐습니다. 최신 내용을 확인한 뒤 새 요청으로 진행해 주세요.", 409, "revision_conflict");
    if (error.code === "P0002") throw new PhotoError("프로젝트나 사진 요청을 찾을 수 없습니다.", 404);
    if (error.code === "22023") throw new PhotoError("이 요청은 다시 사용할 수 없습니다. 최신 상태를 확인해 주세요.", 409, "request_conflict");
    throw new PhotoError("사진 저장 결과를 확인하지 못했습니다. 같은 요청으로 재시도해 주세요.", 503, "unconfirmed");
  }
  return data;
}
export async function cleanupPhotos(client: SupabaseClient, userId: string, projectId: string) {
  try {
    const candidates: { id: string; path: string }[] = await rpc(client, "project_photo_cleanup_candidates", { p_user_id: userId, p_project_id: projectId });
    let failed = false;
    for (const photo of candidates) {
      const { error } = await client.storage.from(PHOTO_BUCKET).remove([photo.path]);
      if (error) { failed = true; continue; }
      await rpc(client, "confirm_project_photo_cleanup", { p_user_id: userId, p_project_id: projectId, p_photo_id: photo.id });
    }
    return failed;
  } catch { return true; }
}
export async function changePhoto(client: SupabaseClient, identity: Identity, photo?: PreparedPhoto) {
  const args = { p_user_id: identity.userId, p_project_id: identity.projectId, p_request_id: identity.requestId };
  let result = await rpc(client, "begin_project_photo_change", { ...args, p_expected_revision: identity.expectedRevision, p_action: photo ? "upload" : "delete", p_source_hash: photo?.sourceHash ?? null, p_content_hash: photo?.contentHash ?? null });
  if (result.status !== "committed") {
    if (photo) {
      const { error } = await client.storage.from(PHOTO_BUCKET).upload(result.path, photo.data, { contentType: "image/webp", upsert: false, cacheControl: "0" });
      if (error) {
        // A lost response or a concurrent retry may have already uploaded this immutable object.
        const existing = await client.storage.from(PHOTO_BUCKET).download(result.path);
        if (existing.error || !existing.data || hashPhoto(new Uint8Array(await existing.data.arrayBuffer())) !== photo.contentHash) throw new PhotoError("사진 업로드를 확인하지 못했습니다. 기존 사진을 유지하며 재시도할 수 있습니다.", 503, "upload_unconfirmed");
      }
    }
    try {
      result = await rpc(client, "commit_project_photo_change", { ...args, p_width: photo?.width ?? null, p_height: photo?.height ?? null, p_byte_size: photo?.byteSize ?? null });
    } catch (error) {
      if (error instanceof PhotoError && error.code === "revision_conflict") {
        // The same project lock serializes commit and abandon. A committed receipt is never abandoned.
        await client.rpc("abandon_project_photo_change", args);
        await cleanupPhotos(client, identity.userId, identity.projectId);
      }
      throw error;
    }
  }
  const cleanupPending = await cleanupPhotos(client, identity.userId, identity.projectId);
  return { ...result, cleanupPending };
}
