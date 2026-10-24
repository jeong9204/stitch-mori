import { photoAdmin, photoContext, photoResponseError } from "@/lib/photos/server";
import { cleanupPhotos } from "@/data/photos/photo-service";
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await params;
    const { userId } = await photoContext(request, projectId, true);
    return Response.json({ cleanupPending: await cleanupPhotos(photoAdmin(), userId, projectId) });
  } catch (error) { return photoResponseError(error); }
}
