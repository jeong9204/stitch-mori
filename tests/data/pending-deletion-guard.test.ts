import { describe, expect, it, vi } from "vitest";
import { assertNoPendingCounterCommands } from "../../src/data/projects/pending-deletion-guard";

describe("project deletion guard", () => {
  it("checks every active part and blocks deletion when any work item has pending commands", async () => {
    const pending = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 1 }]);
    await expect(assertNoPendingCounterCommands({ pending }, "owner", ["default", "sleeve"]))
      .rejects.toThrow(/미확정/);
    expect(pending.mock.calls).toEqual([["owner", "default"], ["owner", "sleeve"]]);
  });
  it("allows deletion when the current device has no pending commands", async () => {
    const pending = vi.fn().mockResolvedValue([]);
    await expect(assertNoPendingCounterCommands({ pending }, "owner", ["default", "sleeve"]))
      .resolves.toBeUndefined();
  });
  it("does not silently allow deletion if IndexedDB cannot be read", async () => {
    const pending = vi.fn().mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(assertNoPendingCounterCommands({ pending }, "owner", ["default"]))
      .rejects.toThrow(/IndexedDB unavailable/);
  });
});
