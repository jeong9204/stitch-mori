import sharp from "sharp";
import { createHash } from "node:crypto";

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export class PhotoError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = "invalid_photo") { super(message); }
}
export const hashPhoto = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export async function readPhotoBody(request: Request): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > MAX_PHOTO_BYTES) throw new PhotoError("사진은 10MB 이하여야 합니다.", 413);
  if (!request.body) throw new PhotoError("사진 파일을 선택해 주세요.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PHOTO_BYTES) { await reader.cancel(); throw new PhotoError("사진은 10MB 이하여야 합니다.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export async function preparePhoto(input: Buffer) {
  if (!input.length || input.length > MAX_PHOTO_BYTES) throw new PhotoError("비어 있거나 10MB를 초과한 파일입니다.", 413);
  try {
    const options = { limitInputPixels: 40_000_000, failOn: "warning" as const };
    const metadata = await sharp(input, options).metadata();
    if (!metadata.format || !["jpeg", "png", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw new Error("unsupported");
    const { data, info } = await sharp(input, options).autoOrient().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    if (data.length > MAX_PHOTO_BYTES) throw new Error("output_size");
    return { data, width: info.width, height: info.height, byteSize: data.length, sourceHash: hashPhoto(input), contentHash: hashPhoto(data) };
  } catch { throw new PhotoError("이미지를 읽을 수 없습니다. 손상되지 않은 JPEG·PNG·WebP 사진을 선택해 주세요."); }
}
