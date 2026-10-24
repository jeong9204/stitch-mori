"use client";

import Image from "next/image";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { photoFetch, photoJournalKey, type PhotoMetadata, type PhotoRequest } from "@/data/photos/client";

export function ProjectCoverPhoto({ userId, projectId, editable = false, onChanged }: { userId: string; projectId: string; editable?: boolean; onChanged?: () => Promise<void> }) {
  const base = `/api/projects/${projectId}/photo`;
  const journalKey = photoJournalKey(userId, projectId);
  const inputId = useId();
  const dialogId = useId();
  const [metadata, setMetadata] = useState<PhotoMetadata | null>(null);
  const [pending, setPending] = useState<PhotoRequest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const [imageAttempt, setImageAttempt] = useState(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const dialog = useRef<HTMLDialogElement>(null);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const photoMenu = useRef<HTMLDetailsElement>(null);
  const photoMenuTrigger = useRef<HTMLElement>(null);
  const uploadTrigger = useRef<HTMLButtonElement>(null);
  const cancelDialogTrigger = useRef<HTMLButtonElement>(null);
  const restoreUploadFocus = useRef(false);
  const chosenFile = useRef<HTMLInputElement>(null);
  const clearJournal = useCallback(() => { localStorage.removeItem(journalKey); setPending(null); setFile(null); if (chosenFile.current) chosenFile.current.value = ""; }, [journalKey]);
  const refresh = useCallback(async (request?: PhotoRequest | null) => {
    const data: PhotoMetadata = await photoFetch(`${base}${request ? `?requestId=${request.requestId}` : ""}`);
    if (!mounted.current) return;
    setMetadata(data); setImageFailed(false); setImageAttempt((n) => n + 1);
    if (request && data.receipt?.status === "committed") {
      clearJournal(); setNotice("대표 사진 저장 완료");
    }
    return data;
  }, [base, clearJournal]);
  useEffect(() => {
    mounted.current = true;
    void Promise.resolve().then(async () => {
    if (!mounted.current) return;
    let saved: PhotoRequest | null = null;
    try {
      const raw = editable ? localStorage.getItem(journalKey) : null;
      if (raw) { saved = JSON.parse(raw); setPending(saved); }
    } catch { setError("사진 요청 복구 정보를 읽지 못했습니다. 브라우저 저장 공간을 확인해 주세요."); }
    await refresh(saved);
    }).catch((cause) => { if (mounted.current) setError(cause.message); });
    return () => { mounted.current = false; };
  }, [editable, journalKey, refresh]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);

  useEffect(() => {
    if (restoreUploadFocus.current && !busy && metadata && !metadata.photo) {
      uploadTrigger.current?.focus(); restoreUploadFocus.current = false;
    }
  }, [busy, metadata]);

  useEffect(() => {
    if (!editable) return;
    function closeOutside(event: PointerEvent) {
      if (event.target instanceof Node && !photoMenu.current?.contains(event.target)) photoMenu.current?.removeAttribute("open");
    }
    function closeEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && photoMenu.current?.open && !dialog.current?.open) {
        event.preventDefault(); photoMenu.current.open = false; photoMenuTrigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside); document.removeEventListener("keydown", closeEscape); };
  }, [editable]);
  function openPhotoPicker() {
    photoMenu.current?.removeAttribute("open");
    photoMenuTrigger.current?.focus();
    chosenFile.current?.click();
  }
  function openDeleteDialog() {
    photoMenu.current?.removeAttribute("open");
    dialog.current?.showModal(); cancelDialogTrigger.current?.focus();
  }

  async function submit(request: PhotoRequest, selected?: File | null) {
    if (inFlight.current) return;
    if (request.action === "upload" && !selected) { setError("같은 사진 파일을 다시 선택한 뒤 재시도해 주세요. 파일은 브라우저 재접속 후 자동 보관되지 않습니다."); return; }
    try { localStorage.setItem(journalKey, JSON.stringify(request)); } catch { setError("요청 복구 정보를 로컬에 보관하지 못해 업로드를 시작하지 않았습니다. 저장 공간을 확인해 주세요."); return; }
    inFlight.current = true; setBusy(true); setPending(request); setError(""); setNotice("");
    try {
      if (!navigator.onLine) throw new Error("오프라인에서는 사진을 저장할 수 없습니다. 연결 후 같은 요청으로 다시 시도해 주세요. 기존 사진은 유지됩니다.");
      const result = await photoFetch(base, { method: request.action === "upload" ? "POST" : "DELETE", headers: { "x-photo-request-id": request.requestId, "x-project-revision": String(request.expectedRevision) }, body: request.action === "upload" ? selected : undefined });
      // Only the server's committed receipt makes a change complete. Cleanup failure is separate.
      if (result.status !== "committed") throw new Error("서버 저장이 아직 확정되지 않았습니다.");
      if (request.action === "delete") restoreUploadFocus.current = true;
      clearJournal(); setNotice(request.action === "delete" ? "대표 사진 삭제 완료" : "대표 사진 저장 완료");
      setMetadata((current) => current ? { ...current, cleanupPending: result.cleanupPending } : current);
      await refresh();
      await onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "사진 저장 결과가 미확정입니다. 같은 요청으로 재시도해 주세요."); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  function selectFile(selected: File | undefined) {
    if (!selected) return;
    setError(""); setNotice("");
    if (selected.size === 0 || selected.size > 10 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(selected.type)) { setError("10MB 이하의 JPEG·PNG·WebP 사진을 선택해 주세요."); return; }
    setFile(selected);
    if (pending) { setNotice("재시도할 파일을 선택했습니다. 원래 요청과 다른 파일은 서버에서 거부됩니다."); return; }
    if (!metadata) return;
    void submit({ requestId: crypto.randomUUID(), expectedRevision: metadata.revision, action: "upload", fileName: selected.name }, selected);
  }
  async function cancelPending() {
    if (!pending || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await photoFetch(`${base}/cancel`, { method: "POST", headers: { "x-photo-request-id": pending.requestId, "x-project-revision": String(pending.expectedRevision) } });
      clearJournal(); await refresh(); await onChanged?.(); setNotice("요청을 확인했습니다. 이미 확정된 사진은 유지되고 미확정 업로드만 취소됩니다.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "요청을 취소하지 못했습니다."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  return <section className={`project-cover ${editable ? `project-cover--editable ${metadata?.photo ? "has-photo" : "is-empty"}` : "project-cover--list"}`} aria-label="프로젝트 대표 사진">
    <div className="project-cover-image">
      {metadata?.photo && !imageFailed ? <Image unoptimized src={`${base}/image?photo=${metadata.photo.id}&attempt=${imageAttempt}`} width={metadata.photo.width} height={metadata.photo.height} alt="프로젝트 대표 사진" onError={() => setImageFailed(true)} /> : <div className="project-cover-placeholder">{editable ? <svg className="project-yarn-icon" viewBox="0 0 80 64" fill="none" aria-hidden="true"><circle cx="36" cy="28" r="22" fill="var(--color-soft-rose)" stroke="currentColor" strokeWidth="2.2"/><path d="M19 14c8 3 21 17 26 31M25 8c10 6 21 20 25 30M16 23c8 3 18 13 23 25M17 37 48 10M24 45 55 19M15 28 39 6M51 43c6 7 8 12 17 9s8-12 0-10c-9 3-10 17 5 15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><path d="M61 20c-1-8 4-14 11-14 0 7-4 13-11 14Z" fill="var(--color-accent)"/></svg> : <span aria-hidden="true">❋</span>}<small>{imageFailed ? "사진을 불러오지 못했어요" : metadata ? "한 코씩, 나만의 작품" : "사진 확인 중…"}</small></div>}
    </div>
    <div className="project-cover-controls">
      {editable && <>
        <div className="project-cover-actions">
          {metadata?.photo && !pending ? <details ref={photoMenu} className="project-photo-menu">
            <summary ref={photoMenuTrigger}>사진 관리 <span aria-hidden="true">⌄</span></summary>
            <div className="project-photo-menu-panel">
              <button ref={uploadTrigger} type="button" disabled={busy} onClick={openPhotoPicker}>사진 교체</button>
              <button ref={deleteTrigger} type="button" disabled={busy} onClick={openDeleteDialog}>사진 삭제</button>
              <small>JPEG·PNG·WebP · 10MB 이하<br />계정에 비공개로 보관해요</small>
            </div>
          </details> : <button ref={uploadTrigger} type="button" className="button button-secondary" disabled={busy || !metadata} onClick={openPhotoPicker}>{pending ? "재시도할 사진 선택" : "대표 사진 등록"}</button>}
          <input ref={chosenFile} id={inputId} type="file" accept="image/jpeg,image/png,image/webp" className="project-photo-input" tabIndex={-1} aria-label={pending ? "재시도할 사진 선택" : "대표 사진 파일 선택"} disabled={busy || !metadata} onChange={(event) => selectFile(event.target.files?.[0])} />
        </div>
        {!metadata?.photo && <small>JPEG·PNG·WebP · 10MB 이하 · 비공개</small>}
        {pending && <div className="notice" role="status"><p>{busy ? "사진 처리 및 서버 연결을 확인 중입니다. 기존 사진은 확정 전까지 유지됩니다." : `미확정 ${pending.action === "delete" ? "삭제" : "업로드"} 요청이 있습니다.${pending.fileName ? ` 파일: ${pending.fileName}` : ""} 페이지를 떠나면 파일을 다시 선택해야 할 수 있습니다.`}</p>{!busy && <div className="project-cover-actions"><button className="button button-secondary" type="button" onClick={() => void submit(pending, file)}>같은 요청으로 재시도</button><button type="button" onClick={() => void cancelPending()}>요청 확인·취소 후 새로 진행</button></div>}</div>}
        {notice && <p role="status" className="project-photo-status">{notice}</p>}
        {metadata?.cleanupPending && <div className="notice"><p>사진 연결은 저장됐지만 이전 파일 정리가 남아 있습니다. 현재 사진은 안전하게 유지됩니다.</p><button type="button" disabled={busy} onClick={() => { void photoFetch(`${base}/cleanup`, { method: "POST" }).then(() => refresh(pending)).catch((cause) => setError(cause.message)); }}>이전 파일 정리 재시도</button></div>}
      </>}
      {(error || imageFailed) && <div className="quick-error-box" role="alert"><p>{error || "사진 접근 권한 또는 연결을 확인해 주세요."}</p><button type="button" disabled={busy} onClick={() => { setError(""); void refresh(pending).catch((cause) => setError(cause.message)); }}>사진 최신 상태 확인</button></div>}
    </div>
    {editable && <dialog ref={dialog} className="project-confirm" aria-labelledby={dialogId} onClose={() => (photoMenuTrigger.current ?? deleteTrigger.current ?? uploadTrigger.current)?.focus()}><h2 id={dialogId}>대표 사진을 삭제할까요?</h2><p>프로젝트와 카운터 기록은 유지됩니다. 사진 연결이 서버에서 확정된 후 기본 이미지로 표시합니다.</p><div className="project-form-actions"><button className="button" type="button" onClick={() => { dialog.current?.close(); if (metadata) void submit({ requestId: crypto.randomUUID(), expectedRevision: metadata.revision, action: "delete" }); }}>사진 삭제 확정</button><button ref={cancelDialogTrigger} className="button button-secondary" type="button" onClick={() => dialog.current?.close()}>취소</button></div></dialog>}
  </section>;
}
