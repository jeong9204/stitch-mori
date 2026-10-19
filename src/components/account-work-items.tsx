"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SupabaseImportStore, type AccountWorkItemSummary } from "@/data/import/supabase-import-store";
import { createClient } from "@/lib/supabase/client";

export function AccountWorkItems({ userId }: { userId: string }) {
  const router = useRouter();
  const [client] = useState(createClient);
  const [store] = useState(() => new SupabaseImportStore(client));
  const [items, setItems] = useState<AccountWorkItemSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [authorized, setAuthorized] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { data } = await client.auth.getClaims();
        if (data?.claims?.sub !== userId) throw new Error("로그인 계정을 다시 확인해 주세요.");
        const result = await store.listWorkItems();
        if (active) { setItems(result); setStatus("ready"); setError(""); }
      } catch (cause) {
        if (active) { setStatus("error"); setError(cause instanceof Error ? cause.message : "계정 작업을 불러오지 못했습니다."); }
      }
    }
    void load();
    const { data } = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || (event === "SIGNED_IN" && session?.user.id !== userId)) {
        setAuthorized(false); setItems([]); router.replace("/login"); router.refresh();
      }
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client, router, store, userId]);

  if (!authorized) return <p role="status">계정 상태를 확인하고 있습니다.</p>;
  return <div className="import-page">
    <header className="import-heading"><p className="eyebrow">계정에 저장된 기록</p><h1>내 카운터</h1><p>서버에 저장된 작업을 선택해 이어서 카운트하세요. 이 기기의 간편 카운터는 별도 기록입니다.</p></header>
    {status === "loading" && <p className="notice" role="status">계정 작업을 불러오는 중입니다.</p>}
    {status === "error" && <div className="quick-error-box" role="alert"><p>{error}</p><button type="button" onClick={() => { setStatus("loading"); router.refresh(); void store.listWorkItems().then((result) => { setItems(result); setStatus("ready"); setError(""); }).catch((cause: unknown) => { setStatus("error"); setError(cause instanceof Error ? cause.message : "계정 작업을 불러오지 못했습니다."); }); }}>다시 시도</button></div>}
    {status === "ready" && (items.length === 0 ? <section className="import-card"><h2>아직 계정 작업이 없어요</h2><p>이 기기의 간편 기록을 가져오면 여기에 표시됩니다.</p><Link className="button" href="/import">로컬 기록 확인하기</Link></section>
      : <ul className="server-work-list">{items.map((item) => <li key={item.id}><Link href={`/account/${item.id}`} className="import-card server-work-link"><span className="eyebrow">계정 저장 · 변경 {item.revision}건</span><strong>코수 {item.stitch} · 단수 {item.row}</strong><span>작업 열기 <span aria-hidden="true">→</span></span></Link></li>)}</ul>)}
    <div className="import-actions import-footer"><Link className="button button-secondary" href="/quick">이 기기의 간편 카운터</Link><Link className="text-link" href="/import">로컬 기록 가져오기</Link></div>
  </div>;
}
