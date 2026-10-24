import { photoAdmin, photoContext, photoResponseError, requestIdentity } from "@/lib/photos/server";
import { cleanupPhotos } from "@/data/photos/photo-service";
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { userId } = await photoContext(request, projectId, true);
    const { requestId } = requestIdentity(request);
    const admin = photoAdmin();
    const { error } = await admin.rpc("abandon_project_photo_change", { p_user_id: userId, p_project_id: projectId, p_request_id: requestId });
    if (error) throw error;
    return Response.json({ cleanupPending: await cleanupPhotos(admin, userId, projectId) });
  } catch (error) { return photoResponseError(error); }
}
