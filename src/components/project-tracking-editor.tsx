"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ProjectPartStore, type ProjectDetail } from "@/data/projects/project-part-store";
import { ProjectTrackingStore } from "@/data/projects/project-tracking-store";
import { partStatuses, type PartStatus } from "@/domain/project/tracking";
import { ProjectProgress } from "./project-progress";
import { parseProgressInput, partStatusLabels } from "./project-tracking-display";
import { ProjectTrackingSession, type TrackingTarget } from "./project-tracking-session";

type Props = {
  client: SupabaseClient; userId: string; detail: ProjectDetail;
  target: TrackingTarget | null; onTarget: (target: TrackingTarget | null) => void;
  onSaved: (detail: ProjectDetail) => void; onLocked: (locked: boolean) => void; disabled: boolean;
};
export function ProjectTrackingEditor({ client, userId, detail, target, onTarget, onSaved, onLocked, disabled }: Props) {
  const [session] = useState(() => {
    const tracking = new ProjectTrackingStore(client), parts = new ProjectPartStore(client);
    return new ProjectTrackingSession({ apply: command => tracking.apply(command), detail: () => parts.detail(detail.id), onSaved: saved => { onSaved(saved); onTarget(null); },
      checkUser: async () => { const { data, error } = await client.auth.getClaims(); if (error || data?.claims?.sub !== userId) throw new Error("로그인 계정을 다시 확인해 주세요."); } });
  });
  const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const opened = useRef<TrackingTarget | null>(null);
  const [leaveUrl, setLeaveUrl] = useState<string | null>(null);
  const leaveDialog = useRef<HTMLDialogElement>(null);
  const leaveTrigger = useRef<HTMLElement | null>(null);
  const leaving = useRef(false);
  const busy = state.phase === "saving" || state.refreshing;
  const pending = !!state.pending;
  const conflicted = state.phase === "conflict" || state.phase === "review";
  const editable = !busy && (!pending || state.phase === "review");
  useEffect(() => { session.activate(); return () => session.deactivate(); }, [session]);
  useEffect(() => { onLocked(pending); }, [onLocked, pending]);
  useEffect(() => {
    if (target && target !== opened.current) {
      trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      session.open(target, detail); opened.current = target;
    }
    if (!target) opened.current = null;
    const modal = dialog.current;
    if (target && modal && !modal.open) {
      modal.showModal();
      requestAnimationFrame(() => { if (modal.open) modal.querySelector<HTMLElement>("input,select,button")?.focus(); });
    }
    if (!target && modal?.open) modal.close();
  }, [detail, session, target]);
  useEffect(() => {
    if (!pending) return;
    function unload(event: BeforeUnloadEvent) { if (!leaving.current) { event.preventDefault(); event.returnValue = ""; } }
    function navigate(event: MouseEvent) {
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target === "_blank" || event.metaKey || event.ctrlKey || event.shiftKey || anchor.hasAttribute("download") || anchor.href === window.location.href) return;
      if (new URL(anchor.href).pathname === window.location.pathname && new URL(anchor.href).search === window.location.search && anchor.hash) return;
      event.preventDefault(); event.stopPropagation();
      leaveTrigger.current = anchor; setLeaveUrl(anchor.href);
    }
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", navigate, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); };
  }, [pending]);
  useEffect(() => {
    if (leaveUrl && !leaveDialog.current?.open) leaveDialog.current?.showModal();
    if (!leaveUrl && leaveDialog.current?.open) leaveDialog.current.close();
  }, [leaveUrl]);
  function close() {
    if (busy) return;
    if (!pending && state.phase !== "saved") session.cancel();
    onTarget(null);
  }
  const draft = state.draft;
  const draftPartId = draft?.target.type === "part" ? draft.target.partId : null;
  const part = detail.parts.find(p => p.id === draftPartId) ?? state.server?.parts.find(p => p.id === draftPartId);
  const latestPart = state.latest?.parts.find(p => p.id === draftPartId);
  const originalPart = state.server?.parts.find(p => p.id === draftPartId);
  const originalProgress = state.server?.progressPercent ?? null;
  let draftLabel = "";
  try { draftLabel = draft?.target.type === "progress" ? (parseProgressInput(draft.text, draft.unset) === null ? "미설정" : `${draft.text}%`) : draft ? partStatusLabels[draft.partStatus] : ""; }
  catch { draftLabel = draft?.text || "입력 중"; }
  const canReplace = state.phase === "review" && !!state.latest && (!draftPartId || !!latestPart);
  return <section className="project-tracking" aria-label="프로젝트 진행률 관리">
    <div className="project-tracking-overview"><ProjectProgress value={detail.progressPercent} title="전체 진행률" />
      <button className="button button-secondary" type="button" disabled={disabled || busy} onClick={() => onTarget(draft && pending ? draft.target : { type: "progress" })}>{pending ? "미확정 요청 다시 열기" : detail.progressPercent === null ? "진행률 설정" : "진행률 수정"}</button></div>
    {detail.progressPercent === null && <p className="tracking-help">아직 진행률을 설정하지 않았어요.</p>}
    {state.phase === "saved" && <p className="tracking-success" role="status">서버에 저장하고 최신 값을 확인했어요.</p>}
    {pending && <aside className="tracking-warning" role="status"><p>{state.phase === "refresh_failed" ? "서버 저장은 확인됐지만 최신 조회를 마치지 못했어요." : conflicted ? "충돌한 요청과 입력값을 보존하고 있어요. 자동으로 덮어쓰지 않습니다." : "진행률·파트 상태 저장 결과가 아직 미확정이에요."}</p><p>요청과 입력은 현재 페이지에만 보관됩니다. 새로고침·페이지 이동 시 사라질 수 있으며 자동 복구되지 않습니다.</p>{!target && <button className="button button-secondary" onClick={() => draft && onTarget(draft.target)} disabled={busy}>입력·요청 다시 열기</button>}</aside>}
    <dialog ref={dialog} className="project-confirm tracking-dialog" aria-labelledby="tracking-dialog-title" aria-describedby="tracking-dialog-help"
      onCancel={e => { e.preventDefault(); close(); }} onClose={() => { (trigger.current?.isConnected ? trigger.current : document.getElementById("project-full-name"))?.focus(); }}>
      {draft && <form noValidate onSubmit={e => { e.preventDefault(); void session.save(); }}>
        <h2 id="tracking-dialog-title">{draft.target.type === "progress" ? "전체 진행률 수정" : "파트 작업 상태 변경"}</h2>
        <p id="tracking-dialog-help">{draft.target.type === "progress" ? "직접 기록하는 진행률이에요. 프로젝트 상태와 카운터 값은 바뀌지 않아요." : `${part?.name ?? "선택한 파트"} · 코수·단수와 타이머 기록은 그대로 유지돼요.`}</p>
        <div className="tracking-fields"><fieldset disabled={!editable}>
          {draft.target.type === "progress" ? <>
            <label htmlFor="project-progress-range">슬라이더로 진행률 선택</label>
            <input id="project-progress-range" type="range" min="0" max="100" step="1" value={/^\d+$/.test(draft.text) ? Math.min(100, Math.max(0, Number(draft.text))) : 0} aria-valuetext={draft.unset ? "미설정, 조절하면 진행률을 설정합니다" : `${draft.text}%`} onChange={e => session.edit({ text: e.target.value, unset: false })} />
            <label htmlFor="project-progress-number">진행률 직접 입력 (%)</label>
            <input id="project-progress-number" type="text" inputMode="numeric" maxLength={8} value={draft.text} placeholder="미설정" aria-invalid={!!state.error && !pending} aria-describedby={`tracking-draft${state.error ? " tracking-error" : ""}`} onChange={e => session.edit({ text: e.target.value, unset: false })} />
            <button className="button button-secondary" type="button" onClick={() => session.edit({ unset: true, text: "" })}>미설정으로 변경</button>
          </> : <><label htmlFor="project-part-state">작업 상태</label><select id="project-part-state" value={draft.partStatus} onChange={e => session.edit({ partStatus: e.target.value as PartStatus })}>{partStatuses.map(status => <option key={status} value={status}>{partStatusLabels[status]}</option>)}</select></>}
        </fieldset></div>
        {draft.target.type === "progress" && !pending
          ? <p id="tracking-draft" className="tracking-help">진행률은 저장 버튼을 누르면 반영돼요.</p>
          : <p id="tracking-draft" className="tracking-comparison">{draft.target.type === "progress" ? "내가 입력한 값" : "입력값"} <strong>{draftLabel}</strong> · 편집 시작 값 <strong>{draft.target.type === "progress" ? originalProgress === null ? "미설정" : `${originalProgress}%` : originalPart ? partStatusLabels[originalPart.status] : "조회 불가"}</strong></p>}
        {state.latest && <aside className="tracking-latest"><h3>{draft.target.type === "progress" ? "현재 서버에 저장된 진행률" : "최신 서버 값"}</h3><p>{draft.target.type === "progress" ? state.latest.progressPercent === null ? "미설정" : `${state.latest.progressPercent}%` : latestPart ? partStatusLabels[latestPart.status] : "이 파트를 조회할 수 없어요. 삭제 여부를 확인해 주세요."} · revision {state.latest.revision}</p><p>입력값은 위 편집 영역에 유지됩니다.</p></aside>}
        {state.error && <p id="tracking-error" className="tracking-error" role="alert">{state.error}</p>}
        {busy && <p role="status">{state.refreshing ? "최신 상태 확인 중…" : "서버 저장 결과 확인 중…"}</p>}
        {pending && <p className="tracking-help">{conflicted ? "기존 요청은 revision 충돌로 적용되지 않았어요. 최신 값을 확인한 뒤 새 요청 저장 또는 입력 취소를 선택해 주세요." : "서버 응답이 불분명하면 같은 요청으로 재시도해 주세요. 창을 닫아도 이 페이지 안에서는 요청을 유지합니다."}</p>}
        <div className="project-form-actions">
          {!pending && <button className="button" type="submit" disabled={busy}>저장</button>}
          {pending && !conflicted && <button className="button" type="button" disabled={busy} onClick={() => void session.retry()}>같은 요청으로 재시도</button>}
          {pending && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void session.refreshLatest()}>최신 상태 확인</button>}
          {canReplace && <button className="button" type="button" disabled={busy} onClick={() => void session.confirmReviewedSave()}>입력값을 최신 상태에 새 요청으로 저장</button>}
          {conflicted && <button className="button button-secondary" type="button" disabled={busy} onClick={() => { if (session.cancel()) onTarget(null); }}>입력 취소 (충돌 요청 미적용)</button>}
          <button className="button button-secondary" type="button" disabled={busy} onClick={close}>{pending ? "창 닫기 · 요청 유지" : "취소"}</button>
        </div>
      </form>}
    </dialog>
    <dialog ref={leaveDialog} className="project-confirm tracking-leave-dialog" aria-labelledby="tracking-leave-title" onCancel={e => { e.preventDefault(); setLeaveUrl(null); }} onClose={() => leaveTrigger.current?.focus()}>
      <h2 id="tracking-leave-title">미확정 요청을 두고 이동할까요?</h2>
      <p>입력과 미확정 요청은 현재 페이지에만 보관됩니다. 페이지를 떠나면 사라질 수 있으며 자동 복원되지 않습니다. 서버에 이미 저장된 기록은 유지됩니다.</p>
      <div className="project-form-actions"><button type="button" className="button button-secondary" autoFocus onClick={() => setLeaveUrl(null)}>이 페이지에 머물기</button><button type="button" className="button" onClick={() => { if (leaveUrl) { leaving.current = true; window.location.assign(leaveUrl); } }}>위험을 확인하고 이동</button></div>
    </dialog>
  </section>;
}
