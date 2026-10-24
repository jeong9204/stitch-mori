import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_PHOTO_BYTES, hashPhoto, preparePhoto, readPhotoBody } from "../../src/lib/photos/image";
import { changePhoto, cleanupPhotos } from "../../src/data/photos/photo-service";
import { isSamePhotoOrigin } from "../../src/lib/photos/requests";
import { photoFetch, photoJournalKey } from "../../src/data/photos/client";

const identity = { userId: "user", projectId: "project", requestId: "request", expectedRevision: 0 };
async function fixture() { return preparePhoto(await sharp({ create: { width: 80, height: 40, channels: 3, background: "#b65f7d" } }).png().toBuffer()); }
function fake(photo: Awaited<ReturnType<typeof fixture>>, options: { uploadError?: boolean; existingMismatch?: boolean; commitError?: string; duplicate?: boolean; cleanupFailure?: boolean } = {}) {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    void args;
    if (name === "begin_project_photo_change") return { data: options.duplicate ? { status: "committed", photoId: "new", revision: 1, duplicate: true } : { status: "pending", path: "user/project/new.webp" }, error: null };
    if (name === "commit_project_photo_change") return options.commitError ? { data: null, error: { code: options.commitError } } : { data: { status: "committed", photoId: "new", revision: 1 }, error: null };
    if (name === "project_photo_cleanup_candidates") return { data: [{ id: "old", path: "user/project/old.webp" }], error: null };
    return { data: null, error: null };
  });
  const upload = vi.fn(async () => ({ error: options.uploadError ? new Error("lost upload response") : null }));
  const download = vi.fn(async () => ({ data: new Blob([new Uint8Array(options.existingMismatch ? Buffer.from("different") : photo.data)]), error: null }));
  const remove = vi.fn(async () => ({ error: options.cleanupFailure ? new Error("offline") : null }));
  const client = { rpc, storage: { from: () => ({ upload, download, remove }) } } as unknown as SupabaseClient;
  return { client, rpc, upload, download, remove };
}

describe("project cover validation", () => {
  it.each(["jpeg", "png", "webp"] as const)("decodes and normalizes %s without metadata", async (format) => {
    const input = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "pink" } }).withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const output = await preparePhoto(input);
    const metadata = await sharp(output.data).metadata();
    expect(output.width).toBeLessThanOrEqual(1600); expect(output.height).toBeLessThanOrEqual(1600);
    expect(metadata.format).toBe("webp"); expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined(); expect(metadata.orientation).toBeUndefined();
    if (format === "jpeg") expect(output.height).toBeGreaterThan(output.width);
    expect(output.sourceHash).toBe(hashPhoto(input)); expect(output.contentHash).toBe(hashPhoto(output.data));
  });
  it("rejects non-images disguised as JPEG, SVG and broken images", async () => {
    for (const data of [Buffer.from("not jpeg"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 20])]) await expect(preparePhoto(data)).rejects.toThrow("이미지를 읽을 수 없습니다");
  });
  it("rejects oversized and empty bodies", async () => {
    await expect(preparePhoto(Buffer.alloc(MAX_PHOTO_BYTES + 1))).rejects.toThrow("10MB");
    await expect(preparePhoto(Buffer.alloc(0))).rejects.toThrow();
    await expect(readPhotoBody(new Request("http://localhost", { method: "POST", body: "x", headers: { "content-length": String(MAX_PHOTO_BYTES + 1) } }))).rejects.toThrow("10MB");
  });
  it("limits streamed bytes even when content-length is missing", async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_PHOTO_BYTES)); c.enqueue(new Uint8Array(1)); c.close(); } });
    await expect(readPhotoBody(new Request("http://localhost", { method: "POST", body, duplex: "half" } as RequestInit))).rejects.toThrow("10MB");
  });
  it("reads valid body bytes intact", async () => { expect(await readPhotoBody(new Request("http://localhost", { method: "POST", body: "photo" }))).toEqual(Buffer.from("photo")); });
});

