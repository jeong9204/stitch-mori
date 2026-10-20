"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CounterWorkspace } from "@/components/counter-workspace";
import { IndexedDbServerCommandQueue } from "@/data/remote/server-command-queue";
import { ServerCounterSession } from "@/data/remote/server-counter-session";
import { SupabaseCounterStore } from "@/data/remote/supabase-counter-store";
import type { CounterAction } from "@/domain/counter/types";
import { createClient } from "@/lib/supabase/client";

function actionText(action: CounterAction): string {
  if (action.type === "change") return `${action.counter === "stitch" ? "코수" : "단수"} ${action.delta > 0 ? "+1" : "-1"}`;
  if (action.type === "completeRow") return `단수 완료 · 코수 ${action.stitch === "reset" ? "초기화" : "유지"}`;
  if (action.type === "setValue") return `${action.counter === "stitch" ? "코수" : "단수"} ${action.value}로 수정`;
  if (action.type === "setTarget") return `${action.counter === "stitch" ? "코수" : "단수"} 목표 수정`;
  return "직전 변경 실행 취소";
}

export function ServerCounterPanel({ userId, workItemId, backHref = "/account", title = "계정 카운터", eyebrow = "계정에 저장된 기록", readOnlyReason }: {
  userId: string; workItemId: string; backHref?: string; title?: string; eyebrow?: string; readOnlyReason?: string;
}) {
  const router = useRouter();
  const [client] = useState(createClient);
  const [session] = useState(() => new ServerCounterSession(userId, workItemId,
    new SupabaseCounterStore(client), new IndexedDbServerCommandQueue(), async () => {
      const { data } = await client.auth.getClaims();
      return data?.claims?.sub === userId;
    }));
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);
  const [authorized, setAuthorized] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  const [localError, setLocalError] = useState("");
  const [reviewingRecovery, setReviewingRecovery] = useState(false);
  const recoveryDialogRef = useRef<HTMLDialogElement>(null);
  const recoveryButtonRef = useRef<HTMLButtonElement>(null);
  const discardRef = useRef<HTMLDialogElement>(null);
  const discardButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    queueMicrotask(() => { void session.load(); });
    const { data } = client.auth.onAuthStateChange((event, authSession) => {
      if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && authSession?.user.id !== userId)) {
        setAuthorized(false); session.dispose(); router.replace("/login"); router.refresh();
      }
    });
    return () => data.subscription.unsubscribe();
  }, [client, router, session, userId]);
  useEffect(() => {
    const dialog = discardRef.current;
    if (discarding && dialog && !dialog.open) { dialog.showModal(); discardButtonRef.current?.focus(); }
    if (!discarding && dialog?.open) dialog.close();
  }, [discarding]);

  useEffect(() => {
    const dialog = recoveryDialogRef.current;
    if (reviewingRecovery && dialog && !dialog.open) dialog.showModal();
    if (!reviewingRecovery && dialog?.open) dialog.close();
  }, [reviewingRecovery]);

  if (!authorized) return <p role="status">계정 상태를 확인하고 있습니다.</p>;
  const canEdit = !readOnlyReason && (view.status === "saved" || view.status === "pending" || view.status === "queueing");
  const confirmed = view.confirmed;

  return <div className="quick-page server-counter-page">
    <div className="quick-heading"><Link className="quick-back" href={backHref} aria-label="이전 화면으로 돌아가기">←</Link><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div></div>
    {readOnlyReason && <p className="notice" role="status">{readOnlyReason} <Link href={backHref}>프로젝트로 돌아가기</Link></p>}
    <p className="server-boundary">이 작업은 계정 서버에 저장됩니다. <Link href="/quick">이 기기의 간편 카운터</Link>와는 별도 기록입니다.</p>
    <div className={`quick-status quick-status--${view.status}`} role="status" aria-live="polite">
      <span className="quick-status-dot" aria-hidden="true" />
      {view.status === "loading" ? "서버 기록 불러오는 중" : view.status === "saved" ? `서버 저장 완료 · revision ${confirmed?.revision ?? 0}`
        : view.status === "queueing" ? "이 기기에 대기 명령 저장 중"
          : view.status === "pending" ? `서버 저장 중 · 대기 ${view.pending.length}건`
            : view.status === "conflict" ? `서버 기록 충돌 · 대기 ${view.pending.length}건 보존`
              : confirmed ? `서버 저장 실패 · 대기 ${view.pending.length}건 보존` : "서버 기록 불러오기 실패"}
    </div>
    {confirmed && view.status !== "saved" && <p className="server-confirmed">서버 확정값: 코수 {confirmed.stitch.current} · 단수 {confirmed.row.current} · revision {confirmed.revision}. 화면의 카운터에는 미확정 입력이 포함될 수 있습니다.</p>}
    {view.error && <div className="quick-error-box" role="alert"><strong>{view.status === "conflict" ? "서버 상태가 달라졌어요." : confirmed ? "서버 저장을 확인하지 못했어요." : "이 계정의 서버 기록을 불러오지 못했어요."}</strong><p>{view.error}</p>
      <div className="server-error-actions"><button type="button" onClick={() => { void session.retry(); }}>{view.status === "conflict" ? "최신 서버 상태 확인" : confirmed ? "같은 명령으로 다시 시도" : "다시 불러오기"}</button>
        {view.pending.length > 0 && <button type="button" onClick={() => setDiscarding(true)}>대기 명령 정리</button>}</div></div>}
    {view.recoveryReviewRequired && <div className="notice" role="status"><p>복구된 작업의 대기 명령은 서버 값에 자동 적용하지 않습니다.</p><button ref={recoveryButtonRef} className="button button-secondary" type="button" disabled={!!readOnlyReason} onClick={() => setReviewingRecovery(true)}>복구 후 대기 명령 확인</button></div>}
    {view.status === "conflict" && <p className="notice">대기 명령을 새 revision에 자동 적용하지 않습니다. 아래 목록과 서버 확정값을 확인해 주세요.</p>}
    {view.pending.length > 0 && <section className="server-pending" aria-label="미확정 명령"><h2>이 기기에 보관된 대기 명령 · {view.pending.length}건</h2><ol>{view.pending.map((item) => <li key={item.id}>{actionText(item.command.action)} · 요청 revision {item.command.expectedRevision} · {new Date(item.command.occurredAt).toLocaleString("ko-KR")}</li>)}</ol></section>}
    {localError && <p className="quick-error" role="alert">{localError}</p>}
    {view.display && <CounterWorkspace state={view.display} events={view.events} canEdit={canEdit}
      confirmedRevision={view.confirmedRevision} onAction={(action) => { void session.enqueue(action); }}
      footerText={view.pending.length ? "변경값은 미리보기입니다. 서버 확정 여부를 위에서 확인해 주세요." : "계정 서버에 저장되는 카운터입니다."} />}
    <dialog ref={recoveryDialogRef} className="quick-dialog" aria-labelledby="recovery-queue-title"
      onCancel={() => setReviewingRecovery(false)} onClose={() => { setReviewingRecovery(false); recoveryButtonRef.current?.focus(); }}>
      <h2 id="recovery-queue-title">보관된 명령을 다시 확인할까요?</h2><p>화면의 서버 확정값과 대기 명령을 확인한 뒤 진행해 주세요. 같은 명령 ID로 요청하며, revision이 다르면 적용하지 않습니다.</p>
      <div className="project-form-actions"><button type="button" className="button" onClick={() => { setReviewingRecovery(false); void session.confirmRecoveryRetry(); }}>확인 후 같은 명령 재시도</button><button type="button" className="button button-secondary" autoFocus onClick={() => setReviewingRecovery(false)}>취소</button></div>
    </dialog>
    <dialog ref={discardRef} className="quick-dialog server-discard-dialog" onClose={() => setDiscarding(false)} onCancel={() => setDiscarding(false)} aria-labelledby="discard-title"><h2 id="discard-title">대기 명령을 삭제할까요?</h2><p>서버에 적용되지 않은 입력은 복구할 수 없습니다. 최신 서버 값을 다시 불러옵니다.</p><div className="import-actions"><button ref={discardButtonRef} type="button" className="button" onClick={() => {
      setDiscarding(false); void session.discardPending().catch((cause: unknown) => setLocalError(cause instanceof Error ? cause.message : "대기 명령을 정리하지 못했습니다."));
    }}>대기 명령 삭제</button><button type="button" className="button button-secondary" onClick={() => setDiscarding(false)}>취소</button></div></dialog>
  </div>;
}
