import { describe, expect, it, vi } from "vitest";
import { ProjectPartStore, lastWorkedPart, validatePartName, type ProjectDetail } from "../../src/data/projects/project-part-store";

const detail: ProjectDetail = { id: "project", name: "가디건", notes: null, status: "active", revision: 2,
  updatedAt: "2026-10-19T09:00:00Z", parts: [
    { id: "default", name: "기본 파트", position: 0, isDefault: true, workItemId: "work-a", workItemRevision: 0,
      stitch: 0, row: 0, lastCountAt: null, lastEventCreatedAt: null },
    { id: "sleeve", name: "소매", position: 1, isDefault: false, workItemId: "work-b", workItemRevision: 2,
      stitch: 3, row: 1, lastCountAt: "2026-10-19T10:00:00Z", lastEventCreatedAt: "2026-10-19T10:01:00Z" },
  ] };
describe("project part store", () => {
  it("rejects blank or oversized names", () => {
    expect(validatePartName("  ")).toMatch(/파트명/);
    expect(validatePartName("x".repeat(121))).toMatch(/파트명/);
    expect(validatePartName("왼쪽 소매")).toBeNull();
  });
  it("chooses the latest counted active part, then the default when no part has history", () => {
    expect(lastWorkedPart(detail)?.id).toBe("sleeve");
    expect(lastWorkedPart({ ...detail, parts: [detail.parts[0]] })?.id).toBe("default");
    expect(lastWorkedPart({ ...detail, parts: detail.parts.map(part => ({ ...part, lastEventCreatedAt: null })) })?.id).toBe("default");
  });
  it("passes stable command ID and revision to RPC", async () => {
    const rpc=vi.fn().mockResolvedValue({ data: { status: "applied", projectRevision: 3, partId: "new", workItemId: "work-new" }, error: null });
    const store=new ProjectPartStore({ rpc } as never);
    await store.apply({ projectId: "project", requestId: "request", expectedRevision: 2, action: { type: "create", name: " 소매 " } });
    expect(rpc).toHaveBeenCalledWith("apply_project_part_command", { p_project_id: "project", p_request_id: "request", p_expected_revision: 2, p_action: { type: "create", name: "소매" } });
  });
  it("surfaces a revision conflict without applying locally", async () => {
    const rpc=vi.fn().mockResolvedValue({ data: { status: "conflict", latestRevision: 4 }, error: null });
    const result=await new ProjectPartStore({ rpc } as never).apply({ projectId: "project", requestId: "request", expectedRevision: 2, action: { type: "move", partId: "sleeve", direction: "up" } });
    expect(result).toEqual({ status: "conflict", latestRevision: 4 });
  });
});
