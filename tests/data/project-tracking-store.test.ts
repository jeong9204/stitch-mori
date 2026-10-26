import { describe, expect, it, vi } from "vitest";
import { ProjectTrackingStore } from "../../src/data/projects/project-tracking-store";
import { isPartStatus, isProjectProgress, partStatuses, validateTrackingCommand, type ProjectTrackingCommand } from "../../src/domain/project/tracking";
import { ProjectStore } from "../../src/data/projects/project-store";
import { ProjectPartStore } from "../../src/data/projects/project-part-store";

function transport(rpc: (...args: unknown[]) => unknown) {
  return { rpc: (...args: unknown[]) => ({ retry: (enabled: boolean) => { expect(enabled).toBe(false); return rpc(...args); } }) };
}
const command: ProjectTrackingCommand = { projectId: "aaaaaaaa-0000-4000-8000-000000000001", requestId: "aaaaaaaa-0000-4000-8000-000000000002", expectedRevision: 2, action: { type: "setProgress", value: 50 } };
const result = { status: "applied", projectId: command.projectId, projectRevision: 3, change: { type: "setProgress", before: null, after: 50 } };

describe("manual project tracking", () => {
  it.each([null, 0, 50, 100])("accepts progress %s without deriving status", value => {
    expect(isProjectProgress(value)).toBe(true);
    expect(() => validateTrackingCommand({ ...command, action: { type: "setProgress", value } })).not.toThrow();
  });
  it.each([-1, 101, 50.5, NaN, Infinity, "50", undefined])("rejects invalid progress %s", value => {
    expect(isProjectProgress(value)).toBe(false);
    expect(() => validateTrackingCommand({ ...command, action: { type: "setProgress", value } } as ProjectTrackingCommand)).toThrow();
  });
  it.each(partStatuses)("accepts manual part status %s", status => {
    expect(isPartStatus(status)).toBe(true);
    expect(() => validateTrackingCommand({ ...command, action: { type: "setPartStatus", partId: command.projectId, status } })).not.toThrow();
  });
  it("rejects invalid status, IDs, revision and extra keys", () => {
    for (const invalid of [
      { ...command, expectedRevision: -1 }, { ...command, expectedRevision: 1.5 }, { ...command, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...command, requestId: "" }, { ...command, projectId: "not-uuid" },
      { ...command, action: { type: "setPartStatus", partId: command.projectId, status: "active" } },
      { ...command, action: { type: "setPartStatus", partId: "bad", status: "paused" } },
      { ...command, action: { type: "setProgress", value: 50, extra: true } },
    ]) expect(() => validateTrackingCommand(invalid as ProjectTrackingCommand)).toThrow();
  });
  it("retries the exact command after response loss without mutating it", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "network" } }).mockResolvedValueOnce({ data: { ...result, status: "duplicate" }, error: null });
    const store = new ProjectTrackingStore(transport(rpc) as never);
    const original = structuredClone(command);
    await expect(store.apply(command)).rejects.toThrow("network");
    expect((await store.apply(command)).status).toBe("duplicate");
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc).toHaveBeenCalledWith("apply_project_tracking_command", { p_project_id: command.projectId, p_request_id: command.requestId, p_expected_revision: 2, p_action: command.action });
    expect(command).toEqual(original);
  });
  it("returns conflict without rebasing or automatic retry", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "conflict", latestRevision: 4 }, error: null });
    expect(await new ProjectTrackingStore(transport(rpc) as never).apply(command)).toEqual({ status: "conflict", latestRevision: 4 });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(command.expectedRevision).toBe(2);
  });
  it("validates before networking and rejects malformed server results", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ...result, projectRevision: -1 }, error: null });
    const store = new ProjectTrackingStore(transport(rpc) as never);
    await expect(store.apply({ ...command, action: { type: "setProgress", value: 101 } })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
    await expect(store.apply(command)).rejects.toThrow(/응답/);
  });
  it("preserves null and zero on list, detail and existing edit result mappings", async () => {
    for (const value of [undefined, null, 0, 50, 100]) {
      const raw = { id: command.projectId, progress_percent: value, project_parts: [{ is_default: true, id: "part", work_item_id: "work" }] };
      const client = { from: () => ({ select: () => ({ is: () => ({ order: async () => ({ data: [raw], error: null }) }) }) }), rpc: vi.fn().mockResolvedValue({ data: { ...raw, progressPercent: value, defaultPartId: "part", workItemId: "work" }, error: null }) };
      const projects = new ProjectStore(client as never);
      const listed = (await projects.list())[0];
      expect(listed.progressPercent).toBe(value ?? null);
      expect((await projects.create(command.requestId, { name: "이름", notes: "" })).progressPercent).toBe(value ?? null);
      client.rpc.mockResolvedValue({ data: { id: command.projectId, progressPercent: value, parts: [{ id: "part" }, { id: "two", status: "completed" }] }, error: null });
      const detail = await new ProjectPartStore(client as never).detail(command.projectId);
      expect(detail?.progressPercent).toBe(value ?? null);
      expect(detail?.parts.map(p => p.status)).toEqual(["not_started", "completed"]);
    }
  });
  it("does not mask invalid read values as defaults", async () => {
    for (const data of [{ id: "p", progressPercent: 101, parts: [] }, { id: "p", parts: [{ status: "active" }] }]) {
      const rpc = vi.fn().mockResolvedValue({ data, error: null });
      await expect(new ProjectPartStore({ rpc } as never).detail("p")).rejects.toThrow(/응답/);
    }
  });
});
