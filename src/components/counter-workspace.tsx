"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { lastUndoableEvent } from "@/domain/counter/engine";
import type { CounterAction, CounterEvent, CounterState, CounterType } from "@/domain/counter/types";
import { isNonNegativeInteger } from "@/domain/counter/invariants";
import { changeText, lastCounterChange } from "./counter-display";

const name = { stitch: "코수", row: "단수" } as const;

function dateTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function eventLabel(event: CounterEvent): string {
  const action = event.action;
  if (action.type === "change") return `${name[action.counter]} ${action.delta > 0 ? "+1" : "-1"}`;
  if (action.type === "completeRow") return `한 단 완료 · 코수 ${action.stitch === "reset" ? "초기화" : "유지"}`;
  if (action.type === "setValue") return `${name[action.counter]} 직접 수정`;
  if (action.type === "setTarget") return `${name[action.counter]} 목표 수정`;
  return "직전 변경 실행 취소";
}

function EditForms({
  counter, current, target, disabled, onAction,
}: {
  counter: CounterType;
  current: number;
  target: number | null;
  disabled: boolean;
  onAction: (action: CounterAction) => void;
}) {
  const [value, setValue] = useState(String(current));
  const [goal, setGoal] = useState(target === null ? "" : String(target));
  const [error, setError] = useState("");

  function saveValue(event: FormEvent) {
    event.preventDefault();
    const parsed = Number(value);
    if (value.trim() === "" || !isNonNegativeInteger(parsed)) { setError("현재 값은 0 이상의 정수로 입력해 주세요."); return; }
    setError("");
    onAction({ type: "setValue", counter, value: parsed });
  }
  function saveTarget(event: FormEvent) {
    event.preventDefault();
    const parsed = goal.trim() === "" ? null : Number(goal);
    if (parsed !== null && (!isNonNegativeInteger(parsed) || parsed === 0)) { setError("목표는 1 이상의 정수로 입력하거나 비워 주세요."); return; }
    setError("");
    onAction({ type: "setTarget", counter, value: parsed });
  }
  return (
    <section className="quick-edit" aria-label={`${name[counter]} 값과 목표 수정`}>
      <h2>값과 목표 수정</h2>
      <form onSubmit={saveValue}>
        <label htmlFor="quick-current">현재 {name[counter]}</label>
        <div className="quick-edit-row"><input id="quick-current" type="number" inputMode="numeric" min="0" step="1" value={value} onChange={(e) => setValue(e.target.value)} /><button type="submit" disabled={disabled}>현재 값 저장</button></div>
      </form>
      <form onSubmit={saveTarget}>
        <label htmlFor="quick-target">목표 {name[counter]} <span>(비우면 목표 없음)</span></label>
        <div className="quick-edit-row"><input id="quick-target" type="number" inputMode="numeric" min="1" step="1" value={goal} onChange={(e) => setGoal(e.target.value)} /><button type="submit" disabled={disabled}>목표 저장</button></div>
      </form>
      {error && <p className="quick-error" role="alert">{error}</p>}
    </section>
  );
}

