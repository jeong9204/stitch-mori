import type { CounterCommand, CounterCommandResult, CounterState } from "@/domain/counter/types";

/** Phase 1 implements this through one atomic server command endpoint. */
export interface RemoteCounterStore {
  getWorkItem(id: string): Promise<CounterState | null>;
  applyCommand(command: CounterCommand): Promise<CounterCommandResult>;
}
