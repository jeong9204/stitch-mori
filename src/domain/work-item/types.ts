/** An identifier is a UUID both locally and on the server. */
export type WorkItemId = string;

export interface WorkItem {
  id: WorkItemId;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
