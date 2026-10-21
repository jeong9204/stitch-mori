"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { quickCounterSession, quickCounterStore } from "@/data/local/quick-session";
import { TimerCard } from "@/components/timer-card";
import { localTimer } from "@/data/timer/timer-runtime";
import { CounterWorkspace } from "@/components/counter-workspace";

export default function QuickPage() {
  const session = quickCounterSession;
  const { record, events, status, error, pendingCount } = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getServerSnapshot);
  const [importLocked, setImportLocked] = useState(false);
  const [releaseError, setReleaseError] = useState("");

  useEffect(() => { queueMicrotask(() => { void session.load(); }); }, [session]);
  useEffect(() => {
    const channel = new BroadcastChannel("stitchmori-import-v1");
    channel.onmessage = (message: MessageEvent<{ type?: string; nonce?: string }>) => {
      if (message.data.type === "status-request") {
        const view = session.getSnapshot();
        channel.postMessage({ type: "status-response", nonce: message.data.nonce, status: view.status, pendingCount: view.pendingCount });
      }
      if (message.data.type === "import-start") setImportLocked(true);
      if (message.data.type === "import-end") {
        setImportLocked(false);
        void session.load();
      }
    };
    return () => channel.close();
  }, [session]);
  const canEdit = Boolean(record && !importLocked && record.importStatus !== "importing" && (status === "saved" || status === "pending"));

  return (
    <div className="quick-page">
      <div className="quick-heading">
        <Link className="quick-back" href="/" aria-label="홈으로 돌아가기">←</Link>
        <div><p className="eyebrow">로그인 없이 사용</p><h1>간편 카운터</h1></div>
      </div>
      <div className={`quick-status quick-status--${status}`} role="status" aria-live="polite">
        <span className="quick-status-dot" aria-hidden="true" />
        {status === "loading" ? "로컬 기록 불러오는 중" : status === "pending" ? `저장 중 · 대기 ${pendingCount}건` : status === "saved" ? "이 기기에 저장됨" : "저장 실패 · 기록 유실 위험"}
      </div>
      {(importLocked || record?.importStatus === "importing") && <p className="notice" role="status">계정으로 가져오는 동안 카운터 조작을 잠시 멈췄어요. 가져오기 화면에서 결과를 확인해 주세요.</p>}
      {record?.importStatus === "importing" && !importLocked && <div className="quick-import-recovery"><Link className="text-link" href="/import">가져오기 결과 확인</Link><button type="button" onClick={() => {
        void quickCounterStore.releaseImport(record.localWorkItemId).then(() => session.load()).catch((cause: unknown) => setReleaseError(cause instanceof Error ? cause.message : "로컬 기록 잠금을 해제하지 못했습니다."));
      }}>가져오기 중단 후 로컬 기록 계속</button><p>이미 서버에 보관된 스냅샷이 있을 수 있습니다. 이후 입력은 자동 동기화되지 않습니다.</p></div>}
      {releaseError && <p className="quick-error" role="alert">{releaseError}</p>}
      {error && <div className="quick-error-box" role="alert"><strong>로컬 기록을 저장하지 못했어요.</strong><p>{error}</p>{status === "failed" && <p>저장 대기: {pendingCount}건</p>}<button type="button" onClick={() => { void session.retry(); }} disabled={status === "pending"}>다시 시도</button></div>}
      {record && <p className="quick-convert-link"><Link className="button button-secondary" href="/convert/quick">프로젝트로 전환</Link></p>}
      {record && <CounterWorkspace state={record.state} events={events} canEdit={canEdit}
        timer={<TimerCard controller={localTimer(record.localWorkItemId,record.state.revision-pendingCount)} />}
        onAction={(action) => { session.enqueue(action); }}
        footerText={record.importStatus === "imported" ? "가져온 이후의 입력은 이 기기에만 저장돼요." : "기록은 이 브라우저에만 보관됩니다."} />}
    </div>
  );
}
