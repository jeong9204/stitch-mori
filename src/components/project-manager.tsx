"use client";

import Link from "next/link";
import { TrackingPendingNotice } from "./tracking-pending-notice";
import { ProjectProgress } from "./project-progress";
import { ProjectCoverPhoto } from "./project-cover-photo";
import { ActionMenu } from "./action-menu";
import { DeletedRecordsPanel } from "@/components/deleted-records-panel";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { IndexedDbServerCommandQueue } from "@/data/remote/server-command-queue";
import { assertNoPendingCounterCommands } from "@/data/projects/pending-deletion-guard";
import { ProjectStore, projectStatusLabels, validateProjectInput, type Project, type ProjectInput, type ProjectStatus } from "@/data/projects/project-store";

const blank: ProjectInput = { name: "", notes: "", status: "active" };
function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function ProjectManager({ userId }: { userId: string }) {
  const router = useRouter();
  const [client] = useState(createClient);
  const [store] = useState(() => new ProjectStore(client));
  const [commandQueue] = useState(() => new IndexedDbServerCommandQueue());
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [authorized, setAuthorized] = useState(true);
  const [mode, setMode] = useState<"list" | "create" | "edit">("list");
  const [editing, setEditing] = useState<Project | null>(null);
  const [input, setInput] = useState<ProjectInput>(blank);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  const projectHeadingRef = useRef<HTMLHeadingElement>(null);
  function restoreDeleteFocus() {
    (deleteTriggerRef.current?.isConnected ? deleteTriggerRef.current : projectHeadingRef.current)?.focus();
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.auth.getClaims();
      if (data?.claims?.sub !== userId) throw new Error("로그인 계정을 다시 확인해 주세요.");
      setProjects(await store.list()); setError("");
    } catch (cause) { setProjects([]); setError(cause instanceof Error ? cause.message : "프로젝트를 불러오지 못했습니다."); }
    finally { setLoading(false); }
  }, [client, store, userId]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && session?.user.id !== userId)) {
        setAuthorized(false); setProjects([]); setEditing(null); setDeleteTarget(null);
        router.replace("/login"); router.refresh();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [client, refresh, router, userId]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (deleteTarget && !dialog.open) dialog.showModal();
    if (!deleteTarget && dialog.open) dialog.close();
  }, [deleteTarget]);

  function closeDelete() { setDeleteTarget(null); restoreDeleteFocus(); }
  function startCreate() { setInput(blank); setEditing(null); setRequestId(crypto.randomUUID()); setError(""); setMode("create"); }
  function startEdit(project: Project) {
    setInput({ name: project.name, notes: project.notes ?? "", status: project.status });
    setEditing(project); setError(""); setMode("edit");
  }
  function closeForm() { setMode("list"); setEditing(null); setRequestId(null); setError(""); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = validateProjectInput(input);
    if (issue) { setError(issue); return; }
    setBusy(true); setError("");
    try {
      const project = mode === "edit" && editing
        ? await store.update(editing, input)
        : await store.create(requestId ?? crypto.randomUUID(), input);
      // A timed-out request keeps its request ID until the server response is confirmed.
      setProjects((existing) => [project, ...existing.filter((item) => item.id !== project.id)]);
      closeForm();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "저장하지 못했습니다. 같은 요청으로 다시 시도해 주세요."); }
    finally { setBusy(false); }
  }
  async function changeStatus(project: Project, status: ProjectStatus) {
    if (project.status === status) return;
    setBusy(true); setError("");
    try {
      const saved = await store.update(project, { name: project.name, notes: project.notes ?? "", status });
      setProjects((existing) => existing.map((item) => item.id === saved.id ? saved : item));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "상태를 변경하지 못했습니다."); }
    finally { setBusy(false); }
  }
  async function confirmDelete() {
    if (!deleteTarget) return;
    setBusy(true); setError("");
    try {
      const { data: parts, error: partsError } = await client.from("project_parts")
        .select("work_item_id").eq("project_id", deleteTarget.id).is("deleted_at", null);
      if (partsError) throw new Error(partsError.message);
      await assertNoPendingCounterCommands(commandQueue, userId, (parts ?? []).map((part) => part.work_item_id));
      await store.delete(deleteTarget);
      setProjects((existing) => existing.filter((item) => item.id !== deleteTarget.id));
      closeDelete();
    } catch (cause) { setDeleteTarget(null); setError(cause instanceof Error ? cause.message : "프로젝트를 삭제하지 못했습니다."); }
    finally { setBusy(false); }
  }

  if (!authorized) return <p role="status">계정 상태를 확인하고 있습니다.</p>;
  return <div className="projects-page">
    <header className="projects-heading">
      <div><p className="eyebrow">나의 뜨개 작업실</p><h1 ref={projectHeadingRef} tabIndex={-1}>프로젝트</h1><p>작업을 정리하고 파트별 카운터를 이어서 사용하세요.</p></div>
      {mode === "list" && <button className="button" type="button" onClick={startCreate}>새 프로젝트 만들기</button>}
    </header>
    <TrackingPendingNotice key={userId} userId={userId} projects={projects} />
    {error && <div className="quick-error-box" role="alert"><p>{error}</p>{mode === "list" && <button type="button" onClick={() => void refresh()}>목록 다시 불러오기</button>}</div>}
    {mode !== "list" && <section className="project-form-card" aria-label={mode === "create" ? "새 프로젝트" : "프로젝트 수정"}>
      <h2>{mode === "create" ? "새 프로젝트 만들기" : "프로젝트 수정"}</h2>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="project-name">프로젝트명 <span>필수</span></label>
        <input id="project-name" name="name" required maxLength={120} autoFocus value={input.name} onChange={(event) => setInput({ ...input, name: event.target.value })} disabled={busy} />
        <label htmlFor="project-notes">메모 <span>선택</span></label>
        <textarea id="project-notes" name="notes" maxLength={5000} rows={4} value={input.notes} onChange={(event) => setInput({ ...input, notes: event.target.value })} disabled={busy} />
        {mode === "edit" && <><label htmlFor="project-status">상태</label><select id="project-status" value={input.status} onChange={(event) => setInput({ ...input, status: event.target.value as ProjectStatus })} disabled={busy}>{Object.entries(projectStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></>}
        <div className="project-form-actions"><button className="button" type="submit" disabled={busy}>{busy ? "저장 중…" : "저장하기"}</button><button className="button button-secondary" type="button" onClick={closeForm} disabled={busy}>취소</button></div>
      </form>
    </section>}
    {mode === "list" && (loading ? <p className="notice" role="status">프로젝트를 불러오는 중입니다.</p> : projects.length === 0 ? <section className="project-empty"><span aria-hidden="true">✳</span><h2>아직 프로젝트가 없어요</h2><p>새 프로젝트를 만들면 기본 파트와 카운터가 함께 준비됩니다.</p><button className="button" type="button" onClick={startCreate}>첫 프로젝트 만들기</button></section> : <ul className="project-list">{projects.map((project) => <li className="project-card" key={project.id}>
      <div className="project-card-head"><span className={`project-status project-status--${project.status}`}>{projectStatusLabels[project.status]}</span><time dateTime={project.updatedAt}>최근 수정 {dateLabel(project.updatedAt)}</time></div>
      <ProjectCoverPhoto key={`${userId}:${project.id}`} userId={userId} projectId={project.id} /><h2>{project.name}</h2>{project.notes && <p className="project-notes project-notes-preview">{project.notes}</p>}
      <ProjectProgress value={project.progressPercent} /><div className="project-card-actions"><Link className="button" href={`/projects/${project.id}`}>프로젝트 상세 보기</Link><ActionMenu label={`${project.name} 프로젝트 관리`}><button type="button" onClick={() => startEdit(project)} disabled={busy}>수정</button>
        <label className="project-status-picker">상태 <select aria-label={`${project.name} 상태`} value={project.status} onChange={(event) => void changeStatus(project, event.target.value as ProjectStatus)} disabled={busy}>{Object.entries(projectStatusLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <button type="button" className="project-delete" onClick={(event) => { deleteTriggerRef.current = event.currentTarget.closest("details")?.querySelector("summary") ?? event.currentTarget; setDeleteTarget(project); }} disabled={busy}>삭제</button></ActionMenu></div>
    </li>)}</ul>)}
    <dialog ref={deleteDialogRef} className="project-confirm" onClose={() => { setDeleteTarget(null); restoreDeleteFocus(); }} onCancel={() => setDeleteTarget(null)} aria-labelledby="project-delete-title" aria-describedby="project-delete-description">
      <h2 id="project-delete-title">프로젝트를 목록에서 삭제할까요?</h2><p id="project-delete-description">{deleteTarget?.name}은 목록에서 숨겨집니다. 기본 파트의 카운터와 변경 기록은 삭제되지 않습니다.</p>
      <div className="project-form-actions"><button className="button project-delete-button" type="button" onClick={() => void confirmDelete()} disabled={busy}>프로젝트 삭제</button><button className="button button-secondary" type="button" autoFocus onClick={closeDelete} disabled={busy}>취소</button></div>
    </dialog>
    <DeletedRecordsPanel userId={userId} onRestored={refresh} />
    <nav className="project-footer"><Link href="/quick"><span aria-hidden="true">↗</span><span><strong>이 기기의 간편 카운터</strong><small>로그인 없이 이 브라우저에 기록해요</small></span><span aria-hidden="true">›</span></Link><Link href="/account"><span aria-hidden="true">♧</span><span><strong>계정 카운터 목록</strong><small>계정에 저장한 기록을 이어가요</small></span><span aria-hidden="true">›</span></Link></nav>
  </div>;
}
