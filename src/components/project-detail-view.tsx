"use client";

import { ProjectTrackingEditor } from "./project-tracking-editor";
import type { TrackingTarget } from "./project-tracking-session";
import { partStatusLabels } from "./project-tracking-display";
import { TimeStatisticsPanel } from "./time-statistics-panel";
import Link from "next/link";
import { ProjectCoverPhoto } from "./project-cover-photo";
import { ActionMenu } from "./action-menu";
import { ProjectGaugePanel } from "@/components/project-gauge-panel";
import { DeletedRecordsPanel } from "@/components/deleted-records-panel";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { IndexedDbServerCommandQueue } from "@/data/remote/server-command-queue";
import { assertNoPendingCounterCommands } from "@/data/projects/pending-deletion-guard";
import { ProjectPartStore, lastWorkedPart, validatePartName, type PartAction, type PartCommand, type ProjectDetail, type ProjectPart } from "@/data/projects/project-part-store";
import { projectStatusLabels } from "@/data/projects/project-store";
import { createClient } from "@/lib/supabase/client";

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function ProjectName({ name, headingRef }: { name: string; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const heading = headingRef.current;
    if (!heading) return;
    let active = true, frame = 0;
    const mobile = window.matchMedia("(max-width: 640px)");
    const measure = () => {
      if (!active) return;
      const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);
      setOverflow(mobile.matches && heading.scrollHeight > lineHeight * 3 + 1);
    };
    const schedule = () => { if (active) { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); } };
    const observer = new ResizeObserver(schedule);
    observer.observe(heading);
    window.addEventListener("resize", schedule);
    mobile.addEventListener("change", schedule);
    void document.fonts.ready.then(schedule);
    schedule();
    return () => { active = false; cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("resize", schedule); mobile.removeEventListener("change", schedule); };
  }, [headingRef, name]);
  return <div className="project-name-block">
    <h1 ref={headingRef} id="project-full-name" tabIndex={-1} className="project-name-heading" data-expanded={expanded}>{name}</h1>
    {overflow && <button className="project-name-toggle" type="button" aria-controls="project-full-name" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "프로젝트명 접기" : "프로젝트명 전체 보기"}</button>}
  </div>;
}

