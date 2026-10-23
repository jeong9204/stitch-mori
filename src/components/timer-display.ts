import type { TimerCommand, WorkSession } from "../domain/timer/types";

function clock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Reset only the display of an acknowledged end; never change the saved session. */
export function timerDisplay(state: WorkSession | null | undefined, pending: TimerCommand | null, elapsedMs: number) {
  const unconfirmedEnd = pending?.action === "end" && pending.sessionId === state?.sessionId;
  const ended = state?.status === "ended" && !unconfirmedEnd;
  return {
    time: clock(ended ? 0 : elapsedMs),
    lastSessionTime: ended ? clock(state.accumulatedMs) : null,
  };
}
