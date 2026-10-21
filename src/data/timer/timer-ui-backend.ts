import type { SupabaseClient } from "@supabase/supabase-js";
import { IndexedDbCounterStore } from "../local/indexeddb-counter-store";
import type { TimerCommand, TimerResult, WorkSession } from "../../domain/timer/types";
import { IndexedDbTimerStore } from "./indexeddb-timer-store";
import { ServerTimerCommands, SupabaseTimerStore } from "./server-timer-store";
export type TimerMode = "manual" | "auto";
export type TimerContext = {
  mode: TimerMode; modeRevision: number; activationRevision: number; counterRevision: number;
  state: WorkSession | null; active: WorkSession | null; activeName: string; workName: string;
  canStart: boolean; serverNow: string;
};
export interface TimerUiBackend {
  scope: string; workItemId: string; server: boolean;
  load(): Promise<TimerContext>; pending(): Promise<TimerCommand | null>;
  send(command: TimerCommand): Promise<TimerResult>; release(commandId: string): Promise<void>;
  setMode(mode: TimerMode, revision: number): Promise<void>;
  readMarker(): Promise<number>; writeMarker(revision: number): Promise<void>; deviceId(): Promise<string>;
}
class UiJournal {
  constructor(protected readonly store: IndexedDbTimerStore, public readonly scope: string) {}
  async readMarker() { return await this.store.readUi<number>(`${this.scope}:marker`) ?? 0; }
  async writeMarker(revision: number) { await this.store.writeUi(`${this.scope}:marker`,revision); }
  async deviceId() {
    let id=await this.store.readUi<string>("device");
    if (!id) { id=crypto.randomUUID(); await this.store.writeUi("device",id); }
    return id;
  }
}
export class LocalTimerBackend extends UiJournal implements TimerUiBackend {
  readonly server=false;
  constructor(public readonly workItemId: string, store=new IndexedDbTimerStore(), private readonly counters=new IndexedDbCounterStore()) {
    super(store,`local:${workItemId}`);
  }
  async load(): Promise<TimerContext> {
    const [pref,active,history,latest]=await Promise.all([this.store.readUi<{ mode: TimerMode; activationRevision: number }>(`${this.scope}:mode`),this.store.activeLocal(),this.store.localHistory(this.workItemId),this.store.readUi<string>(`${this.scope}:latest`)]);
    const state=(active?.workItemId===this.workItemId?active:null) ?? history.find(s=>s.sessionId===latest) ?? history.sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt))[0] ?? null;
    return { mode: pref?.mode ?? "manual", modeRevision: 0, activationRevision: pref?.activationRevision ?? 0,
      counterRevision: 0, state, active, activeName: "이 기기의 간편 카운터", workName: "이 기기의 간편 카운터", canStart: true, serverNow: new Date().toISOString() };
  }
  pending() { return this.store.pendingLocal(); }
  async send(command: TimerCommand): Promise<TimerResult> {
    await this.store.retainLocal(command);
    const result=await this.store.applyLocal(command);
    if (result.status==="applied" || result.status==="duplicate") {
      const latest=await this.store.readUi<string>(`${this.scope}:latest`);
      if(result.status==="applied" || !latest)await this.store.writeUi(`${this.scope}:latest`,result.state.sessionId);
      await this.store.releaseLocal(command.commandId);
    }
    return result;
  }
  release(commandId: string) { return this.store.releaseLocal(commandId); }
  async setMode(mode: TimerMode) {
    const record=await this.counters.getQuickIfExists();
    if (!record || record.localWorkItemId!==this.workItemId) throw new Error("로컬 작업을 다시 확인해 주세요.");
    await this.store.writeUi(`${this.scope}:mode`,{mode,activationRevision:record.state.revision});
  }
}
export class AccountTimerBackend extends UiJournal implements TimerUiBackend {
  readonly server=true;
  private readonly commands: ServerTimerCommands;
  constructor(private readonly client: SupabaseClient, private readonly userId: string, public readonly workItemId: string,store=new IndexedDbTimerStore()) {
    super(store,`account:${userId}:${workItemId}`);
    this.commands=new ServerTimerCommands(userId,new SupabaseTimerStore(client,userId),store);
  }
  private async auth() {
    const {data,error}=await this.client.auth.getClaims();
    if (error || data?.claims?.sub!==this.userId) throw new Error("로그인 계정이 변경되었습니다.");
  }
  async load(): Promise<TimerContext> {
    await this.auth();
    const {data,error}=await this.client.rpc("get_work_timer_context",{p_work_item_id:this.workItemId});
    if (error) throw new Error(error.message);
    await this.auth();
    if (!data || !["manual","auto"].includes(data.mode) || (data.state && data.state.userId!==this.userId) || (data.active && data.active.userId!==this.userId)) throw new Error("타이머 응답을 확인할 수 없습니다.");
    return data;
  }
  async pending() { return (await this.commands.pending())?.command ?? null; }
  send(command: TimerCommand) { return this.commands.submit(command); }
  async release(commandId: string) { await this.auth(); await this.store.release(this.userId,commandId); }
  async setMode(mode: TimerMode,revision: number) {
    await this.auth();
    const {data,error}=await this.client.rpc("set_work_timer_mode",{p_work_item_id:this.workItemId,p_mode:mode,p_expected_revision:revision});
    if (error) throw new Error(error.message);
    await this.auth();
    if (data?.status!=="applied") throw new Error("다른 화면에서 설정이 변경됐습니다. 최신 설정을 불러와 주세요.");
  }
}
