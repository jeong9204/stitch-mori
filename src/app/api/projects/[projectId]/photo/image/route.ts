import { PHOTO_BUCKET, photoContext, photoResponseError } from "@/lib/photos/server";
import { PhotoError } from "@/lib/photos/image";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { client, project } = await photoContext(request, projectId);
    if (!project.cover_photo_id || new URL(request.url).searchParams.get("photo") !== project.cover_photo_id) throw new PhotoError("대표 사진이 변경되었습니다. 다시 불러와 주세요.", 404);
    const { data: photo, error } = await client.from("project_photos").select("object_path").eq("id", project.cover_photo_id).single();
    if (error || !photo) throw new PhotoError("사진을 불러오지 못했습니다.", 503);
    const { data, error: downloadError } = await client.storage.from(PHOTO_BUCKET).download(photo.object_path);
    if (downloadError || !data) throw new PhotoError("사진을 불러오지 못했습니다. 다시 시도해 주세요.", 503);
    return new Response(await data.arrayBuffer(), { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { return photoResponseError(error); }
}
