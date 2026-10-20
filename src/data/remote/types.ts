import type { CounterCommand, CounterEvent, CounterState } from "@/domain/counter/types";

export type RemoteCounterCommandResult =
  | { status: "applied" | "duplicate"; state: CounterState; eventId: string; revision: number; latestRevision: number }
  | { status: "conflict"; current: CounterState; latestRevision: number }
  | { status: "rejected"; reason: string };

/** Authenticated server access. Guest quick mode never uses this interface. */
export interface RemoteCounterStore {
  createWorkItem(): Promise<CounterState>;
  getWorkItem(id: string): Promise<CounterState | null>;
  getEvents(id: string): Promise<CounterEvent[]>;
  getRecoveryRevision?(id: string): Promise<number | null>;
  applyCommand(command: CounterCommand): Promise<RemoteCounterCommandResult>;
}
