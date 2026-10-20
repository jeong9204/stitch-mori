"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GaugeStore, GaugeRejectedError, blockingLabels, emptyGauge, normalizeGauge, validateGauge, type Gauge, type GaugeCollection, type GaugeCommand, type GaugeData } from "@/data/gauges/gauge-store";
import { createClient } from "@/lib/supabase/client";

type Editor = { existing: boolean; id: string; data: GaugeData; mode: "save" | "delete" };
const dateTime = (value: string) => new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
export function ProjectGaugePanel({ projectId, userId }: { projectId: string; userId: string }) {
  const [client] = useState(createClient);
  const [store] = useState(() => new GaugeStore(client));
  const [collection, setCollection] = useState<GaugeCollection | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [pending, setPending] = useState<GaugeCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reviewLatest, setReviewLatest] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [authorized, setAuthorized] = useState(true);
  const active = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const inFlight = useRef(false);
  const checkUser = useCallback(async () => {
    const { data } = await client.auth.getClaims();
    if (!active.current || data?.claims?.sub !== userId) throw new Error("로그인 계정을 다시 확인해 주세요.");
  }, [client, userId]);
  const load = useCallback(async () => {
    await checkUser();
    const data = await store.list(projectId);
    await checkUser();
    setCollection(data);
  }, [checkUser, projectId, store]);
  useEffect(() => {
    active.current = true;
    void Promise.resolve().then(load).catch(e => { if (active.current) setError(e.message); }).finally(() => { if (active.current) setLoading(false); });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && session?.user.id !== userId)) {
        active.current = false; setAuthorized(false); setCollection(null); setEditor(null); setPending(null);
      }
    });
    return () => { active.current = false; data.subscription.unsubscribe(); };
  }, [client, load, userId]);
  useEffect(() => {
    if (editor && !dialog.current?.open) {
      dialog.current?.showModal();
      if (editor.mode === "delete") cancelButton.current?.focus();
    }
    if (!editor && dialog.current?.open) dialog.current.close();
  }, [editor]);
  function open(event: React.MouseEvent<HTMLButtonElement>, item: Gauge | GaugeData, mode: Editor["mode"]) {
    trigger.current = event.currentTarget; setError(""); setSuccess(""); setConflict(false); setReviewLatest(false);
    setEditor({ existing: "id" in item, id: "id" in item ? item.id : crypto.randomUUID(), data: { ...item }, mode });
  }
  function close() {
    if (inFlight.current || pending) return;
    setEditor(null); setError(""); setConflict(false);
  }
  async function refresh() {
    setLoading(true); setError("");
    try { await load(); setPending(null); setConflict(false); }
    catch (e) { if (active.current) setError(e instanceof Error ? e.message : "게이지를 불러오지 못했습니다."); }
    finally { if (active.current) setLoading(false); }
  }
  async function submit(command?: GaugeCommand) {
    if (!editor || !collection || inFlight.current) return;
    const data = normalizeGauge(editor.data);
    if (!command && editor.mode === "save") {
      const validation = validateGauge(data);
      if (validation) { setError(validation); return; }
    }
    const request = command ?? { projectId, requestId: crypto.randomUUID(), expectedRevision: collection.revision,
      action: editor.mode === "delete" ? { type: "delete" as const, id: editor.id } : { type: "save" as const, id: editor.id, data } };
    inFlight.current = true; setBusy(true); setPending(request); setError(""); setSuccess("");
    try {
      await checkUser();
      const result = await store.apply(request);
      await checkUser();
      if (result.status === "conflict") {
        setPending(null); setReviewLatest(true); setConflict(true); setError("다른 화면에서 게이지가 변경됐습니다. 최신 기록을 확인한 뒤 입력 내용을 검토해 주세요. 자동으로 덮어쓰지 않습니다."); return;
      }
      await load();
      setPending(null); setEditor(null); setSuccess(request.action.type === "delete" ? "게이지를 삭제했습니다." : "게이지를 저장했습니다.");
    } catch (e) { if (e instanceof GaugeRejectedError) setPending(null); if (active.current) setError(e instanceof Error ? e.message : "저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요."); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }
  function patch<K extends keyof GaugeData>(key: K, value: GaugeData[K]) { setEditor(old => old ? { ...old, data: { ...old.data, [key]: value } } : null); }
  const field = (key: "stitches" | "rows" | "width" | "height" | "needle_size_mm", label: string, max: number, step: string) => <label>{label}<input type="number" inputMode={step === "1" ? "numeric" : "decimal"} required={key !== "needle_size_mm"} min={step === "1" ? 1 : .001} max={max} step={step} value={editor?.data[key] ?? ""} onChange={e => patch(key, e.target.value === "" ? (key === "needle_size_mm" ? null : 0) : Number(e.target.value))} /></label>;
  const text = (key: "name" | "needle_label" | "yarn" | "technique", label: string, max: number, required = false) => <label>{label}<input required={required} maxLength={max} value={editor?.data[key] ?? ""} onChange={e => patch(key, e.target.value || null)} /></label>;
  const controlsDisabled = busy || !!pending || conflict || loading;
  const stored = collection?.items.find(g => g.id === editor?.id);
  const pattern = collection?.items.find(g => g.kind === "pattern");
  const samples = collection?.items.filter(g => g.kind === "sample") ?? [];
  if (!authorized) return null;
  return <section className="gauge-section" aria-labelledby="gauge-title">
    <header><p className="eyebrow">한 땀의 기준</p><h2 ref={heading} tabIndex={-1} id="gauge-title">게이지 기록</h2><p>도안의 기준과 직접 측정한 샘플을 기록해요. 자동 환산과 실시간 동기화는 제공하지 않습니다.</p></header>
    {loading && <p role="status">게이지를 불러오는 중입니다.</p>}
    {success && <p className="recovery-success" role="status">{success}</p>}
    {error && !editor && <div role="alert" className="quick-error-box"><p>{error}</p><button className="button button-secondary" onClick={() => void refresh()}>다시 불러오기</button></div>}
    {collection && <><div className="gauge-heading"><h3>도안의 기준</h3>{!pattern && <button className="button" disabled={controlsDisabled} onClick={e => open(e, emptyGauge("pattern"), "save")}>도안 게이지 등록</button>}</div>
      {pattern ? <GaugeCard g={pattern} disabled={controlsDisabled} onEdit={e => open(e, pattern, "save")} onDelete={e => open(e, pattern, "delete")} /> : <p className="gauge-empty">아직 도안 게이지가 없습니다. 입력하지 않아도 프로젝트를 사용할 수 있어요.</p>}
      <div className="gauge-heading"><div><h3>내 게이지 샘플</h3><p>측정일이 최근인 순서로 표시해요. 미지정 샘플은 뒤에 표시합니다.</p></div><button className="button" disabled={controlsDisabled} onClick={e => open(e, emptyGauge("sample"), "save")}>샘플 추가</button></div>
      {samples.length ? <div className="gauge-samples">{samples.map(g => <GaugeCard key={g.id} g={g} disabled={controlsDisabled} onEdit={e => open(e, g, "save")} onDelete={e => open(e, g, "delete")} />)}</div> : <p className="gauge-empty">직접 측정한 샘플을 추가해 보세요.</p>}
      <button className="button button-secondary gauge-refresh" disabled={busy || !!pending} onClick={() => void refresh()}>게이지 새로고침</button></>}
    <dialog ref={dialog} className="project-confirm gauge-dialog" aria-labelledby="gauge-dialog-title"
      onCancel={e => { e.preventDefault(); close(); }} onClose={() => { if (trigger.current?.isConnected) trigger.current.focus(); else heading.current?.focus(); }}>
      {editor && <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <h2 id="gauge-dialog-title">{editor.mode === "delete" ? "게이지를 삭제할까요?" : editor.data.kind === "pattern" ? "도안 게이지 기록" : "내 게이지 샘플 기록"}</h2>
        {editor.mode === "delete" ? <p>{editor.data.name ?? "도안 게이지"}를 목록에서 삭제합니다. 카운터와 변경 이력에는 영향을 주지 않습니다.</p> : <fieldset disabled={controlsDisabled} className="gauge-fields">
          {editor.data.kind === "sample" && text("name", "샘플 이름", 120, true)}
          <div className="gauge-field-pair">{field("stitches", "코수", 1000000, "1")}{field("rows", "단수", 1000000, "1")}</div>
          <div className="gauge-field-pair">{field("width", "측정 폭", 10000, "0.001")}{field("height", "측정 높이", 10000, "0.001")}</div>
          <label>측정 단위<select value={editor.data.unit} onChange={e => patch("unit", e.target.value as GaugeData["unit"])}><option value="cm">cm</option><option value="inch">inch</option></select></label>
          <p className="gauge-help">입력한 단위와 치수를 그대로 저장하며 자동 변환하지 않습니다.</p>
          {text("technique", "무늬·뜨개 방식 (선택)", 200)}
          {editor.data.kind === "sample" && <>{field("needle_size_mm", "바늘 지름 (mm, 선택)", 100, "0.001")}{text("needle_label", "바늘 원래 표기 (선택, 예: US 6)", 80)}{text("yarn", "실 이름 (선택)", 200)}
            <label>블로킹 상태<select value={editor.data.blocking} onChange={e => patch("blocking", e.target.value as GaugeData["blocking"])}>{Object.entries(blockingLabels).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <label>측정일 (선택)<input type="date" min="1900-01-01" max="9999-12-31" value={editor.data.measured_on ?? ""} onInput={e => patch("measured_on", e.currentTarget.value || null)} onChange={e => patch("measured_on", e.target.value || null)} /></label></>}
          <label>메모 (선택)<textarea rows={3} maxLength={5000} value={editor.data.notes ?? ""} onChange={e => patch("notes", e.target.value || null)} /></label>
        </fieldset>}
        {reviewLatest && !conflict && <aside className="gauge-server-review" aria-label="최신 서버 게이지">
          <h3>최신 서버 기록</h3>
          {stored ? <><p>{stored.name ?? "도안 게이지"} · {stored.stitches}코 · {stored.rows}단 · {stored.width} × {stored.height} {stored.unit}</p>
            <p>무늬·방식: {stored.technique ?? "미지정"}</p>
            {stored.kind === "sample" && <><p>{blockingLabels[stored.blocking]} · 측정일 {stored.measured_on ?? "미지정"}</p><p>바늘 {stored.needle_size_mm ?? "미지정"} mm · {stored.needle_label ?? "원래 표기 없음"} · 실 {stored.yarn ?? "미지정"}</p></>}
            <p className="gauge-notes">메모: {stored.notes ?? "없음"}</p><p>수정 {dateTime(stored.updated_at)}</p></> : <p>{editor.existing ? "이 기록은 서버 목록에 없습니다. 삭제 여부를 확인하고 취소해 주세요." : `최신 목록에는 ${collection?.items.length ?? 0}개 기록이 있습니다. 새 기록 저장 시 기존 기록은 유지됩니다.`}</p>}
          <p>위 기록과 입력 내용을 비교한 뒤 저장해 주세요.</p>
        </aside>}
        {busy && <p role="status">서버 저장 결과를 확인하고 있습니다.</p>}
        {error && <div role="alert" className="quick-error-box"><p>{error}</p></div>}
        {pending && <p role="status">입력 내용과 미확정 요청은 현재 화면에서만 보관됩니다. 새로고침하거나 페이지를 떠나면 사라질 수 있으니 서버 저장 결과를 확인하기 전에는 이 화면을 유지해 주세요. 실패 시 같은 요청으로 재시도하면 중복 저장되지 않습니다.</p>}
        <div className="project-form-actions">
          {!pending && !conflict && <button className="button" type="submit" disabled={busy || loading || (editor.existing && reviewLatest && !stored)}>{editor.mode === "delete" ? "게이지 삭제" : "게이지 저장"}</button>}
          {pending && <button className="button" type="button" disabled={busy} onClick={() => void submit(pending)}>같은 요청으로 재시도</button>}
          {conflict && <button className="button" type="button" disabled={busy || loading} onClick={() => void refresh()}>최신 게이지 확인</button>}
          <button className="button button-secondary" type="button" ref={cancelButton} autoFocus onClick={close} disabled={busy || !!pending}>취소</button>
        </div>
      </form>}
    </dialog>
  </section>;
}

function GaugeCard({ g, disabled, onEdit, onDelete }: { g: Gauge; disabled: boolean; onEdit: (e: React.MouseEvent<HTMLButtonElement>) => void; onDelete: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
    return <article className="gauge-card" key={g.id}>
      <h3>{g.kind === "pattern" ? "도안 게이지" : g.name}</h3>
      <p className="gauge-measurement"><strong>{g.stitches}코 · {g.rows}단</strong><span>{g.width} × {g.height} {g.unit}</span></p>
      {g.kind === "sample" && <><p className="gauge-badge">{blockingLabels[g.blocking]}</p><p>측정일 {g.measured_on ?? "미지정"}</p>
        {(g.needle_size_mm !== null || g.needle_label) && <p>바늘 {g.needle_size_mm !== null ? `${g.needle_size_mm} mm` : ""}{g.needle_label ? ` (${g.needle_label})` : ""}</p>}{g.yarn && <p>실 {g.yarn}</p>}</>}
      {g.technique && <p>뜨개 방식 {g.technique}</p>}{g.notes && <p className="gauge-notes">{g.notes}</p>}
      <p className="gauge-timestamp">생성 {dateTime(g.created_at)} · 수정 {dateTime(g.updated_at)}</p>
      <div className="project-form-actions"><button className="button button-secondary" disabled={disabled} onClick={onEdit} aria-label={`${g.name ?? "도안 게이지"} 수정`}>수정</button><button className="button button-secondary" disabled={disabled} onClick={onDelete} aria-label={`${g.name ?? "도안 게이지"} 삭제`}>삭제</button></div>
    </article>;
  }
