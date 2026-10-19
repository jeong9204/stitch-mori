import { applyCounterCommand } from "../../domain/counter/engine";
import type { CounterAction, CounterCommand, CounterEvent, CounterState } from "../../domain/counter/types";
import type { RemoteCounterStore } from "./types";
import type { PendingServerCommand, ServerCommandQueue } from "./server-command-queue";

export type ServerSaveStatus = "loading" | "saved" | "queueing" | "pending" | "failed" | "conflict";

export interface ServerCounterView {
  confirmed: CounterState | null;
  display: CounterState | null;
  events: CounterEvent[];
  confirmedRevision: number;
  pending: PendingServerCommand[];
  status: ServerSaveStatus;
  error: string;
}

const INITIAL: ServerCounterView = {
  confirmed: null, display: null, events: [], confirmedRevision: 0, pending: [], status: "loading", error: "",
};

/** Serializes commands while keeping the durable outbox separate from the guest counter queue. */
export class ServerCounterSession {
  private view: ServerCounterView = INITIAL;
  private confirmedEvents: CounterEvent[] = [];
  private listeners = new Set<() => void>();
  private enqueueTail: Promise<unknown> = Promise.resolve();
  private drainPromise: Promise<void> | null = null;
  private active = true;

  constructor(
    private readonly userId: string,
    private readonly workItemId: string,
    private readonly remote: RemoteCounterStore,
    private readonly queue: ServerCommandQueue,
    private readonly sameUser: () => Promise<boolean>,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getSnapshot = (): ServerCounterView => this.view;
  getServerSnapshot = (): ServerCounterView => INITIAL;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };

  private publish(next: ServerCounterView): void {
    if (!this.active) return;
    this.view = next;
    for (const listener of this.listeners) listener();
  }

  dispose(): void { this.active = false; this.view = INITIAL; this.listeners.clear(); }

