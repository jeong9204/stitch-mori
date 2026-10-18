import type { CounterCommand, CounterState } from "@/domain/counter/types";

export type LocalPersistenceStatus = "pending" | "saved" | "failed";
export type RemoteSyncStatus = "not_applicable" | "queued" | "synced" | "conflict";

export interface LocalCounterRecord {
  localWorkItemId: string;
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

/** Phase 1 implements this with IndexedDB transactions. */
export interface LocalCounterStore {
  getWorkItem(id: string): Promise<LocalCounterRecord | null>;
  saveWorkItem(record: LocalCounterRecord): Promise<void>;
  enqueue(command: PendingCounterCommand): Promise<void>;
  getPending(workItemId: string): Promise<PendingCounterCommand[]>;
  markSynced(commandId: string): Promise<void>;
}
