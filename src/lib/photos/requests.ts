export const photoUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isSamePhotoOrigin(request: Request): boolean {
  // Next may normalize request.url to an internal hostname. Compare the public Host instead.
  const supplied = request.headers.get("origin");
  try {
    if (!supplied) return false;
    const origin = new URL(supplied);
    return origin.origin === supplied && origin.host === request.headers.get("host") && ["http:", "https:"].includes(origin.protocol);
  } catch { return false; }
}