  private async serverSnapshot(): Promise<{ state: CounterState; events: CounterEvent[] }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await this.remote.getWorkItem(this.workItemId);
      if (!state) throw new Error("이 계정에서 작업을 찾을 수 없습니다.");
      const events = await this.remote.getEvents(this.workItemId);
      if ((events.at(-1)?.after.revision ?? 0) === state.revision) return { state, events };
    }
    throw new Error("서버 기록을 읽는 동안 변경되었습니다. 다시 불러와 주세요.");
  }

  private preview(state: CounterState, events: CounterEvent[], pending: PendingServerCommand[]):
    { state: CounterState; events: CounterEvent[] } | null {
    let nextState = state;
    let nextEvents = [...events];
    for (const item of pending) {
      const applied = applyCounterCommand(nextState, nextEvents, item.command);
      if (applied.status !== "applied" || !applied.event) return null;
      nextState = applied.state;
      nextEvents = [...nextEvents, applied.event];
    }
    return { state: nextState, events: nextEvents };
  }

  async load(): Promise<void> {
    this.publish({ ...this.view, status: "loading", error: "" });
    try {
      const pending = await this.queue.pending(this.userId, this.workItemId);
      this.publish({ ...this.view, pending });
      if (!await this.sameUser()) throw new Error("로그인 계정이 변경되었습니다.");
      const { state, events } = await this.serverSnapshot();
      this.confirmedEvents = events;
      const preview = this.preview(state, events, pending);
      const firstAlreadyApplied = pending.length > 0 && events.some((event) => event.commandId === pending[0].command.commandId);
      this.publish({ confirmed: state, display: preview?.state ?? state,
        events: preview?.events ?? events, confirmedRevision: state.revision, pending,
        status: pending.length === 0 ? "saved" : preview || firstAlreadyApplied ? "pending" : "conflict",
        error: pending.length > 0 && !preview && !firstAlreadyApplied ? "다른 기기 또는 탭에서 서버 기록이 변경되었습니다. 대기 명령은 보존했습니다." : "" });
      if (pending.length > 0 && (preview || firstAlreadyApplied)) void this.drain();
    } catch (cause) {
      this.publish({ ...this.view, status: "failed", error: cause instanceof Error ? cause.message : "서버 기록을 불러오지 못했습니다." });
    }
  }

  enqueue(action: CounterAction): Promise<boolean> {
    const task = this.enqueueTail.then(() => this.addAction(action));
    this.enqueueTail = task.catch(() => undefined);
    return task;
  }

  private async addAction(action: CounterAction): Promise<boolean> {
    const view = this.view;
    if (!view.display || (view.status !== "saved" && view.status !== "pending")) return false;
    const command: CounterCommand = {
      commandId: this.createId(), workItemId: this.workItemId, expectedRevision: view.display.revision,
      occurredAt: this.now(), deviceId: await this.queue.deviceId(), action,
    };
    const preview = applyCounterCommand(view.display, view.events, command);
    if (preview.status !== "applied" || !preview.event) {
      this.publish({ ...view, error: preview.status === "rejected" ? preview.reason : "변경을 적용하지 못했습니다." });
      return false;
    }
    this.publish({ ...this.view, status: "queueing", error: "" });
    try {
      const saved = await this.queue.add(this.userId, this.workItemId, command);
      const current = this.view;
      const currentPreview = current.display ? applyCounterCommand(current.display, current.events, command) : null;
      if (currentPreview?.status === "applied" && currentPreview.event
        && current.status !== "conflict" && current.status !== "failed") {
        this.publish({ ...current, display: currentPreview.state, events: [...current.events, currentPreview.event],
          pending: [...current.pending, saved], status: "pending", error: "" });
        void this.drain();
      } else {
        this.publish({ ...current, pending: [...current.pending, saved], status: "conflict",
          error: "서버 상태가 바뀌어 새 입력을 미리보기로 적용하지 않았습니다. 대기 명령은 보존했습니다." });
      }
      return true;
    } catch (cause) {
      this.publish({ ...this.view, status: "failed",
        error: `${cause instanceof Error ? cause.message : "대기 명령을 저장하지 못했습니다."} 이 입력은 서버에 전송되지 않았습니다.` });
      return false;
    }
  }

  retry(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (!this.view.confirmed || this.view.pending.length === 0) return this.load();
    if (this.view.status === "conflict") return this.refreshConflict();
    this.publish({ ...this.view, status: "pending", error: "" });
    return this.drain();
  }

  async whenSettled(): Promise<void> {
    await this.enqueueTail;
    while (this.drainPromise) await this.drainPromise;
  }

  async refreshConflict(): Promise<void> {
    if (!await this.sameUser()) { this.publish({ ...this.view, status: "failed", error: "로그인 계정이 변경되었습니다." }); return; }
    try {
      const { state, events } = await this.serverSnapshot();
      this.confirmedEvents = events;
      const preview = this.preview(state, events, this.view.pending);
      this.publish({ ...this.view, confirmed: state, display: preview?.state ?? state,
        events: preview?.events ?? events, confirmedRevision: state.revision,
        status: this.view.pending.length === 0 ? "saved" : preview ? "pending" : "conflict",
        error: preview ? "" : "대기 명령을 자동으로 다시 적용하지 않았습니다. 서버 값과 대기 명령을 확인해 주세요." });
      if (preview && this.view.pending.length > 0) void this.drain();
    } catch (cause) {
      this.publish({ ...this.view, status: "failed", error: cause instanceof Error ? cause.message : "서버 기록을 불러오지 못했습니다." });
    }
  }

  async discardPending(): Promise<void> {
    if (this.drainPromise || !await this.sameUser()) return;
    await this.queue.clear(this.userId, this.workItemId);
    await this.load();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runDrain().finally(() => {
      this.drainPromise = null;
      if (this.active && this.view.status === "pending" && this.view.pending.length > 0) void this.drain();
    });
    return this.drainPromise;
  }

  private async runDrain(): Promise<void> {
    while (this.active && this.view.pending.length > 0) {
      const item = this.view.pending[0];
      try {
        if (!await this.sameUser()) throw new Error("로그인 계정이 변경되었습니다. 대기 명령은 이 계정에 보존했습니다.");
        const result = await this.remote.applyCommand(item.command);
        if (!this.active) return;
        if (result.status === "conflict") {
          await this.refreshConflict();
          return;
        }
        if (result.status === "rejected") throw new Error(result.reason);
        if (result.state.workItemId !== this.workItemId || result.revision !== item.command.expectedRevision + 1) {
          throw new Error("서버 명령 결과가 예상한 revision과 다릅니다. 같은 명령으로 다시 확인해 주세요.");
        }
        // Removal follows server acknowledgment. If it fails, the same command ID is retried.
        await this.queue.remove(item.id);
        const remaining = this.view.pending.slice(1);
        let confirmed = this.view.confirmed;
        let events = this.confirmedEvents;
        if (confirmed && confirmed.revision === item.command.expectedRevision) {
          const applied = applyCounterCommand(confirmed, events, item.command);
          if (applied.status !== "applied" || !applied.event) {
            throw new Error("서버 결과와 로컬 미리보기를 확인할 수 없습니다. 다시 불러와 주세요.");
          }
          confirmed = result.state;
          events = [...events, { ...applied.event, after: result.state, eventId: result.eventId }];
          this.confirmedEvents = events;
        }
        const preview = confirmed ? this.preview(confirmed, events, remaining) : null;
        this.publish({ ...this.view, confirmed, display: preview?.state ?? confirmed,
          events: preview?.events ?? events, confirmedRevision: confirmed?.revision ?? 0, pending: remaining,
          status: remaining.length === 0 ? "saved" : preview ? "pending" : "conflict",
          error: preview || remaining.length === 0 ? "" : "서버 상태가 변경되어 대기 명령을 보존했습니다." });
        if (!preview && remaining.length > 0) return;
        if (result.latestRevision > result.revision) { await this.refreshConflict(); return; }
      } catch (cause) {
        this.publish({ ...this.view, status: "failed", error: `${cause instanceof Error ? cause.message : "서버 저장에 실패했습니다."} 같은 명령 ID로 다시 시도할 수 있습니다.` });
        return;
      }
    }
  }
}
