"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ProjectRecoveryStore, type DeletedRecord, type RecoveryRequest } from "@/data/projects/project-recovery-store";
import { projectStatusLabels } from "@/data/projects/project-store";

function formatDate(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}
export function DeletedRecordsPanel({ userId, projectId, onRestored }: {
  userId: string; projectId?: string; onRestored: () => Promise<void>;
}) {
  const [client] = useState(createClient);
  const [store] = useState(() => new ProjectRecoveryStore(client));
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DeletedRecord[]>([]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [target, setTarget] = useState<DeletedRecord | null>(null);
  const [pending, setPending] = useState<RecoveryRequest | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const noun = projectId ? "파트" : "프로젝트";
  const panelId = projectId ? "deleted-parts" : "deleted-projects";
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (target && dialog && !dialog.open) dialog.showModal();
    if (!target && dialog?.open) dialog.close();
  }, [target]);
  useEffect(() => {
    if (success && !busy) toggleRef.current?.focus();
  }, [success, busy]);
  async function checkAccount() {
    const { data } = await client.auth.getClaims();
    if (data?.claims?.sub !== userId) throw new Error("로그인 계정이 변경됐습니다. 화면을 다시 열어 주세요.");
  }
  async function readItems() {
    await checkAccount();
    const result = projectId ? await store.listParts(projectId) : { items: await store.listProjects(), projectRevision: 0 };
    await checkAccount();
    if (mounted.current) { setItems(result.items); setRevision(result.projectRevision); }
  }
  async function load() {
    setLoading(true); setError("");
    try { await readItems(); }
    catch (cause) { if (mounted.current) { setItems([]); setError(cause instanceof Error ? cause.message : "삭제된 항목을 불러오지 못했습니다."); } }
    finally { if (mounted.current) setLoading(false); }
  }
  async function restore(request: RecoveryRequest) {
    setBusy(true); setPending(request); setError(""); setSuccess("");
    try {
      await checkAccount();
      const result = await store.restore(request);
      if (!mounted.current) return;
      setTarget(null);
      if (result.status === "conflict") {
        setPending(null); setError("다른 화면에서 상태가 변경됐습니다. 삭제 목록을 다시 불러온 뒤 복구해 주세요.");
        await readItems(); return;
      }
      await readItems();
      if (!mounted.current) return;
      setPending(null); setSuccess(`${noun}를 복구했습니다. 기존 기록을 그대로 사용할 수 있습니다.`);
      await onRestored();
    } catch (cause) {
      if (mounted.current) { setTarget(null); setError(cause instanceof Error ? cause.message : "복구를 확인하지 못했습니다. 같은 요청으로 재시도해 주세요."); }
    } finally { if (mounted.current) setBusy(false); }
  }
  function confirm() {
    if (!target || busy) return;
    void restore({ projectId: projectId ?? target.id, partId: projectId ? target.id : undefined,
      requestId: crypto.randomUUID(), expectedRevision: projectId ? revision : target.revision! });
  }
  return <section className="recovery-panel" aria-label={`삭제된 ${noun} 복구`}>
    <button ref={toggleRef} className="button button-secondary recovery-toggle" type="button" aria-expanded={open} aria-controls={panelId}
      onClick={() => { setOpen(!open); if (!open) { setSuccess(""); void load(); } }} disabled={busy}>삭제된 {noun} {open ? "접기" : "보기"}</button>
    {open && <div id={panelId} className="recovery-content">
      <h2>삭제된 {noun}</h2><p className="recovery-policy">{projectId ? "복구한 파트는 목록 끝에 추가됩니다. 기존 카운터와 변경 이력은 유지됩니다." : "프로젝트는 삭제 전 상태로 돌아갑니다. 이전에 개별 삭제한 파트는 따로 복구해 주세요."}</p>
      <p className="recovery-policy">미확정 카운터 명령은 복구 과정에서 자동 전송하지 않습니다.</p>
      {loading && <p role="status">삭제된 항목을 불러오는 중입니다.</p>}
      {busy && <p role="status">서버에서 복구를 확인하고 있습니다.</p>}
      {success && <p className="recovery-success" role="status">{success}</p>}
      {error && <div className="quick-error-box" role="alert"><p>{error}</p><div className="project-form-actions">
        {pending && <button type="button" disabled={busy} onClick={() => void restore(pending)}>같은 요청으로 재시도</button>}
        <button type="button" disabled={busy} onClick={() => { setPending(null); void load(); }}>삭제 목록 다시 불러오기</button>
      </div></div>}
      {!loading && !error && items.length === 0 && <p className="recovery-empty">삭제된 {noun}가 없습니다.</p>}
      {!loading && <ul className="recovery-list">{items.map((item) => <li key={item.id}>
        <div><h3>{item.name}</h3><p>삭제 <time dateTime={item.deletedAt}>{formatDate(item.deletedAt)}</time></p>
          {!projectId && item.status && <p>복구 후 상태: {projectStatusLabels[item.status]}</p>}
          {projectId && <><p>코수 {item.stitch} · 완료 단수 {item.row} · 변경 이력 {item.eventCount}건</p><p>{item.lastCountAt ? `마지막 기록 ${formatDate(item.lastCountAt)}` : "변경 기록이 없습니다."}</p></>}
        </div>
        <button className="button" type="button" disabled={busy || !!pending} onClick={(event) => { triggerRef.current = event.currentTarget; setTarget(item); }}>복구</button>
      </li>)}</ul>}
    </div>}
    <dialog ref={dialogRef} className="project-confirm" aria-labelledby={`${panelId}-title`} aria-describedby={`${panelId}-description`}
      onCancel={(event) => { if (busy) event.preventDefault(); else setTarget(null); }}
      onClose={() => { setTarget(null); (triggerRef.current?.isConnected ? triggerRef.current : toggleRef.current)?.focus(); }}>
      <h2 id={`${panelId}-title`}>{noun}를 복구할까요?</h2><p id={`${panelId}-description`}>{target?.name}의 기존 카운터와 기록을 그대로 복구합니다. {projectId ? "파트는 목록 끝에 배치됩니다." : "개별 삭제된 파트는 계속 숨겨집니다."}</p>
      <div className="project-form-actions"><button className="button recovery-confirm-button" type="button" disabled={busy} onClick={confirm}>복구하기</button><button className="button button-secondary" type="button" disabled={busy} autoFocus onClick={() => setTarget(null)}>취소</button></div>
    </dialog>
  </section>;
}
