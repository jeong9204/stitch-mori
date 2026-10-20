import type { SupabaseClient } from "@supabase/supabase-js";
import type { TimerCommand, TimerEvent, TimerResult, WorkSession } from "../../domain/timer/types";
import type { IndexedDbTimerStore } from "./indexeddb-timer-store";
export type TimerSnapshot = { state: WorkSession | null; events: TimerEvent[]; serverNow: string };
export interface TimerRemoteStore { apply(command: TimerCommand): Promise<TimerResult>; load(sessionId?: string): Promise<TimerSnapshot> }
export class SupabaseTimerStore implements TimerRemoteStore {
  constructor(private readonly client: SupabaseClient, private readonly userId: string) {}
  private async assertUser() {
    const { data, error } = await this.client.auth.getClaims();
    if (error || data?.claims?.sub !== this.userId) throw new Error("timer_account_changed");
  }
  async apply(command: TimerCommand): Promise<TimerResult> {
    await this.assertUser();
    const { data, error } = await this.client.rpc("apply_work_session_command", {
      p_command_id: command.commandId, p_session_id: command.sessionId, p_work_item_id: command.workItemId,
      p_expected_revision: command.expectedRevision, p_occurred_at: command.occurredAt, p_device_id: command.deviceId, p_action: command.action,
    });
    if (error) throw new Error(error.message);
    await this.assertUser();
    if (!data || !["applied","duplicate","conflict","rejected"].includes(data.status)) throw new Error("invalid_timer_response");
    if ((data.status === "applied" || data.status === "duplicate") && (data.eventId !== command.commandId
      || data.state?.userId !== this.userId || data.state?.sessionId !== command.sessionId
      || data.state?.workItemId !== command.workItemId || data.state?.revision !== command.expectedRevision + 1)) throw new Error("invalid_timer_response");
    return data;
  }
  async load(sessionId?: string): Promise<TimerSnapshot> {
    await this.assertUser();
    const { data, error } = await this.client.rpc("get_work_session", { p_session_id: sessionId ?? null });
    if (error) throw new Error(error.message);
    await this.assertUser();
    if (!data || !Array.isArray(data.events) || typeof data.serverNow !== "string" || (data.state && (data.state.userId !== this.userId || (sessionId && data.state.sessionId !== sessionId)))) throw new Error("invalid_timer_snapshot");
    return data;
  }
}
/** One durable unresolved timer command per account. Recovery is explicit; reads never transmit it.
 * Conflicts and rejections remain available for review; no automatic rebase/discard occurs. */
export class ServerTimerCommands {
  constructor(private readonly userId: string, private readonly remote: TimerRemoteStore,
    private readonly outbox: Pick<IndexedDbTimerStore,"pending" | "retain" | "release">) {}
  pending() { return this.outbox.pending(this.userId); }
  async submit(command: TimerCommand): Promise<TimerResult> {
    await this.outbox.retain(this.userId,command);
    const result = await this.remote.apply(command);
    if (result.status === "applied" || result.status === "duplicate") await this.outbox.release(this.userId,command.commandId);
    return result;
  }
  async retry(): Promise<TimerResult> {
    const pending = await this.pending();
    if (!pending) throw new Error("no_pending_timer_command");
    return this.submit(pending.command);
  }
}
