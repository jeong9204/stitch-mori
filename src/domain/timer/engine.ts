import type { TimerCommand, TimerEvent, TimerResult, WorkSession } from "./types";

export function absoluteMilliseconds(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error("invalid_timestamp");
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > 253402300799999) throw new Error("invalid_timestamp");
  // Reject impossible calendar dates that Date.parse would normalize (e.g. February 30).
  const date = value.slice(0,10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw new Error("invalid_timestamp");
  return result;
}
export function sameTimerCommand(a: TimerCommand, b: TimerCommand): boolean {
  return a.commandId === b.commandId && a.sessionId === b.sessionId && a.workItemId === b.workItemId
    && a.expectedRevision === b.expectedRevision && (a.occurredAt === b.occurredAt || Date.parse(a.occurredAt) === Date.parse(b.occurredAt)) && a.deviceId === b.deviceId && a.action === b.action;
}
/** No ticks are stored. A backwards wall clock must be resolved explicitly, not silently counted. */
export function elapsedMilliseconds(state: WorkSession, at: string): number {
  const now = absoluteMilliseconds(at);
  if (state.status === "running" && now < absoluteMilliseconds(state.lastTransitionAt)) throw new Error("clock_before_last_transition");
  const total = state.accumulatedMs + (state.status === "running" ? now - absoluteMilliseconds(state.lastResumedAt!) : 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("elapsed_out_of_range");
  return total;
}
/** Anchor a server timestamp to a caller-supplied monotonic clock (e.g. performance.now).
 * Re-anchor after reload/server refresh. This never starts, pauses or resumes a session. */
export function createTimerClock(authoritativeAt: string, monotonicNow: () => number): () => string {
  const epoch = absoluteMilliseconds(authoritativeAt), anchor = monotonicNow();
  return () => {
    const delta = monotonicNow() - anchor;
    if (!Number.isFinite(delta) || delta < 0) throw new Error("invalid_monotonic_clock");
    return new Date(epoch + Math.floor(delta)).toISOString();
  };
}
export function applyTimerCommand(state: WorkSession | null, events: readonly TimerEvent[], command: TimerCommand,
  effectiveAt = command.occurredAt, userId: string | null = null): TimerResult {
  const reject = (reason: string): TimerResult => ({ status: "rejected", reason });
  if (![command.commandId, command.sessionId, command.workItemId, command.deviceId].every(s => typeof s === "string" && s.trim().length > 0)
    || command.deviceId.length > 120 || !Number.isSafeInteger(command.expectedRevision)
    || command.expectedRevision < 0 || command.expectedRevision >= Number.MAX_SAFE_INTEGER
    || !["start","pause","resume","end"].includes(command.action)) return reject("invalid_command");
  try { absoluteMilliseconds(command.occurredAt); absoluteMilliseconds(effectiveAt); } catch { return reject("invalid_timestamp"); }
  const duplicate = events.find(e => e.eventId === command.commandId);
  if (duplicate) return sameTimerCommand(duplicate.command, command)
    ? { status: "duplicate", state: structuredClone(duplicate.after), eventId: duplicate.eventId } : reject("command_id_reused");
  if (state && (state.sessionId !== command.sessionId || state.workItemId !== command.workItemId || state.userId !== userId)) return reject("session_identity_mismatch");
  if ((state?.revision ?? 0) !== command.expectedRevision) return { status: "conflict", current: state ? structuredClone(state) : null };
  const at = new Date(absoluteMilliseconds(effectiveAt)).toISOString();
  if (command.action === "start") {
    if (state) return reject("session_already_exists");
    return { status: "applied", eventId: command.commandId, state: {
      sessionId: command.sessionId, workItemId: command.workItemId, userId, status: "running",
      startedAt: at, endedAt: null, accumulatedMs: 0, lastResumedAt: at, lastTransitionAt: at,
      revision: 1, createdAt: at, updatedAt: at,
    } };
  }
  if (!state) return reject("session_not_found");
  if (state.status === "ended") return reject("session_ended");
  if ((command.action === "pause" && state.status !== "running") || (command.action === "resume" && state.status !== "paused")) return reject("invalid_transition");
  if (absoluteMilliseconds(at) < absoluteMilliseconds(state.lastTransitionAt)) return reject("clock_before_last_transition");
  let accumulatedMs: number;
  try { accumulatedMs = elapsedMilliseconds(state, at); } catch (error) { return reject(error instanceof Error ? error.message : "invalid_timestamp"); }
  const status = command.action === "resume" ? "running" : command.action === "pause" ? "paused" : "ended";
  return { status: "applied", eventId: command.commandId, state: { ...state, status,
    accumulatedMs, lastResumedAt: status === "running" ? at : null, endedAt: status === "ended" ? at : null,
    lastTransitionAt: at, updatedAt: at, revision: state.revision + 1,
  } };
}