export function CounterWorkspace({ state, events, canEdit, onAction, footerText, confirmedRevision }: {
  state: CounterState;
  events: CounterEvent[];
  canEdit: boolean;
  onAction: (action: CounterAction) => void;
  footerText: string;
  confirmedRevision?: number;
}) {
  const [selected, setSelected] = useState<CounterType>("stitch");
  const [rowPrompt, setRowPrompt] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const rowButtonRef = useRef<HTMLButtonElement>(null);
  const resetButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (rowPrompt && dialog && !dialog.open) {
      dialog.showModal();
      resetButtonRef.current?.focus();
    }
    if (!rowPrompt && dialog?.open) dialog.close();
  }, [rowPrompt]);
  const undoTarget = lastUndoableEvent(events);
  const lastChange = lastCounterChange(events, selected);
  const value = state[selected];

  return (
    <>
        <div className="quick-tabs" role="tablist" aria-label="카운터 선택">
          {(["stitch", "row"] as const).map((counter) => <button key={counter} id={`quick-tab-${counter}`} type="button" role="tab" tabIndex={selected === counter ? 0 : -1} aria-selected={selected === counter} aria-controls="quick-counter-panel" onClick={() => setSelected(counter)} onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault();
            const next = event.key === "Home" ? "stitch" : event.key === "End" ? "row" : counter === "stitch" ? "row" : "stitch";
            setSelected(next);
            document.getElementById(`quick-tab-${next}`)?.focus();
          }}>{name[counter]}</button>)}
        </div>
        <section className="quick-counter" id="quick-counter-panel" role="tabpanel" aria-labelledby={`quick-tab-${selected}`}>
          <p className="quick-counter-label">현재 {name[selected]}</p>
          <output className="quick-number" aria-label={`현재 ${name[selected]} ${value?.current ?? 0}`}>{value?.current ?? 0}</output>
          <div className="quick-stitch-line" aria-hidden="true"><span>✳</span></div>
          {selected === "row" && <p className="quick-other-count">현재 코수 <strong>{state.stitch.current}</strong></p>}
          <p className="quick-target">목표 {name[selected]} <strong>{value?.target === null ? "미설정" : value?.target}</strong></p>
          <div className="quick-last-change" aria-label={`마지막 ${name[selected]} 변경 정보`}>
            {lastChange ? <>
              <p><span aria-hidden="true">◷</span> 마지막 {name[selected]} 변경 <time dateTime={lastChange.occurredAt}>{dateTime(lastChange.occurredAt)}</time></p>
              <p><span aria-hidden="true">↗</span> 직전 변경 <strong>{changeText(lastChange, selected)}</strong></p>
            </> : <p>아직 카운트 기록이 없어요.</p>}
          </div>
          <div className="quick-actions">
            <button className="quick-minus" type="button" disabled={!canEdit || (value?.current ?? 0) === 0} onClick={() => { onAction({ type: "change", counter: selected, delta: -1 }); }} aria-label={`${name[selected]} 1 감소`}>−1</button>
            {selected === "row" ? (
              <button ref={rowButtonRef} className="quick-plus quick-plus-row" type="button" disabled={!canEdit} onClick={() => setRowPrompt(true)}>다음 단으로 +1</button>
            ) : (
              <button className="quick-plus" type="button" disabled={!canEdit} onClick={() => { onAction({ type: "change", counter: "stitch", delta: 1 }); }} aria-label="코수 1 증가">+1</button>
            )}
          </div>
        </section>
        <div className="quick-utility"><span>{footerText}</span><button type="button" disabled={!canEdit || !undoTarget} onClick={() => undoTarget && onAction({ type: "undo", eventId: undoTarget.eventId })}>직전 변경 실행 취소</button></div>
        <section className="quick-history" aria-label="최근 변경 기록">
          <h2>최근 변경 기록</h2>
          {events.length === 0 ? <p className="quick-empty">아직 변경 기록이 없습니다.</p> : <ol reversed>{events.slice(-10).reverse().map((event) => <li key={event.eventId}><div className="quick-history-head"><strong>{eventLabel(event)}{confirmedRevision !== undefined && event.after.revision > confirmedRevision && <small className="server-unconfirmed"> · 서버 확인 대기</small>}</strong><time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time></div><span>코수 {event.before.stitch.current} → {event.after.stitch.current} · 단수 {event.before.row.current} → {event.after.row.current}</span>{event.action.type === "setTarget" && <span>목표 {name[event.action.counter]} {event.before[event.action.counter].target ?? "없음"} → {event.after[event.action.counter].target ?? "없음"}</span>}</li>)}</ol>}
        </section>
        <EditForms key={`${selected}-${state.revision}`} counter={selected} current={value?.current ?? 0} target={value?.target ?? null} disabled={!canEdit} onAction={(action) => { onAction(action); }} />
      <dialog ref={dialogRef} className="quick-dialog" onClose={() => { setRowPrompt(false); rowButtonRef.current?.focus(); }} onCancel={() => setRowPrompt(false)} aria-labelledby="row-dialog-title" aria-describedby="row-dialog-description">
        <div className="quick-dialog-mark" aria-hidden="true">✳</div>
        <h2 id="row-dialog-title">한 단을 완료했나요?</h2>
        <p id="row-dialog-description">다음 단으로 넘어가기 전에 현재 코수를 어떻게 처리할지 선택해 주세요.</p>
        <p className="quick-row-preview">{state.row.current ?? 0}단 <span aria-hidden="true">→</span> {(state.row.current ?? 0) + 1}단</p>
        <div className="quick-dialog-actions">
          <button ref={resetButtonRef} className="quick-choice quick-choice-reset" type="button" onClick={() => { setRowPrompt(false); onAction({ type: "completeRow", stitch: "reset" }); }}><strong>코수 0으로 초기화</strong><small>다음 단에서 코수를 0으로 시작해요.</small></button>
          <button className="quick-choice quick-choice-keep" type="button" onClick={() => { setRowPrompt(false); onAction({ type: "completeRow", stitch: "keep" }); }}><strong>현재 코수 유지</strong><small>지금 코수 {state.stitch.current ?? 0}을 그대로 유지해요.</small></button>
          <button className="quick-choice-cancel" type="button" onClick={() => setRowPrompt(false)}>취소</button>
        </div>
      </dialog>

    </>
  );
}
