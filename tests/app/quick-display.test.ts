import { describe, expect, it } from "vitest";
import { changeText, lastCounterChange } from "../../src/app/quick/display";
import type { CounterEvent, CounterState } from "../../src/domain/counter/types";

const base: CounterState = {
  workItemId: "item", revision: 0,
  stitch: { current: 42, target: null }, row: { current: 10, target: null },
};

function event(id: string, before: CounterState, after: CounterState, action: CounterEvent["action"]): CounterEvent {
  return { eventId: id, commandId: id, workItemId: "item", deviceId: "test", occurredAt: `2026-10-18T12:00:0${id}.000Z`, action, before, after };
}

describe("quick counter display", () => {
  const rowDone = { ...base, revision: 1, row: { ...base.row, current: 11 }, stitch: { ...base.stitch, current: 0 } };
  const undone = { ...base, revision: 2 };
  const events = [
    event("1", base, rowDone, { type: "completeRow", stitch: "reset" }),
    event("2", rowDone, undone, { type: "undo", eventId: "1" }),
    event("3", undone, { ...undone, revision: 3, row: { ...undone.row, target: 20 } }, { type: "setTarget", counter: "row", value: 20 }),
  ];

  it("uses each tab's latest value change and skips target edits", () => {
    expect(lastCounterChange(events, "stitch")?.eventId).toBe("2");
    expect(lastCounterChange(events, "row")?.eventId).toBe("2");
    expect(lastCounterChange(events, "stitch")?.occurredAt).toBe("2026-10-18T12:00:02.000Z");
    expect(changeText(events[0], "stitch")).toBe("42 → 0 (-42)");
    expect(changeText(events[1], "row")).toBe("11 → 10 (-1)");
  });

  it("does not show the other counter's change as this tab's latest change", () => {
    const rowOnly = event("4", undone, { ...undone, revision: 3, row: { ...undone.row, current: 11 } }, { type: "change", counter: "row", delta: 1 });
    expect(lastCounterChange([...events, rowOnly], "stitch")?.eventId).toBe("2");
    expect(lastCounterChange([...events, rowOnly], "row")?.eventId).toBe("4");
    expect(changeText(rowOnly, "row")).toBe("10 → 11 (+1)");
    expect(lastCounterChange([], "stitch")).toBeNull();
  });
});