export function ProjectDetailView({ userId, projectId }: { userId: string; projectId: string }) {
  const router = useRouter();
  const [client] = useState(createClient);
  const [store] = useState(() => new ProjectPartStore(client));
  const [commandQueue] = useState(() => new IndexedDbServerCommandQueue());
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(true);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PartCommand | null>(null);
  const [trackingTarget, setTrackingTarget] = useState<TrackingTarget | null>(null);
  const [trackingLocked, setTrackingLocked] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ProjectPart | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const projectHeadingRef = useRef<HTMLHeadingElement>(null);
  function restoreDeleteFocus() {
    (deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : projectHeadingRef.current)?.focus();
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.auth.getClaims();
      if (data?.claims?.sub !== userId) throw new Error("로그인 계정을 다시 확인해 주세요.");
      const loaded = await store.detail(projectId);
      if (!loaded) throw new Error("프로젝트를 찾을 수 없습니다.");
      setDetail(loaded); setError("");
    } catch (cause) {
      setDetail(null); setError(cause instanceof Error ? cause.message : "프로젝트를 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }, [client, projectId, store, userId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && session?.user.id !== userId)) {
        setAuthorized(false); setDetail(null); setPending(null); setDeleteTarget(null);
        router.replace("/login"); router.refresh();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [client, load, router, userId]);
  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (deleteTarget && !dialog.open) dialog.showModal();
    if (!deleteTarget && dialog.open) dialog.close();
  }, [deleteTarget]);

  async function run(action: PartAction) {
    if (!detail || busy || pending || trackingLocked) return;
    if ((action.type === "create" || action.type === "rename") && validatePartName(action.name)) {
      setError(validatePartName(action.name)!); return;
    }
    const command: PartCommand = { projectId, requestId: crypto.randomUUID(), expectedRevision: detail.revision, action };
    await submit(command);
  }
  async function submit(command: PartCommand) {
    setPending(command); setBusy(true); setError(""); setConflict(false);
    try {
      const action = command.action;
      if (action.type === "delete") {
        const target = detail?.parts.find((part) => part.id === action.partId);
        if (!target) throw new Error("삭제할 파트를 찾을 수 없습니다.");
        await assertNoPendingCounterCommands(commandQueue, userId, [target.workItemId]);
      }
      const result = await store.apply(command);
      if (result.status === "conflict") {
        setConflict(true); setError("다른 화면에서 파트나 프로젝트가 변경됐습니다. 최신 상태를 확인한 뒤 다시 입력해 주세요.");
        setPending(null); return;
      }
      const loaded = await store.detail(projectId);
      if (!loaded) throw new Error("변경 후 프로젝트를 다시 불러오지 못했습니다.");
      setDetail(loaded); setPending(null); setAdding(false); setAddName("");
      setRenamingId(null); setRenameValue(""); setDeleteTarget(null);
    } catch (cause) {
      setDeleteTarget(null);
      setError(cause instanceof Error ? cause.message : "서버 변경을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.");
    } finally { setBusy(false); }
  }
  async function reload() { if (trackingLocked) return; setPending(null); setConflict(false); await load(); }
  function closeDelete() { setDeleteTarget(null); restoreDeleteFocus(); }

  if (!authorized) return <p role="status">계정 상태를 확인하고 있습니다.</p>;
  const latest = detail ? lastWorkedPart(detail) : null;
  return <div className="project-detail-page">
    <nav className="project-detail-back"><Link href="/projects">← 프로젝트 목록</Link></nav>
    {loading && <p className="notice" role="status">프로젝트를 불러오는 중입니다.</p>}
    {error && <div className="quick-error-box" role="alert"><p>{error}</p><div className="project-form-actions">
      {pending && <button type="button" onClick={() => void submit(pending)} disabled={busy}>같은 요청으로 재시도</button>}
      <button type="button" onClick={() => void reload()} disabled={busy || trackingLocked}>{conflict ? "최신 상태 확인" : "목록 다시 불러오기"}</button>
    </div></div>}
      <header className="project-detail-hero">{detail && <><p className="eyebrow">나의 뜨개 프로젝트</p><ProjectCoverPhoto key={`${userId}:${projectId}`} userId={userId} projectId={projectId} editable onChanged={async () => {
        // Photo updates share project revision. Refresh it without clearing an existing part error/pending request.
        const updated = await store.detail(projectId);
        if (!updated) throw new Error("사진은 저장됐지만 프로젝트를 다시 불러오지 못했습니다. 최신 상태를 확인해 주세요.");
        setDetail(updated);
      }} /><div className="project-detail-title"><ProjectName key={`${detail.id}:${detail.name}`} name={detail.name} headingRef={projectHeadingRef} /><span className={`project-status project-status--${detail.status}`}>{projectStatusLabels[detail.status]}</span></div>
        {detail.notes && <details className="project-note-details"><summary><span className="project-notes-preview">{detail.notes}</span><small>메모 전체 보기·접기</small></summary><p className="project-notes">{detail.notes}</p></details>}<p className="project-detail-updated">최근 프로젝트 수정 {timeLabel(detail.updatedAt)}</p><ActionMenu label="프로젝트 관리"><Link href="/projects">프로젝트 이름·메모·상태 수정하기 ↗</Link></ActionMenu>
        </>}<ProjectTrackingEditor key={`tracking:${userId}:${projectId}`} client={client} userId={userId} projectId={projectId} detail={detail} target={trackingTarget} onTarget={setTrackingTarget} onSaved={setDetail} onLocked={setTrackingLocked} disabled={busy || !!pending} />
      </header>
    {detail && <>
      {detail.status !== "active" && <p className="notice" role="status">{projectStatusLabels[detail.status]} 프로젝트의 카운터는 읽기 전용입니다. <Link href="/projects">프로젝트 목록에서 진행 중으로 변경</Link>하면 다시 카운트할 수 있습니다.</p>}
      {latest && <section className="project-resume"><div><p className="eyebrow">이어서 작업하기</p><h2>{latest.name}</h2><p className="project-resume-counts">{latest.stitch}코 <span>·</span> {latest.row}단 완료</p><p>{latest.lastCountAt ? `마지막 변경 ${timeLabel(latest.lastCountAt)}` : "아직 카운트 기록이 없어 기본 파트를 추천해요."}</p></div><Link className="button" href={`/projects/${projectId}/parts/${latest.id}`}>파트 카운터 열기</Link></section>}
      <section className="project-parts-section"><div className="project-parts-heading"><div><p className="eyebrow">작업 파트</p><h2>파트별 카운터</h2><p>같은 파트명을 여러 번 사용할 수 있습니다. 각 파트의 카운터는 서로 독립적입니다.</p></div><button type="button" className="button" onClick={() => { setAdding(true); setError(""); }} disabled={busy || !!pending || trackingLocked}>파트 추가</button></div>
        {adding && <form className="project-part-form" onSubmit={(event) => { event.preventDefault(); void run({ type: "create", name: addName }); }}><label htmlFor="new-part-name">새 파트명</label><input id="new-part-name" autoFocus maxLength={120} required value={addName} onChange={(event) => setAddName(event.target.value)} disabled={busy || !!pending || trackingLocked} /><div className="project-form-actions"><button className="button" type="submit" disabled={busy || !!pending || trackingLocked}>파트 만들기</button><button className="button button-secondary" type="button" onClick={() => { setAdding(false); setAddName(""); }} disabled={busy || !!pending || trackingLocked}>취소</button></div></form>}
        {detail.parts.length === 0 && <p className="quick-empty">표시할 파트가 없습니다. 프로젝트를 새로 확인하거나 파트를 추가해 주세요.</p>}<ol className="project-part-list">{detail.parts.map((part, index) => <li className="project-part-card" key={part.id} aria-label={`${index + 1}번째 파트: ${part.name}`}>
          <div className="project-part-card-top"><span className="project-part-index">{index + 1}</span><div className="project-part-title"><h3 aria-label={part.name} title={part.name}>{part.name}</h3>{part.isDefault && <span>기본 파트</span>}<span className={`part-work-status part-work-status--${part.status}`} aria-label={`작업 상태: ${partStatusLabels[part.status]}`}>{partStatusLabels[part.status]}</span></div></div>
          <p className="project-part-counts"><span>코수 <strong>{part.stitch}</strong></span><span>완료 단수 <strong>{part.row}</strong></span></p>
          <p className="project-part-last">{part.lastCountAt ? <>마지막 변경 <time dateTime={part.lastCountAt}>{timeLabel(part.lastCountAt)}</time></> : "아직 변경 기록이 없습니다."}</p>
          <div className="project-part-controls"><Link className="button" href={`/projects/${projectId}/parts/${part.id}`}>카운터 열기</Link><ActionMenu label={`${part.name} 파트 관리`}><button type="button" disabled={busy || !!pending || trackingLocked} onClick={() => setTrackingTarget({ type: "part", partId: part.id })}>작업 상태 변경</button><button type="button" disabled={busy || !!pending || trackingLocked || index === 0} onClick={() => void run({ type: "move", partId: part.id, direction: "up" })} aria-label={`${part.name} 위로 이동`}>↑ 위로</button><button type="button" disabled={busy || !!pending || trackingLocked || index === detail.parts.length - 1} onClick={() => void run({ type: "move", partId: part.id, direction: "down" })} aria-label={`${part.name} 아래로 이동`}>↓ 아래로</button><button type="button" disabled={busy || !!pending || trackingLocked} onClick={() => { setRenamingId(part.id); setRenameValue(part.name); setError(""); }}>이름 수정</button>{!part.isDefault && <button type="button" className="project-part-delete" disabled={busy || !!pending || trackingLocked} onClick={(event) => { deleteTriggerRef.current = event.currentTarget.closest("details")?.querySelector("summary") ?? event.currentTarget; setDeleteTarget(part); }}>삭제</button>}</ActionMenu></div>
          {renamingId === part.id && <form className="project-part-form" onSubmit={(event) => { event.preventDefault(); void run({ type: "rename", partId: part.id, name: renameValue }); }}><label htmlFor={`rename-${part.id}`}>파트명 수정</label><input id={`rename-${part.id}`} autoFocus required maxLength={120} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} disabled={busy || !!pending || trackingLocked} /><div className="project-form-actions"><button className="button" type="submit" disabled={busy || !!pending || trackingLocked}>이름 저장</button><button className="button button-secondary" type="button" onClick={() => setRenamingId(null)} disabled={busy || !!pending || trackingLocked}>취소</button></div></form>}
        </li>)}</ol>
      </section>
      <TimeStatisticsPanel key={`time:${userId}:${projectId}`} userId={userId} projectId={projectId} />
      <ProjectGaugePanel key={`${userId}:${projectId}`} userId={userId} projectId={projectId} />
      <DeletedRecordsPanel userId={userId} projectId={projectId} onRestored={async () => {
        if (!trackingLocked) { await load(); return; }
        // A failed secondary refresh must not unmount the page-memory tracking request.
        const updated = await store.detail(projectId);
        const { data } = await client.auth.getClaims();
        if (!updated || data?.claims?.sub !== userId) throw new Error("복구 후 조회를 마치지 못했습니다. 미확정 진행률·상태 요청을 먼저 확인해 주세요.");
        setDetail(updated);
      }} />
    </>}
    <dialog ref={deleteDialogRef} className="project-confirm" onClose={() => { setDeleteTarget(null); restoreDeleteFocus(); }} onCancel={() => setDeleteTarget(null)} aria-labelledby="part-delete-title" aria-describedby="part-delete-description"><h2 id="part-delete-title">파트를 삭제할까요?</h2><p id="part-delete-description">{deleteTarget?.name}은 목록에서 숨겨집니다. 카운터와 변경 기록은 보존되며, 삭제된 파트 보기에서 복구할 수 있습니다.</p><div className="project-form-actions"><button type="button" className="button project-delete-button" onClick={() => { if (deleteTarget) void run({ type: "delete", partId: deleteTarget.id }); }} disabled={busy || !!pending || trackingLocked}>파트 삭제</button><button type="button" className="button button-secondary" autoFocus onClick={closeDelete} disabled={busy || !!pending || trackingLocked}>취소</button></div></dialog>
  </div>;
}
