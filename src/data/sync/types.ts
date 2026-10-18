export type SyncStatus =
  | "local_only"
  | "saving_locally"
  | "local_saved"
  | "syncing"
  | "synced"
  | "conflict"
  | "local_error"
  | "remote_error";
