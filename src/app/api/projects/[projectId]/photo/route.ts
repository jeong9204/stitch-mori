import { photoAdmin, photoContext, photoResponseError, requestIdentity, uuid } from "@/lib/photos/server";
import { preparePhoto, readPhotoBody } from "@/lib/photos/image";
import { changePhoto } from "@/data/photos/photo-service";
export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const { projectId } = await params;
    const { client, userId, project } = await photoContext(request, projectId);
    const { data: photo, error } = project.cover_photo_id ? await client.from("project_photos").select("id,width,height,byte_size,created_at").eq("id", project.cover_photo_id).single() : { data: null, error: null };
    if (error) throw error;
    const { count, error: cleanupError } = await photoAdmin().from("project_photos").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("project_id", projectId).not("retired_at", "is", null).is("cleaned_at", null);
    if (cleanupError) throw cleanupError;
    const requestId = new URL(request.url).searchParams.get("requestId");
    let receipt = null;
    if (requestId && uuid.test(requestId)) {
      const saved = await photoAdmin().from("project_photo_changes").select("status").eq("user_id", userId).eq("project_id", projectId).eq("request_id", requestId).maybeSingle();
      if (saved.error) throw saved.error;
      receipt = saved.data;
    }
    return Response.json({ photo, revision: project.revision, cleanupPending: Boolean(count), receipt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return photoResponseError(error); }
}
async function change(request: Request, { params }: Context, upload: boolean) {
  try {
    const { projectId } = await params;
    const { userId } = await photoContext(request, projectId, true);
    const identity = requestIdentity(request);
    const photo = upload ? await preparePhoto(await readPhotoBody(request)) : undefined;
    return Response.json(await changePhoto(photoAdmin(), { userId, projectId, ...identity }, photo), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return photoResponseError(error); }
}
export async function POST(request: Request, context: Context) { return change(request, context, true); }
export async function DELETE(request: Request, context: Context) { return change(request, context, false); }
