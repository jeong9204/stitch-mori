import type { CounterCommand, CounterCommandResult, CounterEvent, CounterState } from "@/domain/counter/types";

export type LocalPersistenceStatus = "pending" | "saved" | "failed";
export type RemoteSyncStatus = "not_applicable" | "queued" | "synced" | "conflict";

export interface LocalCounterRecord {
  localWorkItemId: string;
  deviceId: string;
  state: CounterState;
  importId: string;
  importStatus: "local" | "importing" | "imported" | "failed";
  serverWorkItemId: string | null;
  updatedAt: string;
}

export interface PendingCounterCommand {
  command: CounterCommand;
  localPersistence: LocalPersistenceStatus;
  remoteSync: RemoteSyncStatus;
}

/** A single local transaction must update the snapshot and append the event. */
export interface LocalCounterStore {
  getOrCreateQuick(): Promise<LocalCounterRecord>;
  getEvents(workItemId: string): Promise<CounterEvent[]>;
  applyCommand(command: CounterCommand): Promise<CounterCommandResult>;
}
