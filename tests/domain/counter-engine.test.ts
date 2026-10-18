import { describe, expect, it } from "vitest";
import { applyCounterCommand, initialCounterState, lastUndoableEvent } from "../../src/domain/counter/engine";
import type { CounterAction, CounterCommand, CounterEvent, CounterState } from "../../src/domain/counter/types";

function command(state: CounterState, action: CounterAction, commandId = crypto.randomUUID()): CounterCommand {
  return { commandId, workItemId: state.workItemId, expectedRevision: state.revision, occurredAt: new Date().toISOString(), deviceId: "device-1", action };
}

function apply(state: CounterState, events: CounterEvent[], action: CounterAction) {
  const result = applyCounterCommand(state, events, command(state, action));
  expect(result.status).toBe("applied");
  if (result.status !== "applied" || !result.event) throw new Error("Command was not applied");
  return { state: result.state, events: [...events, result.event] };
}

describe("shared counter engine", () => {
  it("increments and decrements without going below zero, and permits targets to be exceeded", () => {
    let { state, events } = apply(initialCounterState("work-1"), [], { type: "setTarget", counter: "stitch", value: 1 });
    ({ state, events } = apply(state, events, { type: "change", counter: "stitch", delta: 1 }));
    ({ state, events } = apply(state, events, { type: "change", counter: "stitch", delta: 1 }));
    expect(state.stitch).toEqual({ current: 2, target: 1 });
    ({ state, events } = apply(state, events, { type: "change", counter: "stitch", delta: -1 }));
    ({ state, events } = apply(state, events, { type: "change", counter: "stitch", delta: -1 }));
    expect(state.stitch.current).toBe(0);
    expect(applyCounterCommand(state, events, command(state, { type: "change", counter: "stitch", delta: -1 })).status).toBe("rejected");
  });

  it("changes stitch and row in one event for row completion; cancellation creates no command", () => {
    const prepared = apply(initialCounterState("work-1"), [], { type: "setValue", counter: "stitch", value: 7 });
    const reset = apply(prepared.state, prepared.events, { type: "completeRow", stitch: "reset" });
    expect(reset.state.stitch.current).toBe(0);
    expect(reset.state.row.current).toBe(1);
    expect(reset.events).toHaveLength(2);
    expect(reset.events[1].before.stitch.current).toBe(7);
    expect(reset.events[1].after.row.current).toBe(1);
    const undone = apply(reset.state, reset.events, { type: "undo", eventId: reset.events[1].eventId });
    expect(undone.state.stitch.current).toBe(7);
    expect(undone.state.row.current).toBe(0);
    expect(undone.events).toHaveLength(3);
    const keep = apply(prepared.state, prepared.events, { type: "completeRow", stitch: "keep" });
    expect(keep.state.stitch.current).toBe(7);
    expect(keep.state.row.current).toBe(1);
    expect(prepared.state.row.current).toBe(0);
  });

  it("edits values and targets, and appends an undo event without erasing history", () => {
    let { state, events } = apply(initialCounterState("work-1"), [], { type: "setValue", counter: "row", value: 5 });
    ({ state, events } = apply(state, events, { type: "setTarget", counter: "row", value: 3 }));
    expect(state.row).toEqual({ current: 5, target: 3 });
    const prior = events.at(-1)!;
    ({ state, events } = apply(state, events, { type: "undo", eventId: prior.eventId }));
    expect(state.row).toEqual({ current: 5, target: null });
    expect(events).toHaveLength(3);
    expect(events[2].action.type).toBe("undo");
    expect(applyCounterCommand(state, events, command(state, { type: "undo", eventId: prior.eventId })).status).toBe("rejected");
  });

  it("deduplicates by command ID before checking revision", () => {
    const state = initialCounterState("work-1");
    const first = command(state, { type: "change", counter: "stitch", delta: 1 }, "stable-command");
    const applied = applyCounterCommand(state, [], first);
    expect(applied.status).toBe("applied");
    if (applied.status !== "applied" || !applied.event) throw new Error("Command was not applied");
    const duplicate = applyCounterCommand(applied.state, [applied.event], first);
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.status === "duplicate" && duplicate.state.stitch.current).toBe(1);
    expect(applyCounterCommand(applied.state, [applied.event], command(state, { type: "change", counter: "stitch", delta: 1 })).status).toBe("conflict");
  });

  it("undoes successive changes and allows a new count immediately after an undo", () => {
    let { state, events } = apply(initialCounterState("work-1"), [], { type: "change", counter: "stitch", delta: 1 });
    ({ state, events } = apply(state, events, { type: "change", counter: "stitch", delta: 1 }));
    ({ state, events } = apply(state, events, { type: "undo", eventId: lastUndoableEvent(events)!.eventId }));
    expect(state.stitch.current).toBe(1);
    ({ state, events } = apply(state, events, { type: "undo", eventId: lastUndoableEvent(events)!.eventId }));
    expect(state.stitch.current).toBe(0);
    expect(lastUndoableEvent(events)).toBeNull();
    ({ state, events } = apply(state, events, { type: "change", counter: "stitch", delta: 1 }));
    expect(state.stitch.current).toBe(1);
    ({ state, events } = apply(state, events, { type: "undo", eventId: lastUndoableEvent(events)!.eventId }));
    expect(state.stitch.current).toBe(0);
    expect(events).toHaveLength(6);
    expect(events.filter((event) => event.action.type === "undo")).toHaveLength(3);
  });
});
