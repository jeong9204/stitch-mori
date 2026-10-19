import { describe, expect, it, vi } from "vitest";
import { ProjectStore, validateProjectInput } from "../../src/data/projects/project-store";

const row = { id: "project-1", name: "카디건", notes: null, status: "active", revision: 0,
  created_at: "2026-10-19T00:00:00Z", updated_at: "2026-10-19T00:00:00Z", deleted_at: null,
  project_parts: [{ id: "part-1", work_item_id: "work-1", is_default: true }] };

describe("project store", () => {
  it("validates blank and oversized project fields", () => {
    expect(validateProjectInput({ name: "  ", notes: "" })).toMatch(/프로젝트명/);
    expect(validateProjectInput({ name: "좋은 이름", notes: "x".repeat(5001) })).toMatch(/메모/);
    expect(validateProjectInput({ name: "좋은 이름", notes: "" })).toBeNull();
  });
  it("maps only saved list rows and their default counter work item", async () => {
    const order = vi.fn().mockResolvedValue({ data: [row], error: null });
    const is = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ is });
    const from = vi.fn().mockReturnValue({ select });
    const projects = await new ProjectStore({ from } as never).list();
    expect(is).toHaveBeenCalledWith("deleted_at", null);
    expect(projects[0].workItemId).toBe("work-1");
    expect(projects[0].name).toBe("카디건");
  });
  it("reuses the caller's stable request ID on creation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { result: "created", id: "project-1", name: "카디건", notes: null,
      status: "active", revision: 0, createdAt: row.created_at, updatedAt: row.updated_at,
      deletedAt: null, defaultPartId: "part-1", workItemId: "work-1" }, error: null });
    const store = new ProjectStore({ rpc } as never);
    await store.create("request-1", { name: " 카디건 ", notes: "" });
    expect(rpc).toHaveBeenCalledWith("create_project", { p_request_id: "request-1", p_name: "카디건", p_notes: null });
  });
  it("sends revision with updates and reports collisions", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "conflict", code: "40001" } });
    const store = new ProjectStore({ rpc } as never);
    await expect(store.update({ id: "project-1", name: "카디건", notes: null, status: "active", revision: 2,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: null, defaultPartId: "part-1", workItemId: "work-1" },
      { name: "카디건", notes: "", status: "paused" })).rejects.toThrow(/변경됐습니다/);
    expect(rpc).toHaveBeenCalledWith("update_project", expect.objectContaining({ p_expected_revision: 2 }));
  });
});
