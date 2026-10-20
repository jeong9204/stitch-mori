import { describe, expect, it, vi } from "vitest";
import { GaugeStore, GaugeRejectedError, emptyGauge, normalizeGauge, validateGauge, type GaugeData, type GaugeCommand } from "../../src/data/gauges/gauge-store";
const pattern: GaugeData = { ...emptyGauge("pattern"), stitches: 22, rows: 30, width: 10, height: 10 };
const sample: GaugeData = { ...pattern, kind: "sample", name: "스와치", needle_size_mm: 3.75, needle_label: "US 5", measured_on: "2026-10-20", blocking: "after", yarn: "울" };
const command: GaugeCommand = { projectId: "project", requestId: "stable-request", expectedRevision: 2, action: { type: "save", id: "gauge", data: sample } };
describe("gauge records", () => {
  it("accepts cm and inch without converting entered numbers", () => {
    expect(validateGauge(pattern)).toBeNull(); expect(validateGauge({ ...sample, unit: "inch", width: 4, height: 4 })).toBeNull();
  });
  it("accepts before/after/unspecified blocking and optional fields", () => {
    for (const blocking of ["before", "after", "unspecified"] as const) expect(validateGauge({ ...sample, blocking })).toBeNull();
    expect(validateGauge({ ...pattern, kind: "sample", name: "무명", measured_on: null })).toBeNull();
  });
  it("rejects invalid counts", () => {
    for (const n of [0,-1,1.5,1000001,Infinity,NaN]) expect(validateGauge({ ...pattern, stitches: n })).toMatch(/정수/);
  });
  it("rejects invalid dimensions and excessive precision", () => {
    for (const n of [0,-1,10001,.0001,NaN,Infinity]) expect(validateGauge({ ...pattern, width: n })).toMatch(/폭/);
    expect(validateGauge({ ...pattern, width: .001 })).toBeNull();
  });
  it("validates needle mm independently of the optional original notation", () => {
    expect(validateGauge({ ...sample, needle_size_mm: 0 })).toMatch(/바늘/);
    expect(validateGauge({ ...sample, needle_size_mm: null, needle_label: "US 5" })).toBeNull();
  });
  it("validates names, notes and calendar dates", () => {
    expect(validateGauge({ ...sample, name: " " })).toMatch(/이름/);
    expect(validateGauge({ ...sample, notes: "x".repeat(5001) })).toMatch(/5000/);
    expect(validateGauge({ ...sample, measured_on: "2026-02-30" })).toMatch(/측정일/);
    expect(validateGauge({ ...sample, measured_on: "1899-12-31" })).toMatch(/측정일/);
  });
  it("does not allow sample metadata on pattern records", () => {
    expect(validateGauge({ ...pattern, yarn: "실" })).toMatch(/전용/);
  });
  it("normalizes optional text only, preserving original measurement units", () => {
    expect(normalizeGauge({ ...sample, name: " 스와치 ", notes: " ", unit: "inch" })).toMatchObject({ name: "스와치", notes: null, unit: "inch", width: 10 });
  });
  it("retries the identical request ID, revision and payload", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "network" } }).mockResolvedValue({ data: { status: "duplicate", revision: 3, gaugeId: "gauge" }, error: null });
    const store = new GaugeStore({ rpc } as never);
    await expect(store.apply(command)).rejects.toThrow("network");
    expect(await store.apply(command)).toMatchObject({ status: "duplicate" });
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_request_id: "stable-request", p_expected_revision: 2, p_action: command.action });
  });
  it("returns conflicts without silently updating revision", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "conflict", latestRevision: 3 }, error: null });
    expect(await new GaugeStore({ rpc } as never).apply(command)).toEqual({ status: "conflict", latestRevision: 3 });
    expect(command.expectedRevision).toBe(2); expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("lists server order, and submits deletion as a command", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { revision: 2, items: [sample, pattern] }, error: null }).mockResolvedValue({ data: { status: "applied", revision: 3 }, error: null });
    const store = new GaugeStore({ rpc } as never);
    expect((await store.list("project")).items).toEqual([sample, pattern]);
    await store.apply({ ...command, action: { type: "delete", id: "gauge" } });
    expect(rpc.mock.calls[1][1].p_action).toEqual({ type: "delete", id: "gauge" });
  });
  it("rejects invalid data before RPC and distinguishes known server rejections", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "P0002", message: "missing" } });
    const store = new GaugeStore({ rpc } as never);
    await expect(store.apply({ ...command, action: { type: "save", id: "gauge", data: { ...sample, rows: -1 } } })).rejects.toThrow(/정수/);
    expect(rpc).not.toHaveBeenCalled();
    await expect(store.list("other")).rejects.toBeInstanceOf(GaugeRejectedError);
  });
});
