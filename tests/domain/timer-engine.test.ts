import { describe, expect, it } from "vitest";
import { absoluteMilliseconds, applyTimerCommand, createTimerClock, elapsedMilliseconds } from "../../src/domain/timer/engine";
import type { TimerCommand, TimerEvent, WorkSession } from "../../src/domain/timer/types";
function cmd(action: TimerCommand["action"], revision: number, at: string): TimerCommand {
  return { commandId: crypto.randomUUID(), sessionId: "session", workItemId: "work", deviceId: "device", occurredAt: at, expectedRevision: revision, action };
}
const t = (time: string) => `2026-10-20T${time}:00.000Z`;
function apply(state: WorkSession | null, command: TimerCommand): WorkSession {
  const result = applyTimerCommand(state,[],command);
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error("not applied");
  return result.state;
}
describe("timestamp-based timer engine", () => {
  it("counts only running segments: 14:00 → 14:30, 14:45 → 15:15 = 60 minutes", () => {
    let state = apply(null,cmd("start",0,t("14:00")));
    expect(elapsedMilliseconds(state,t("14:30"))).toBe(1800000);
    state = apply(state,cmd("pause",1,t("14:30")));
    expect(elapsedMilliseconds(state,t("14:45"))).toBe(1800000);
    state = apply(state,cmd("resume",2,t("14:45")));
    state = apply(state,cmd("end",3,t("15:15")));
    expect(state).toMatchObject({ status: "ended", accumulatedMs: 3600000, revision: 4, lastResumedAt: null });
    expect(elapsedMilliseconds(state,t("23:00"))).toBe(3600000);
  });
  it("ends a paused session without adding paused time", () => {
    const paused = apply(apply(null,cmd("start",0,t("14:00"))),cmd("pause",1,t("14:30")));
    expect(apply(paused,cmd("end",2,t("15:15"))).accumulatedMs).toBe(1800000);
  });
  it("restores a running session from serialized state without any ticks", () => {
    const state = apply(null,cmd("start",0,t("14:00")));
    const restored = JSON.parse(JSON.stringify(state));
    expect(elapsedMilliseconds(restored,t("18:00"))).toBe(4*3600000);
    expect(state.accumulatedMs).toBe(0);
  });
  it("compares absolute instants across timezones", () => {
    const state = apply(null,cmd("start",0,"2026-10-20T14:00:00+09:00"));
    expect(elapsedMilliseconds(state,"2026-10-20T06:00:00Z")).toBe(3600000);
  });
  it("anchors server time to a monotonic clock despite client wall-clock changes", () => {
    let monotonic=100;
    const clock=createTimerClock(t("14:00"),()=>monotonic);
    monotonic+=60000;
    expect(clock()).toBe(t("14:01"));
    monotonic=0;
    expect(clock).toThrow("invalid_monotonic_clock");
  });
  it("rejects invalid transitions, restart, and resuming an ended session", () => {
    const running = apply(null,cmd("start",0,t("14:00")));
    expect(applyTimerCommand(running,[],cmd("resume",1,t("14:01")))).toMatchObject({ status: "rejected", reason: "invalid_transition" });
    expect(applyTimerCommand(running,[],cmd("start",1,t("14:01")))).toMatchObject({ reason: "session_already_exists" });
    const ended=apply(running,cmd("end",1,t("14:01")));
    expect(applyTimerCommand(ended,[],cmd("resume",2,t("14:02")))).toMatchObject({ reason: "session_ended" });
    expect(applyTimerCommand(null,[],cmd("pause",0,t("14:00")))).toMatchObject({ reason: "session_not_found" });
  });
  it("detects stale revision without changing state", () => {
    const state=apply(null,cmd("start",0,t("14:00")));
    expect(applyTimerCommand(state,[],cmd("end",0,t("14:01")))).toEqual({ status: "conflict", current: state });
    expect(state.status).toBe("running");
  });
  it("returns the original event result on retry and rejects ID reuse with changed action", () => {
    const command=cmd("start",0,t("14:00")); const after=apply(null,command);
    const event: TimerEvent={ eventId: command.commandId, command, effectiveAt: command.occurredAt, before: null, after };
    const ended=apply(after,cmd("end",1,t("14:01")));
    expect(applyTimerCommand(ended,[event],command)).toMatchObject({ status: "duplicate", state: after });
    expect(applyTimerCommand(ended,[event],{ ...command, action: "end" })).toMatchObject({ reason: "command_id_reused" });
  });
  it("rejects clock rollback without losing recorded duration", () => {
    const state=apply(null,cmd("start",0,t("14:00")));
    expect(applyTimerCommand(state,[],cmd("pause",1,t("13:59")))).toMatchObject({ reason: "clock_before_last_transition" });
    expect(()=>elapsedMilliseconds(state,t("13:59"))).toThrow("clock_before_last_transition");
  });
  it("uses effective server time while retaining requested time separately in the command", () => {
    const result=applyTimerCommand(null,[],cmd("start",0,t("01:00")),t("14:00"),"user");
    expect(result).toMatchObject({ status: "applied", state: { startedAt: t("14:00"), userId: "user" } });
  });
  it("rejects malformed times, unsafe revisions, and identity changes", () => {
    for (const at of ["2026-10-20", "2026-02-30T12:00:00Z", "invalid"]) expect(()=>absoluteMilliseconds(at)).toThrow();
    expect(applyTimerCommand(null,[],{ ...cmd("start",0,t("14:00")), expectedRevision: -1 })).toMatchObject({ reason: "invalid_command" });
    const state=apply(null,cmd("start",0,t("14:00")));
    expect(applyTimerCommand(state,[],{ ...cmd("pause",1,t("14:01")), workItemId: "other" })).toMatchObject({ reason: "session_identity_mismatch" });
  });
});
