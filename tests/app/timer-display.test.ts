import { describe, expect, it } from "vitest";
import { timerDisplay } from "../../src/components/timer-display";
import { applyTimerCommand, elapsedMilliseconds } from "../../src/domain/timer/engine";
import type { TimerCommand, WorkSession } from "../../src/domain/timer/types";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 14, minutes)).toISOString();
function command(action: TimerCommand["action"], revision: number, minutes: number, sessionId = "session"): TimerCommand {
  return { commandId: `${sessionId}-${revision}`, sessionId, workItemId: "work", expectedRevision: revision, occurredAt: at(minutes), deviceId: "test", action };
}
function apply(state: WorkSession | null, cmd: TimerCommand): WorkSession {
  const result = applyTimerCommand(state, [], cmd);
  if (result.status !== "applied") throw new Error("unexpected transition");
  return result.state;
}

describe("timer card presentation", () => {
  it("keeps paused time, resumes from it, resets an ended display, then starts a new session", () => {
    const running = apply(null, command("start", 0, 0));
    expect(timerDisplay(running, null, elapsedMilliseconds(running, at(5))).time).toBe("00:05:00");
    const paused = apply(running, command("pause", 1, 5));
    expect(timerDisplay(paused, null, elapsedMilliseconds(paused, at(20))).time).toBe("00:05:00");
    const resumed = apply(paused, command("resume", 2, 20));
    expect(timerDisplay(resumed, null, elapsedMilliseconds(resumed, at(25))).time).toBe("00:10:00");
    const ended = apply(resumed, command("end", 3, 25));
    expect(timerDisplay(ended, null, ended.accumulatedMs)).toEqual({ time: "00:00:00", lastSessionTime: "00:10:00" });
    expect(ended.accumulatedMs).toBe(600000);
    const next = apply(null, command("start", 0, 30, "next-session"));
    expect(timerDisplay(next, null, 0)).toEqual({ time: "00:00:00", lastSessionTime: null });
  });

  it("restores an ended session as zero without losing the saved time", () => {
    const ended = apply(apply(null, command("start", 0, 0)), command("end", 1, 65));
    const restored = JSON.parse(JSON.stringify(ended)) as WorkSession;
    expect(timerDisplay(restored, null, elapsedMilliseconds(restored, at(120)))).toEqual({ time: "00:00:00", lastSessionTime: "01:05:00" });
    expect(restored).toEqual(ended);
  });

  it("does not reset failed or pending end requests, including a lost acknowledgement", () => {
    const running = apply(null, command("start", 0, 0));
    const end = command("end", 1, 10);
    expect(timerDisplay(running, end, elapsedMilliseconds(running, at(12)))).toEqual({ time: "00:12:00", lastSessionTime: null });
    const paused = apply(running, command("pause", 1, 5));
    expect(timerDisplay(paused, command("end", 2, 10), paused.accumulatedMs).time).toBe("00:05:00");
    const ended = apply(running, end);
    expect(timerDisplay(ended, end, ended.accumulatedMs)).toEqual({ time: "00:10:00", lastSessionTime: null });
    expect(timerDisplay(ended, null, ended.accumulatedMs).time).toBe("00:00:00");
  });
});
