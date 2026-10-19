import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseCounterStore } from "../../src/data/remote/supabase-counter-store";
import type { CounterCommand } from "../../src/domain/counter/types";

const workItemId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const serverState = {
  workItemId, revision: 1,
  stitch: { current: 1, target: null },
  row: { current: 0, target: null },
};
const command: CounterCommand = {
  commandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  workItemId, expectedRevision: 0,
  occurredAt: "2026-10-18T12:00:00.000Z",
  deviceId: "test-device",
  action: { type: "change", counter: "stitch", delta: 1 },
};

describe("authenticated Supabase counter adapter", () => {
  it("sends only the command and maps an applied result with revisions", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { status: "applied", state: serverState, eventId: command.commandId, revision: 1, latestRevision: 1 },
      error: null,
    });
    const store = new SupabaseCounterStore({ rpc } as unknown as SupabaseClient);
    expect(await store.applyCommand(command)).toEqual({
      status: "applied", state: serverState, eventId: command.commandId, revision: 1, latestRevision: 1,
    });
    expect(rpc).toHaveBeenCalledWith("apply_counter_command", {
      p_command_id: command.commandId,
      p_work_item_id: command.workItemId,
      p_expected_revision: 0,
      p_occurred_at: command.occurredAt,
      p_device_id: command.deviceId,
      p_action: command.action,
    });
  });

  it("maps conflict and owner-scoped work item creation", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { status: "created", state: { ...serverState, revision: 0, stitch: { current: 0, target: null } }, revision: 0 }, error: null })
      .mockResolvedValueOnce({ data: { status: "conflict", current: serverState, latestRevision: 1 }, error: null });
    const store = new SupabaseCounterStore({ rpc } as unknown as SupabaseClient);
    expect((await store.createWorkItem()).revision).toBe(0);
    expect(await store.applyCommand(command)).toEqual({ status: "conflict", current: serverState, latestRevision: 1 });
    expect(rpc).toHaveBeenNthCalledWith(1, "create_counter_work_item");
  });

  it("reads both counters through the owner's RLS-scoped work item", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: {
      id: workItemId, revision: 1,
      counters: [
        { counter_type: "stitch", current_value: 1, target_value: null },
        { counter_type: "row", current_value: 0, target_value: null },
      ],
    }, error: null });
    const eq = vi.fn().mockReturnValue({ maybeSingle });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const store = new SupabaseCounterStore({ from } as unknown as SupabaseClient);
    expect(await store.getWorkItem(workItemId)).toEqual(serverState);
    expect(from).toHaveBeenCalledWith("work_items");
    expect(eq).toHaveBeenCalledWith("id", workItemId);
  });

  it("reads ordered server events and their saved command timestamps", async () => {
    const initial = { ...serverState, revision: 0, stitch: { current: 0, target: null } };
    const range = vi.fn().mockResolvedValue({ data: [{ id: command.commandId, command_id: command.commandId,
      work_item_id: workItemId, occurred_at: command.occurredAt, device_id: command.deviceId,
      action: command.action, previous_state: initial, next_state: serverState,
      revision_before: 0, revision_after: 1 }], error: null });
    const order = vi.fn().mockReturnValue({ range });
    const eq = vi.fn().mockReturnValue({ order });
    const select = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ select });
    const store = new SupabaseCounterStore({ from } as unknown as SupabaseClient);
    expect(await store.getEvents(workItemId)).toEqual([{ eventId: command.commandId, commandId: command.commandId,
      workItemId, occurredAt: command.occurredAt, deviceId: command.deviceId, action: command.action,
      before: initial, after: serverState }]);
    expect(from).toHaveBeenCalledWith("counter_events");
    expect(eq).toHaveBeenCalledWith("work_item_id", workItemId);
    expect(order).toHaveBeenCalledWith("revision_after", { ascending: true });
  });

  it("shows a useful retry message for a returned network error", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch" } });
    const store = new SupabaseCounterStore({ rpc } as unknown as SupabaseClient);
    await expect(store.applyCommand(command)).rejects.toThrow("서버 연결에 실패했습니다");
  });
});
