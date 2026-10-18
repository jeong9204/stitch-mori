import { describe, expect, it } from "vitest";
import { isNonNegativeInteger, isValidCommandEnvelope, isValidCounterState } from "../../src/domain/counter/invariants";

describe("counter data contract", () => {
  it("accepts only safe nonnegative integer counts", () => {
    expect(isNonNegativeInteger(0)).toBe(true);
    expect(isNonNegativeInteger(-1)).toBe(false);
    expect(isNonNegativeInteger(1.5)).toBe(false);
    expect(isNonNegativeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it("requires positive targets when set", () => {
    expect(isValidCounterState({
      workItemId: "work-1", revision: 0,
      stitch: { current: 0, target: null }, row: { current: 0, target: 12 },
    })).toBe(true);
    expect(isValidCounterState({
      workItemId: "work-1", revision: 0,
      stitch: { current: 0, target: 0 }, row: { current: 0, target: null },
    })).toBe(false);
  });

  it("requires a stable command envelope", () => {
    expect(isValidCommandEnvelope({
      commandId: "command-1", workItemId: "work-1", expectedRevision: 0,
      occurredAt: "2026-10-18T00:00:00.000Z", deviceId: "device-1",
      action: { type: "change", counter: "stitch", delta: 1 },
    })).toBe(true);
  });
});
