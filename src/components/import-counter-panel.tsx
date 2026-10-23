"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CounterImportService } from "@/data/import/import-service";
import { SupabaseImportStore, type AccountWorkItemSummary } from "@/data/import/supabase-import-store";
import type { LocalImportSnapshot } from "@/data/import/types";
import { quickCounterStore } from "@/data/local/quick-session";
import { hasPendingQuickTab } from "@/data/local/quick-import-guard";
import type { LocalCounterRecord } from "@/data/local/types";
import { lastCountOccurredAt } from "@/domain/counter/engine";
import { createClient } from "@/lib/supabase/client";

function displayTime(value: string | null): string {
  return value ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "아직 없음";
}

export function ImportCounterPanel({ userId, email }: { userId: string; email: string }) {
  const router = useRouter();
  const [client] = useState(createClient);
  const [remote] = useState(() => new SupabaseImportStore(client));
  const [service] = useState(() => new CounterImportService(quickCounterStore, remote));
  const [record, setRecord] = useState<LocalCounterRecord | null>(null);
  const [eventsCount, setEventsCount] = useState(0);
  const [lastCount, setLastCount] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<LocalImportSnapshot | null>(null);
  const [accountItems, setAccountItems] = useState<AccountWorkItemSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "importing" | "error">("loading");
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState<"refresh" | "import">("refresh");
  const [authorized, setAuthorized] = useState(true);

  const refresh = useCallback(async () => {
    const local = await quickCounterStore.getQuickIfExists();
    const events = local ? await quickCounterStore.getEvents(local.localWorkItemId) : [];
    const frozen = local ? await quickCounterStore.getImportSnapshot(local.importId) : null;
    setRecord(local);
    setEventsCount(events.length);
    setLastCount(lastCountOccurredAt(events));
    setSnapshot(frozen);
    setAccountItems(await remote.listWorkItems());
  }, [remote]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      void refresh().then(() => { if (active) setStatus("ready"); }).catch((cause: unknown) => {
        if (active) { setErrorAction("refresh"); setError(cause instanceof Error ? cause.message : "기록을 불러오지 못했습니다."); setStatus("error"); }
      });
    });
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && session?.user.id !== userId)) {
        setAuthorized(false);
        router.replace("/login");
        router.refresh();
      }
    });
    const linked=()=>{if(active)void refresh().then(()=>{if(active)setStatus("ready");}).catch(()=>{});};
    window.addEventListener("stitchmori-counter-imported",linked);
    return () => { active = false; data.subscription.unsubscribe(); window.removeEventListener("stitchmori-counter-imported",linked); };
  }, [client, refresh, router, userId]);

  async function importNow() {
    if (!record || status === "importing") return;
    setError("");
    let imported = false;
    try {
      const { data } = await client.auth.getClaims();
      if (data?.claims?.sub !== userId) throw new Error("로그인 계정이 바뀌었습니다. 다시 로그인해 주세요.");
      if (await hasPendingQuickTab()) throw new Error("저장되지 않은 카운터 변경이 있습니다. 로컬 저장이 끝난 뒤 다시 시도해 주세요.");
      setStatus("importing");
      const channel = new BroadcastChannel("stitchmori-import-v1");
      channel.postMessage({ type: "import-start" });
      try {
        await service.import(record.localWorkItemId, userId);
        imported = true;
      } finally {
        channel.postMessage({ type: "import-end" });
        channel.close();
      }
      await refresh();
      setStatus("ready");
    } catch (cause) {
      setErrorAction(imported ? "refresh" : "import");
      setError(cause instanceof Error ? cause.message : "가져오기에 실패했습니다.");
      if (!imported) {
        try {
          const local = await quickCounterStore.getQuickIfExists();
          setRecord(local);
          if (local) setSnapshot(await quickCounterStore.getImportSnapshot(local.importId));
        } catch { /* Keep the actionable import error. */ }
      }
      setStatus("error");
    }
  }

  if (!authorized) return <p role="status">계정 상태를 확인하고 있습니다.</p>;
  const connectedToThisAccount = record?.importStatus === "imported" && record.importedByUserId === userId;
  const connectedToOtherAccount = record?.importStatus === "imported" && record.importedByUserId !== userId;
  const otherItems = accountItems.filter((item) => !connectedToThisAccount || item.id !== record?.serverWorkItemId);
  const selectedAccount = otherItems.find((item) => item.id === selectedAccountId);

  return (
    <div className="import-page">
      <header className="import-heading">
        <p className="eyebrow">내 기록 연결하기</p>
        <h1>로컬 기록을 계정에 보관할까요?</h1>
        <p>{email && <><strong>{email}</strong> 계정으로 로그인했어요. </>}가져오기를 선택하기 전까지 이 기기의 기록은 서버에 전송되지 않습니다.</p>
      </header>
      {status === "loading" && <p className="notice" role="status">로컬 기록과 계정 작업을 확인하고 있어요.</p>}
      {status === "importing" && <p className="notice" role="status" aria-live="polite">계정에 저장하는 중입니다. 완료될 때까지 간편 카운터 조작을 잠시 멈춰 주세요.</p>}
      {error && <div className="quick-error-box" role="alert"><strong>{errorAction === "import" ? "가져오기를 완료하지 못했어요." : "기록을 새로 확인하지 못했어요."}</strong><p>{error}</p><p>{errorAction === "import" ? "로컬 원본과 처음 저장한 가져오기 스냅샷은 남아 있습니다. 같은 기록으로 다시 시도할 수 있어요." : "로컬 원본은 이 기기에 남아 있습니다. 다시 불러와 주세요."}</p><button type="button" onClick={() => {
        if (errorAction === "import") void importNow();
        else void refresh().then(() => { setError(""); setStatus("ready"); }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "기록을 불러오지 못했습니다."));
      }} disabled={status === "importing"}>다시 시도</button></div>}
      {record && <section className="import-card" aria-label="이 기기의 간편 기록">
        <div className="import-card-head"><div><p className="eyebrow">이 기기의 간편 기록</p><h2>로컬 카운터</h2></div><span className="coming-soon">이 기기에 저장됨</span></div>
        <div className="import-stats"><div><span>현재 코수</span><strong>{record.state.stitch.current}</strong></div><div><span>완료한 단수</span><strong>{record.state.row.current}</strong></div></div>
        <dl className="import-facts"><div><dt>마지막 카운트</dt><dd>{displayTime(lastCount)}</dd></div><div><dt>변경 이력</dt><dd>{eventsCount}건</dd></div></dl>
        {snapshot && record.state.revision > snapshot.state.revision && <p className="notice">처음 가져오기 시점 이후 {record.state.revision - snapshot.state.revision}건의 로컬 변경은 이번 가져오기 스냅샷에 포함되지 않습니다.</p>}
        {connectedToThisAccount ? <p className="import-connected">이 계정의 작업에 보관됨 · 서버 작업 ID {record.serverWorkItemId}<br />이후 간편 카운터 변경은 자동 동기화되지 않습니다.<br /><Link className="text-link" href={`/account/${record.serverWorkItemId}`}>계정 카운터 이어하기 →</Link></p>
          : connectedToOtherAccount ? <p className="notice">이 로컬 기록은 다른 계정에 이미 연결되어 있습니다. 현재 계정으로 자동 복사하지 않습니다.</p>
            : <div className="import-actions"><button className="button" type="button" onClick={() => { void importNow(); }} disabled={status === "importing" || status === "loading"}>계정으로 가져오기</button><Link className="button button-secondary" href="/">지금은 건너뛰기</Link></div>}
      </section>}
      {!record && status === "ready" && <section className="import-card"><h2>이 기기의 간편 기록이 없어요</h2><p>간편 카운터는 로그인 없이 시작할 수 있습니다.</p><Link className="button" href="/quick">간편 카운터 사용하기</Link></section>}
      <section className="import-card" aria-label="계정의 기존 작업">
        <p className="eyebrow">계정에 이미 있는 기록</p><h2>기존 계정 작업</h2>
        {otherItems.length === 0 ? <p>현재 계정에 별도로 저장된 작업이 없습니다.</p> : <ul className="account-items">{otherItems.map((item) => <li key={item.id}><button type="button" aria-pressed={selectedAccountId === item.id} onClick={() => setSelectedAccountId(item.id)}><strong>코수 {item.stitch} · 단수 {item.row}</strong><span>{displayTime(item.createdAt)} 저장 · 변경 {item.revision}건</span></button></li>)}</ul>}
        {selectedAccount && <p className="import-selection">선택한 계정 기록: 코수 {selectedAccount.stitch}, 단수 {selectedAccount.row}. <Link className="text-link" href={`/account/${selectedAccount.id}`}>이 작업에서 이어하기 →</Link></p>}
        <p className="import-note">기존 계정 작업을 덮어쓰지 않습니다. 가져온 기록은 별도 작업으로 보관됩니다.</p>
      </section>
      <div className="import-actions import-footer"><Link className="button button-secondary" href="/quick">로컬 간편 카운터 계속 사용</Link><Link className="text-link" href="/account">계정 작업 목록</Link><Link className="text-link" href="/">홈으로 돌아가기</Link></div>
    </div>
  );
}
