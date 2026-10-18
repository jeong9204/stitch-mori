import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidCounterState } from "../../domain/counter/invariants";
import type { CounterCommand, CounterState } from "../../domain/counter/types";
import type { RemoteCounterCommandResult, RemoteCounterStore } from "./types";

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("서버 카운터 응답 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

function state(value: unknown): CounterState {
  const candidate = object(value);
  if (typeof candidate.workItemId !== "string") throw new Error("서버 작업 ID가 올바르지 않습니다.");
  const stitch = object(candidate.stitch);
  const row = object(candidate.row);
  const parsed: CounterState = {
    workItemId: candidate.workItemId,
    revision: Number(candidate.revision),
    stitch: { current: Number(stitch.current), target: stitch.target === null ? null : Number(stitch.target) },
    row: { current: Number(row.current), target: row.target === null ? null : Number(row.target) },
  };
  if (!isValidCounterState(parsed)) throw new Error("서버 카운터 값이 올바르지 않습니다.");
  return parsed;
}

function revision(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("서버 revision이 올바르지 않습니다.");
  return parsed;
}

export class SupabaseCounterStore implements RemoteCounterStore {
  constructor(private readonly client: SupabaseClient) {}

  async createWorkItem(): Promise<CounterState> {
    const { data, error } = await this.client.rpc("create_counter_work_item");
    if (error) throw new Error(error.message);
    const response = object(data);
    if (response.status === "rejected") throw new Error(String(response.reason));
    if (response.status !== "created") throw new Error("작업 생성 응답이 올바르지 않습니다.");
    return state(response.state);
  }

  async getWorkItem(id: string): Promise<CounterState | null> {
    const { data, error } = await this.client
      .from("work_items")
      .select("id, revision, counters(counter_type, current_value, target_value)")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const record = object(data);
    if (!Array.isArray(record.counters)) throw new Error("서버 카운터 행이 올바르지 않습니다.");
    const stitch = record.counters.find((counter) => object(counter).counter_type === "stitch");
    const row = record.counters.find((counter) => object(counter).counter_type === "row");
    if (!stitch || !row || record.counters.length !== 2) throw new Error("서버 카운터 행이 완전하지 않습니다.");
    const stitchRow = object(stitch);
    const rowRow = object(row);
    return state({
      workItemId: record.id,
      revision: record.revision,
      stitch: { current: stitchRow.current_value, target: stitchRow.target_value },
      row: { current: rowRow.current_value, target: rowRow.target_value },
    });
  }

  async applyCommand(command: CounterCommand): Promise<RemoteCounterCommandResult> {
    const { data, error } = await this.client.rpc("apply_counter_command", {
      p_command_id: command.commandId,
      p_work_item_id: command.workItemId,
      p_expected_revision: command.expectedRevision,
      p_occurred_at: command.occurredAt,
      p_device_id: command.deviceId,
      p_action: command.action,
    });
    if (error) throw new Error(error.message);
    const response = object(data);
    if (response.status === "rejected") return { status: "rejected", reason: String(response.reason) };
    if (response.status === "conflict") {
      return { status: "conflict", current: state(response.current), latestRevision: revision(response.latestRevision) };
    }
    if (response.status === "applied" || response.status === "duplicate") {
      if (typeof response.eventId !== "string") throw new Error("서버 이벤트 ID가 올바르지 않습니다.");
      return {
        status: response.status,
        state: state(response.state),
        eventId: response.eventId,
        revision: revision(response.revision),
        latestRevision: revision(response.latestRevision),
      };
    }
    throw new Error("카운터 명령 응답이 올바르지 않습니다.");
  }
}
