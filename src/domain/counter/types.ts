import type { WorkItemId } from "../work-item/types";

export type CounterType = "stitch" | "row";

export interface CounterValue {
  current: number;
  target: number | null;
}

export interface CounterState {
  workItemId: WorkItemId;
  revision: number;
  stitch: CounterValue;
  row: CounterValue;
}

export type CounterAction =
  | { type: "change"; counter: CounterType; delta: 1 | -1 }
  | { type: "completeRow"; stitch: "reset" | "keep" }
  | { type: "setValue"; counter: CounterType; value: number }
  | { type: "setTarget"; counter: CounterType; value: number | null }
  | { type: "undo"; eventId: string };

/** Stable across retries. The server checks expectedRevision before applying it. */
export interface CounterCommand {
  commandId: string;
  workItemId: WorkItemId;
  expectedRevision: number;
  occurredAt: string;
  deviceId: string;
  action: CounterAction;
}

export type CounterCommandResult =
  | { status: "applied" | "duplicate"; state: CounterState; eventId: string }
  | { status: "conflict"; current: CounterState }
  | { status: "rejected"; reason: string };
