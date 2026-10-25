import type { PartStatus, ProjectTrackingCommand, ProjectTrackingResult } from "../domain/project/tracking";
import type { ProjectDetail } from "../data/projects/project-part-store";
import { parseProgressInput } from "./project-tracking-display";

export type TrackingTarget = { type: "progress" } | { type: "part"; partId: string };
export type TrackingDraft = { target: TrackingTarget; text: string; unset: boolean; partStatus: PartStatus };
type Phase = "editing" | "saving" | "failed" | "conflict" | "review" | "refresh_failed" | "saved";
export type TrackingEditorState = {
  draft: TrackingDraft | null; server: ProjectDetail | null; latest: ProjectDetail | null;
  refreshing: boolean; phase: Phase; pending: ProjectTrackingCommand | null; error: string; replacedRequestId: string | null;
};
type Dependencies = {
  apply: (command: ProjectTrackingCommand) => Promise<ProjectTrackingResult>;
  detail: () => Promise<ProjectDetail | null>;
  checkUser: () => Promise<void>;
  onSaved: (detail: ProjectDetail) => void;
  requestId?: () => string;
};
const blank = (): TrackingEditorState => ({ draft: null, server: null, latest: null, refreshing: false, phase: "editing", pending: null, error: "", replacedRequestId: null });

/** Page-memory editor only. It never uses or alters the counter's IndexedDB queue. */
export class ProjectTrackingSession {
  private state = blank();
  private listeners = new Set<() => void>();
  private active = true;
  private generation = 0;
  private inFlight = false;
  constructor(private readonly deps: Dependencies) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  activate() { this.active = true; }
  deactivate() { this.active = false; this.generation++; this.inFlight = false; }
  private patch(patch: Partial<TrackingEditorState>) {
    if (!this.active) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(fn => fn());
  }
  open(target: TrackingTarget, server: ProjectDetail) {
    if (this.state.pending) return; // Reopen the existing request, never replace it silently.
    const part = target.type === "part" ? server.parts.find(p => p.id === target.partId) : null;
    if (target.type === "part" && !part) return;
    this.patch({ ...blank(), server, draft: { target, text: server.progressPercent?.toString() ?? "", unset: server.progressPercent === null, partStatus: part?.status ?? "not_started" } });
  }
  edit(patch: Partial<Pick<TrackingDraft, "text" | "unset" | "partStatus">>) {
    if (!this.state.draft || !["editing", "review"].includes(this.state.phase) || this.inFlight) return;
    this.patch({ draft: { ...this.state.draft, ...patch }, error: "" });
  }
  cancel() {
    if (this.inFlight || (this.state.pending && !["conflict", "review"].includes(this.state.phase))) return false;
    if (this.state.phase === "review" && this.state.latest) this.deps.onSaved(this.state.latest);
    this.patch(blank()); return true;
  }
  private command(revision: number): ProjectTrackingCommand {
    const { draft, server } = this.state;
    if (!draft || !server) throw new Error("수정할 프로젝트가 없습니다.");
    return { projectId: server.id, requestId: this.deps.requestId?.() ?? crypto.randomUUID(), expectedRevision: revision,
      action: draft.target.type === "progress" ? { type: "setProgress", value: parseProgressInput(draft.text, draft.unset) }
        : { type: "setPartStatus", partId: draft.target.partId, status: draft.partStatus } };
  }
  async save() {
    if (this.inFlight || this.state.pending || !this.state.server) return;
    try { await this.send(this.command(this.state.server.revision)); }
    catch (e) { this.patch({ error: e instanceof Error ? e.message : "입력을 확인해 주세요." }); }
  }
  async retry() {
    if (!this.state.pending || this.inFlight || ["conflict", "review"].includes(this.state.phase)) return;
    await this.send(this.state.pending);
  }
  async confirmReviewedSave() {
    const { latest, draft, phase, pending } = this.state;
    if (phase !== "review" || !latest || !pending || !draft || this.inFlight) return;
    if (draft.target.type === "part") {
      const target = draft.target;
      if (!latest.parts.some(p => p.id === target.partId)) return;
    }
    try {
      const command = this.command(latest.revision);
      this.patch({ replacedRequestId: pending.requestId });
      await this.send(command);
    } catch (e) { this.patch({ error: e instanceof Error ? e.message : "입력을 확인해 주세요." }); }
  }
  async refreshLatest() {
    if (this.inFlight || !this.state.pending) return;
    this.inFlight = true;
    this.patch({ refreshing: true });
    const epoch = this.generation;
    try {
      await this.deps.checkUser();
      if (!this.active || epoch !== this.generation) return;
      const latest = await this.deps.detail();
      await this.deps.checkUser();
      if (!this.active || epoch !== this.generation) return;
      if (!latest) throw new Error("프로젝트를 조회할 수 없습니다. 삭제 여부와 계정을 확인해 주세요.");
      this.patch({ latest, error: "", phase: ["conflict", "review"].includes(this.state.phase) ? "review" : this.state.phase });
    } catch (e) { if (epoch === this.generation) this.patch({ error: e instanceof Error ? e.message : "최신 상태를 확인하지 못했습니다." }); }
    finally { if (epoch === this.generation) { this.inFlight = false; this.patch({ refreshing: false }); } }
  }
  private async send(command: ProjectTrackingCommand) {
    this.inFlight = true;
    const epoch = this.generation;
    this.patch({ phase: "saving", pending: command, error: "" });
    let confirmed = false;
    try {
      await this.deps.checkUser();
      if (!this.active || epoch !== this.generation) return;
      const result = await this.deps.apply(command);
      await this.deps.checkUser();
      if (!this.active || epoch !== this.generation) return;
      if (result.status === "conflict") {
        this.patch({ phase: "conflict", latest: null, error: "다른 화면에서 프로젝트가 변경됐습니다. 입력과 충돌 요청을 보존했어요. 최신 값을 확인해 주세요." }); return;
      }
      confirmed = true;
      const latest = await this.deps.detail();
      await this.deps.checkUser();
      if (!this.active || epoch !== this.generation) return;
      if (!latest) throw new Error("저장 후 프로젝트를 조회하지 못했습니다.");
      this.deps.onSaved(latest);
      this.patch({ phase: "saved", pending: null, latest, error: "" });
    } catch (e) {
      if (epoch === this.generation) this.patch({ phase: confirmed ? "refresh_failed" : "failed", error: e instanceof Error ? e.message : "저장 결과를 확인하지 못했습니다." });
    } finally { if (epoch === this.generation) this.inFlight = false; }
  }
}
