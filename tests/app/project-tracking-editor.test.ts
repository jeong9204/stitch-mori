import "fake-indexeddb/auto";
import { IndexedDbTrackingOutbox } from "../../src/data/projects/tracking-outbox";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProjectProgress } from "../../src/components/project-progress";
import { parseProgressInput, partStatusLabels, progressLabel } from "../../src/components/project-tracking-display";
import { ProjectTrackingSession } from "../../src/components/project-tracking-session";
import type { ProjectDetail } from "../../src/data/projects/project-part-store";
import type { ProjectTrackingCommand, ProjectTrackingResult } from "../../src/domain/project/tracking";

const detail: ProjectDetail = { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "실제 이름", notes: null, status: "active", progressPercent: null, revision: 2, updatedAt: "2026-10-25T00:00:00Z", parts: [{ id: "aaaaaaaa-0000-4000-8000-000000000002", name: "기본 작업", status: "not_started", position: 0, isDefault: true, workItemId: "work", workItemRevision: 10, stitch: 42, row: 3, lastCountAt: "2026-10-25T00:00:00Z", lastEventCreatedAt: null }] };
async function setup() {
  const latest = structuredClone(detail);
  const apply = vi.fn<(c: ProjectTrackingCommand) => Promise<ProjectTrackingResult>>().mockResolvedValue({ status: "applied", projectId: detail.id, projectRevision: 3, change: { type: "setProgress", before: null, after: 50 } });
  const load = vi.fn().mockResolvedValue(latest), checkUser = vi.fn().mockResolvedValue(undefined), onSaved = vi.fn();
  const session = new ProjectTrackingSession({ userId: "user-a", projectId: detail.id, outbox: new IndexedDbTrackingOutbox(`ui-test-${crypto.randomUUID()}`), lock: async (_scope, fn) => fn(), apply, detail: load, checkUser, onSaved, requestId: () => crypto.randomUUID() });
  await session.restore();
  return { session, apply, load, checkUser, onSaved, latest };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

describe("manual project tracking UI", () => {
  it.each([null, 0, 1, 50, 99, 100])("renders actual progress %s without coercing unset to zero", value => {
    const markup = renderToStaticMarkup(createElement(ProjectProgress, { value }));
    expect(markup).toContain(progressLabel(value));
    if (value === null) { expect(markup).not.toContain("<progress"); expect(markup).not.toContain("0%"); }
    else { expect(markup).toContain(`value="${value}"`); expect(markup).toContain('max="100"'); }
  });
  it.each(["", "1.5", "-1", "101", "1e2", "abc"])("rejects invalid direct input %s", text => {
    expect(() => parseProgressInput(text, false)).toThrow(/정수/);
  });
  it("uses one draft for slider/direct input and sends only on explicit save", async () => {
    const { session, apply } = await setup();
    session.open({ type: "progress" }, detail);
    session.edit({ text: "1", unset: false }); session.edit({ text: "99", unset: false });
    expect(apply).not.toHaveBeenCalled();
    await session.save();
    expect(apply.mock.calls[0][0].action).toEqual({ type: "setProgress", value: 99 });
  });
  it("preserves invalid text, rejects save, and cancels back to server value", async () => {
    const { session, apply } = await setup(); session.open({ type: "progress" }, { ...detail, progressPercent: 50 });
    session.edit({ text: "50.5", unset: false }); await session.save();
    expect(apply).not.toHaveBeenCalled(); expect(session.snapshot().draft?.text).toBe("50.5");
    expect(session.snapshot().error).toMatch(/정수/);
    expect(await session.cancel()).toBe(true); session.open({ type: "progress" }, { ...detail, progressPercent: 50 });
    expect(session.snapshot().draft?.text).toBe("50");
  });
  it("saves explicit unset, and a fresh editor reflects a reload's server value", async () => {
    const { session, apply } = await setup(); session.open({ type: "progress" }, { ...detail, progressPercent: 100 });
    session.edit({ text: "", unset: true }); await session.save();
    expect(apply.mock.calls[0][0].action).toEqual({ type: "setProgress", value: null });
    session.open({ type: "progress" }, { ...detail, progressPercent: 0 }); expect(session.snapshot().draft?.unset).toBe(false);
    expect(session.snapshot().draft?.text).toBe("0");
  });
  it("retains exact command and draft after response loss, even on reopening another target", async () => {
    const { session, apply, onSaved } = await setup(); apply.mockRejectedValueOnce(new Error("network response lost"));
    session.open({ type: "progress" }, detail); session.edit({ text: "50", unset: false }); await session.save();
    const pending = session.snapshot().pending;
    expect(await session.cancel()).toBe(false); session.open({ type: "part", partId: detail.parts[0].id }, detail);
    expect(session.snapshot().draft?.target.type).toBe("progress");
    session.edit({ text: "99" }); expect(session.snapshot().draft?.text).toBe("50");
    await session.refreshLatest(); expect(session.snapshot().phase).toBe("failed"); expect(session.snapshot().pending).toBe(pending);
    await session.confirmReviewedSave(); expect(apply).toHaveBeenCalledTimes(1);
    apply.mockResolvedValueOnce({ status: "duplicate", projectId: "project", projectRevision: 3, change: { type: "setProgress", before: null, after: 50 } });
    await session.retry(); expect(apply.mock.calls[1][0]).toBe(pending); expect(onSaved).toHaveBeenCalledOnce();
    expect(session.snapshot().pending).toBeNull(); expect(session.snapshot().phase).toBe("saved");
  });
  it("distinguishes confirmed save with failed refresh and still retries the original receipt", async () => {
    const { session, apply, load } = await setup(); load.mockRejectedValueOnce(new Error("refresh failed"));
    session.open({ type: "progress" }, detail); await session.save();
    expect(session.snapshot().phase).toBe("refresh_failed"); const request = session.snapshot().pending;
    await session.retry(); expect(apply.mock.calls[1][0]).toBe(request); expect(session.snapshot().phase).toBe("saved");
  });
  it("blocks duplicate clicks while in flight", async () => {
    const { session, apply } = await setup(); const wait = deferred<ProjectTrackingResult>(); apply.mockReturnValueOnce(wait.promise);
    session.open({ type: "progress" }, detail); const first = session.save(); await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());
    await session.save(); await session.retry(); expect(apply).toHaveBeenCalledOnce();
    expect(await session.cancel()).toBe(false);
    wait.resolve({ status: "unchanged", projectId: "project", projectRevision: 2, change: { type: "setProgress", before: null, after: null } }); await first;
    expect(session.snapshot().phase).toBe("saved");
  });
  it("keeps a conflicted request until latest is reviewed and user explicitly creates a new command", async () => {
    const { session, apply, load } = await setup(); apply.mockResolvedValueOnce({ status: "conflict", latestRevision: 8 });
    load.mockResolvedValue({ ...detail, revision: 8, progressPercent: 99 });
    session.open({ type: "progress" }, detail); session.edit({ text: "50", unset: false }); await session.save();
    const old = session.snapshot().pending; await session.retry(); expect(apply).toHaveBeenCalledOnce();
    await session.refreshLatest(); expect(session.snapshot().phase).toBe("review");
    expect(session.snapshot().latest?.progressPercent).toBe(99); expect(session.snapshot().draft?.text).toBe("50");
    expect(session.snapshot().pending).toBe(old); expect(apply).toHaveBeenCalledOnce();
    await session.confirmReviewedSave(); const next = apply.mock.calls[1][0];
    expect(next.requestId).not.toBe(old?.requestId); expect(next.expectedRevision).toBe(8); expect(next.action).toEqual(old?.action);
    expect(session.snapshot().replacedRequestId).toBe(old?.requestId);
  });
  it("permits explicit cancel of a known rejected conflict without changing data", async () => {
    const { session, apply, onSaved } = await setup(); apply.mockResolvedValueOnce({ status: "conflict", latestRevision: 8 });
    session.open({ type: "progress" }, detail); await session.save(); expect(await session.cancel()).toBe(true);
    expect(apply).toHaveBeenCalledOnce(); expect(onSaved).toHaveBeenCalledWith(detail); expect(session.snapshot().pending).toBeNull();
  });
  it.each(Object.entries(partStatusLabels))("submits %s (%s) without changing counters or progress", async (status, label) => {
    const { session, apply } = await setup(); const original = structuredClone(detail);
    session.open({ type: "part", partId: detail.parts[0].id }, detail); session.edit({ partStatus: status as typeof detail.parts[number]["status"] }); await session.save();
    expect(label).toBeTruthy(); expect(apply.mock.calls[0][0].action).toEqual({ type: "setPartStatus", partId: detail.parts[0].id, status });
    expect(detail).toEqual(original);
  });
  it("uses reviewed server data on explicit conflict cancellation, without reporting a new save", async () => {
    const { session, apply, load, onSaved } = await setup(); apply.mockResolvedValueOnce({ status: "conflict", latestRevision: 8 });
    const latest = { ...detail, revision: 8, progressPercent: 99 }; load.mockResolvedValue(latest);
    session.open({ type: "progress" }, detail); session.edit({ text: "50", unset: false }); await session.save(); await session.refreshLatest();
    expect(await session.cancel()).toBe(true); expect(onSaved).toHaveBeenCalledWith(latest);
    expect(session.snapshot().phase).toBe("editing"); expect(apply).toHaveBeenCalledOnce();
  });
  it("does not resubmit a deleted part after conflict review", async () => {
    const { session, apply, load } = await setup(); apply.mockResolvedValueOnce({ status: "conflict", latestRevision: 8 }); load.mockResolvedValue({ ...detail, revision: 8, parts: [] });
    session.open({ type: "part", partId: detail.parts[0].id }, detail); await session.save(); await session.refreshLatest(); await session.confirmReviewedSave();
    expect(apply).toHaveBeenCalledOnce(); expect(session.snapshot().pending).not.toBeNull();
  });
  it("keeps the original pending request if latest lookup fails", async () => {
    const { session, apply, load } = await setup(); apply.mockResolvedValueOnce({ status: "conflict", latestRevision: 8 }); load.mockRejectedValue(new Error("offline"));
    session.open({ type: "progress" }, detail); await session.save(); const pending = session.snapshot().pending; await session.refreshLatest();
    expect(session.snapshot().pending).toBe(pending); expect(session.snapshot().phase).toBe("conflict");
  });
  it("ignores late results after account isolation/unmount and does not send after a canceled auth check", async () => {
    const { session, apply, checkUser, onSaved } = await setup(); const wait = deferred<void>(); checkUser.mockReturnValueOnce(wait.promise);
    session.open({ type: "progress" }, detail); const first = session.save(); session.deactivate(); wait.resolve(); await first;
    expect(apply).not.toHaveBeenCalled(); expect(onSaved).not.toHaveBeenCalled();
    session.activate(); apply.mockImplementationOnce(async () => { session.deactivate(); return { status: "unchanged", projectId: "project", projectRevision: 2, change: { type: "setProgress", before: null, after: null } }; });
    await session.retry(); expect(onSaved).not.toHaveBeenCalled();
  });
});
