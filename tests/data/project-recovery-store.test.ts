import { describe, expect, it, vi } from "vitest";
import { ProjectRecoveryStore } from "../../src/data/projects/project-recovery-store";

describe("project recovery store", () => {
  it("lists only the deleted project RPC result", async () => {
    const item = { id: "project", name: "가디건", revision: 4, deletedAt: "2026-10-19T10:00:00Z", status: "paused" };
    const rpc = vi.fn().mockResolvedValue({ data: [item], error: null });
    expect(await new ProjectRecoveryStore({ rpc } as never).listProjects()).toEqual([item]);
    expect(rpc).toHaveBeenCalledWith("get_deleted_projects");
  });
  it("reads the current parent revision with deleted part summaries", async () => {
    const response = { projectRevision: 7, items: [{ id: "part", name: "소매", workItemId: "work", stitch: 42, row: 10, eventCount: 2 }] };
    const rpc = vi.fn().mockResolvedValue({ data: response, error: null });
    expect(await new ProjectRecoveryStore({ rpc } as never).listParts("project")).toEqual(response);
    expect(rpc).toHaveBeenCalledWith("get_deleted_project_parts", { p_project_id: "project" });
  });
  it("reuses the same ID and revision after a lost project recovery response", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "network error" } })
      .mockResolvedValueOnce({ data: { status: "duplicate", projectRevision: 5 }, error: null });
    const store = new ProjectRecoveryStore({ rpc } as never);
    const request = { projectId: "project", requestId: "stable", expectedRevision: 4 };
    await expect(store.restore(request)).rejects.toThrow(/network/);
    expect((await store.restore(request)).status).toBe("duplicate");
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
  it("routes part restore with the exact existing part and project IDs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "restored", projectRevision: 8 }, error: null });
    await new ProjectRecoveryStore({ rpc } as never).restore({ projectId: "project", partId: "part", requestId: "stable", expectedRevision: 7 });
    expect(rpc).toHaveBeenCalledWith("restore_project_part", { p_project_id: "project", p_part_id: "part", p_request_id: "stable", p_expected_revision: 7 });
  });
  it("returns revision conflict for user review", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "conflict", latestRevision: 9 }, error: null });
    expect(await new ProjectRecoveryStore({ rpc } as never).restore({ projectId: "project", requestId: "stable", expectedRevision: 7 }))
      .toEqual({ status: "conflict", latestRevision: 9 });
  });
});
