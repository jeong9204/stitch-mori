import type { CounterEvent, CounterState } from "@/domain/counter/types";

export type ImportStatus = "local" | "importing" | "imported" | "failed";

/** Keep the same importId for every retry; a server receipt will make it idempotent. */
export interface ImportReceipt {
  importId: string;
  localWorkItemId: string;
  serverWorkItemId: string;
  userId: string;
  acknowledgedAt: string;
}

export interface ImportCandidate {
  importId: string;
  localWorkItemId: string;
  status: ImportStatus;
  serverWorkItemId: string | null;
}

/** Immutable first saved snapshot. Retries send this exact payload, even after later local edits. */
export interface LocalImportSnapshot {
  importId: string;
  localWorkItemId: string;
  state: CounterState;
  events: CounterEvent[];
}

export interface ImportedWorkItem {
  importId: string;
  localWorkItemId: string;
  serverWorkItemId: string;
  importedRevision: number;
  status: "imported" | "duplicate";
}