describe("project cover transaction orchestration", () => {
  it("uploads before DB confirmation, then removes only retired candidates", async () => {
    const photo = await fixture(); const f = fake(photo);
    expect(await changePhoto(f.client, identity, photo)).toMatchObject({ status: "committed", cleanupPending: false });
    expect(f.upload.mock.invocationCallOrder[0]).toBeLessThan(f.rpc.mock.invocationCallOrder[1]);
    expect(f.rpc.mock.invocationCallOrder[1]).toBeLessThan(f.remove.mock.invocationCallOrder[0]);
    expect(f.upload).toHaveBeenCalledWith("user/project/new.webp", photo.data, expect.objectContaining({ upsert: false }));
    expect(f.remove).toHaveBeenCalledWith(["user/project/old.webp"]);
  });
  it("a committed retry returns its receipt without uploading again", async () => {
    const photo = await fixture(); const f = fake(photo, { duplicate: true });
    expect(await changePhoto(f.client, identity, photo)).toMatchObject({ duplicate: true, revision: 1 }); expect(f.upload).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls.some(([name]) => name === "commit_project_photo_change")).toBe(false);
  });
  it("checks immutable uploaded bytes after a lost upload response", async () => {
    const photo = await fixture(); const f = fake(photo, { uploadError: true });
    expect(await changePhoto(f.client, identity, photo)).toMatchObject({ status: "committed" }); expect(f.download).toHaveBeenCalledOnce();
  });
  it("does not connect a mismatched object or delete old image", async () => {
    const photo = await fixture(); const f = fake(photo, { uploadError: true, existingMismatch: true });
    await expect(changePhoto(f.client, identity, photo)).rejects.toMatchObject({ code: "upload_unconfirmed" });
    expect(f.remove).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledOnce();
  });
  it("keeps a transient DB failure retryable with the same identity and no cleanup", async () => {
    const photo = await fixture(); const f = fake(photo, { commitError: "08006" });
    await expect(changePhoto(f.client, identity, photo)).rejects.toMatchObject({ code: "unconfirmed" }); expect(f.remove).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_request_id: "request", p_expected_revision: 0 });
  });
  it("abandons conflicted staged candidates without overwriting a newer cover", async () => {
    const photo = await fixture(); const f = fake(photo, { commitError: "40001" });
    await expect(changePhoto(f.client, identity, photo)).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    expect(f.rpc).toHaveBeenCalledWith("abandon_project_photo_change", expect.objectContaining({ p_request_id: "request" }));
  });
  it("cleanup failure reports pending without turning committed save into failure", async () => {
    const photo = await fixture(); const f = fake(photo, { cleanupFailure: true });
    expect(await changePhoto(f.client, identity, photo)).toMatchObject({ status: "committed", cleanupPending: true });
    expect(f.rpc.mock.calls.some(([name]) => name === "confirm_project_photo_cleanup")).toBe(false);
  });
  it("delete commits the pointer change without uploading", async () => {
    const photo = await fixture(); const f = fake(photo);
    await changePhoto(f.client, identity); expect(f.upload).not.toHaveBeenCalled();
    expect(f.rpc.mock.calls[0][1]).toMatchObject({ p_action: "delete", p_source_hash: null, p_content_hash: null });
  });
  it("cleanup RPC failure stays visible as pending", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { code: "08006" } })) } as unknown as SupabaseClient;
    expect(await cleanupPhotos(client, "user", "project")).toBe(true);
  });
  it("request recovery keys isolate accounts and projects", () => {
    expect(photoJournalKey("a", "p")).not.toBe(photoJournalKey("b", "p")); expect(photoJournalKey("a", "p")).not.toBe(photoJournalKey("a", "q"));
  });
});

describe("photo mutation origin", () => {
  it("accepts the public Host when Next uses an internal request URL", () => {
    expect(isSamePhotoOrigin(new Request("http://localhost:3001/api", { headers: { host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001" } }))).toBe(true);
  });
  it.each([null, "null", "https://attacker.test", "http://127.0.0.1:3001/forged"])("rejects missing or foreign Origin %s", (origin) => {
    expect(isSamePhotoOrigin(new Request("http://localhost:3001/api", { headers: { host: "127.0.0.1:3001", ...(origin ? { origin } : {}) } }))).toBe(false);
  });
});

describe("photo browser transport", () => {
  it("keeps a network failure distinct from confirmation and sends the original request ID", async () => {
    const mocked = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("offline"));
    try {
      await expect(photoFetch("/photo", { method: "POST", headers: { "x-photo-request-id": "stable-id" } })).rejects.toMatchObject({ code: "network_unconfirmed" });
      expect(mocked).toHaveBeenCalledWith("/photo", expect.objectContaining({ headers: { "x-photo-request-id": "stable-id" }, cache: "no-store" }));
    } finally { mocked.mockRestore(); }
  });
  it("does not mistake a broken response body for a successful save", async () => {
    const mocked = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("gateway error", { status: 502 }));
    try { await expect(photoFetch("/photo")).rejects.toMatchObject({ code: "unconfirmed" }); } finally { mocked.mockRestore(); }
  });
  it("retains server revision conflicts as explicit errors", async () => {
    const mocked = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(Response.json({ error: "최신 상태 확인", code: "revision_conflict" }, { status: 409 }));
    try { await expect(photoFetch("/photo")).rejects.toMatchObject({ code: "revision_conflict", status: 409 }); } finally { mocked.mockRestore(); }
  });
});
