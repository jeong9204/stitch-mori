export type TimerAction = "start" | "pause" | "resume" | "end";
export type WorkSession = {
  sessionId: string; userId: string | null; workItemId: string;
  status: "running" | "paused" | "ended";
  startedAt: string; endedAt: string | null; accumulatedMs: number;
  lastResumedAt: string | null; lastTransitionAt: string;
  revision: number; createdAt: string; updatedAt: string;
};
/** Generate IDs once before submitting, and preserve the entire envelope on retry. */
export type TimerCommand = {
  commandId: string; sessionId: string; workItemId: string; expectedRevision: number;
  occurredAt: string; deviceId: string; action: TimerAction;
};
export type TimerEvent = {
  eventId: string; command: TimerCommand; effectiveAt: string;
  before: WorkSession | null; after: WorkSession;
};
export type TimerResult =
  | { status: "applied" | "duplicate"; state: WorkSession; eventId: string }
  | { status: "conflict"; current: WorkSession | null }
  | { status: "rejected"; reason: string };
/** Reserved for a later audited correction command; never overwrite measured session time. */
export type SessionTimeAdjustment = {
  adjustmentId: string; sessionId: string; commandId: string;
  previousAdjustedMs: number; adjustedMs: number; reason: string; createdAt: string;
};
