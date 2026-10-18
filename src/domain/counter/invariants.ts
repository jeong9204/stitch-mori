import type { CounterCommand, CounterState } from "./types";

export function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function isValidCounterState(state: CounterState): boolean {
  return (
    isNonNegativeInteger(state.revision) &&
    isNonNegativeInteger(state.stitch.current) &&
    isNonNegativeInteger(state.row.current) &&
    (state.stitch.target === null ||
      (Number.isSafeInteger(state.stitch.target) && state.stitch.target > 0)) &&
    (state.row.target === null ||
      (Number.isSafeInteger(state.row.target) && state.row.target > 0))
  );
}

export function isValidCommandEnvelope(command: CounterCommand): boolean {
  return (
    Boolean(command.commandId && command.workItemId && command.deviceId) &&
    isNonNegativeInteger(command.expectedRevision) &&
    !Number.isNaN(Date.parse(command.occurredAt))
  );
}
