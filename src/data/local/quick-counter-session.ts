import { applyCounterCommand } from "../../domain/counter/engine";
import type { CounterAction, CounterCommand, CounterEvent } from "../../domain/counter/types";
import type { LocalCounterRecord, LocalCounterStore, LocalPersistenceStatus } from "./types";

export interface QuickCounterView {
  record: LocalCounterRecord | null;
  events: CounterEvent[];
  status: LocalPersistenceStatus | "loading";
  error: string;
  pendingCount: number;
}

const INITIAL_VIEW: QuickCounterView = {
  record: null, events: [], status: "loading", error: "", pendingCount: 0,
};

/** Keeps accepted taps in order while one IndexedDB write is in flight. */
export class QuickCounterSession {
  private view: QuickCounterView = INITIAL_VIEW;
  private queue: CounterCommand[] = [];
  private drainPromise: Promise<void> | null = null;
  private loadPromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private readonly store: LocalCounterStore,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly onConfirmed?: (event: CounterEvent) => void | Promise<void>,
  ) {}

  getSnapshot = (): QuickCounterView => this.view;
  getServerSnapshot = (): QuickCounterView => INITIAL_VIEW;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(next: QuickCounterView): void {
    this.view = next;
    for (const listener of this.listeners) listener();
  }

  load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    if (this.queue.length > 0 || this.drainPromise) return Promise.resolve();
    this.loadPromise = this.runLoad().finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }

  private async runLoad(): Promise<void> {
    this.publish({ ...this.view, status: "loading", error: "" });
    try {
      const record = await this.store.getOrCreateQuick();
      const events = await this.store.getEvents(record.localWorkItemId);
      this.publish({ record, events, status: "saved", error: "", pendingCount: 0 });
    } catch (error) {
      this.publish({
        ...this.view, status: "failed",
        error: error instanceof Error ? error.message : "로컬 기록을 불러오지 못했습니다.",
      });
    }
  }

  enqueue(action: CounterAction): boolean {
    const { record, events, status } = this.view;
    if (!record || (status !== "saved" && status !== "pending")) return false;
    const command: CounterCommand = {
      commandId: this.createId(),
      workItemId: record.localWorkItemId,
      expectedRevision: record.state.revision,
      occurredAt: this.now(),
      deviceId: record.deviceId,
      action,
    };
    const preview = applyCounterCommand(record.state, events, command);
    if (preview.status !== "applied" || !preview.event) {
      this.publish({ ...this.view, error: preview.status === "rejected" ? preview.reason : "변경을 적용하지 못했습니다." });
      return false;
    }
    this.queue.push(command);
    this.publish({
      record: { ...record, state: preview.state, updatedAt: command.occurredAt },
      events: [...events, preview.event],
      status: "pending",
      error: "",
      pendingCount: this.queue.length,
    });
    void this.drain();
    return true;
  }

  retry(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (this.queue.length === 0) return this.load();
    this.publish({ ...this.view, status: "pending", error: "" });
    return this.drain();
  }

  whenSettled(): Promise<void> {
    return this.drainPromise ?? Promise.resolve();
  }

  private drain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.runQueue().finally(() => { this.drainPromise = null; });
    return this.drainPromise;
  }

  private async runQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const command = this.queue[0];
      try {
        const result = await this.store.applyCommand(command);
        if (result.status === "conflict") {
          this.publish({
            ...this.view, status: "failed",
            error: "다른 탭에서 기록이 바뀌었습니다. 저장되지 않은 입력을 보존하고 있습니다. 이 탭을 닫지 말고 다른 탭을 확인해 주세요.",
          });
          return;
        }
        if (result.status === "rejected") throw new Error(result.reason);
        this.queue.shift();
        const event=this.view.events.find(event=>event.commandId===command.commandId);
        if(event && this.onConfirmed) { try { void Promise.resolve(this.onConfirmed(event)).catch(()=>undefined); } catch { /* Counter storage remains confirmed. */ } }
        this.publish({ ...this.view, pendingCount: this.queue.length, status: this.queue.length ? "pending" : "saved", error: "" });
      } catch (error) {
        this.publish({
          ...this.view, status: "failed",
          error: `${error instanceof Error ? error.message : "로컬 저장에 실패했습니다."} 저장되지 않은 변경은 이 탭을 닫으면 사라질 수 있습니다.`,
        });
        return;
      }
    }
  }
}
