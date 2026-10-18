import { isNonNegativeInteger, isValidCommandEnvelope, isValidCounterState } from "./invariants";
import type { CounterCommand, CounterCommandResult, CounterEvent, CounterState } from "./types";

export type ApplyResult = CounterCommandResult & { event?: CounterEvent };

export function initialCounterState(workItemId: string): CounterState {
  return { workItemId, revision: 0, stitch: { current: 0, target: null }, row: { current: 0, target: null } };
}

/** Undo is a stack over accepted changes; undo events remain in the journal. */
export function lastUndoableEvent(events: readonly CounterEvent[]): CounterEvent | null {
  const undone = new Set<string>();
  for (const event of events) if (event.action.type === "undo") undone.add(event.action.eventId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.action.type !== "undo" && !undone.has(event.eventId)) return event;
  }
  return null;
}

export function lastCountOccurredAt(events: readonly CounterEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.action.type === "change" || event.action.type === "completeRow") return event.occurredAt;
  }
  return null;
}

/** Pure rule set shared by local quick mode and the future project command path. */
export function applyCounterCommand(
  state: CounterState,
  events: readonly CounterEvent[],
  command: CounterCommand,
): ApplyResult {
  const duplicate = events.find((event) => event.commandId === command.commandId);
  if (duplicate) return { status: "duplicate", state, eventId: duplicate.eventId };
  if (!isValidCounterState(state) || !isValidCommandEnvelope(command) || command.workItemId !== state.workItemId) {
    return { status: "rejected", reason: "유효하지 않은 카운터 명령입니다." };
  }
  if (command.expectedRevision !== state.revision) return { status: "conflict", current: state };

  const next: CounterState = {
    ...state,
    revision: state.revision + 1,
    stitch: { ...state.stitch },
    row: { ...state.row },
  };
  const action = command.action;
  if (action.type === "change") {
    const value = next[action.counter].current + action.delta;
    if (!isNonNegativeInteger(value)) return { status: "rejected", reason: "카운터는 0 미만으로 줄일 수 없습니다." };
    next[action.counter].current = value;
  } else if (action.type === "completeRow") {
    if (!isNonNegativeInteger(next.row.current + 1)) return { status: "rejected", reason: "단수를 더할 수 없습니다." };
    next.row.current += 1;
    if (action.stitch === "reset") next.stitch.current = 0;
  } else if (action.type === "setValue") {
    if (!isNonNegativeInteger(action.value)) return { status: "rejected", reason: "0 이상의 정수를 입력해 주세요." };
    next[action.counter].current = action.value;
  } else if (action.type === "setTarget") {
    if (action.value !== null && (!isNonNegativeInteger(action.value) || action.value === 0)) {
      return { status: "rejected", reason: "목표는 1 이상의 정수이거나 비어 있어야 합니다." };
    }
    next[action.counter].target = action.value;
  } else {
    const last = lastUndoableEvent(events);
    if (!last || last.eventId !== action.eventId) {
      return { status: "rejected", reason: "직전 변경만 실행 취소할 수 있습니다." };
    }
    next.stitch = { ...last.before.stitch };
    next.row = { ...last.before.row };
  }
  const event: CounterEvent = {
    eventId: command.commandId,
    commandId: command.commandId,
    workItemId: command.workItemId,
    occurredAt: command.occurredAt,
    deviceId: command.deviceId,
    action,
    before: state,
    after: next,
  };
  return { status: "applied", state: next, eventId: event.eventId, event };
}
