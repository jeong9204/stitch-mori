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
