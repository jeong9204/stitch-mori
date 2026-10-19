import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

// The page can display account identity and must never be served from a shared cache.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  let email: string | undefined;
  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    email = typeof data?.claims.email === "string" ? data.claims.email : undefined;
  }

  return (
    <div className="page-stack home-page">
      <section className="hero home-intro">
        <p className="eyebrow">나의 뜨개 작업실</p>
        <h1>한 코씩, 오늘의 이야기를 쌓아요.</h1>
        <p>지금 필요한 코수와 단수를 간편하게 기록해 보세요.</p>
      </section>
      <section aria-label="시작 메뉴" className="home-actions">
        <Link className="home-quick-link" href="/quick">
          <span className="home-quick-kicker">로그인 없이 바로 시작</span>
          <span className="home-quick-title">간편 카운터 <span aria-hidden="true">↗</span></span>
          <span className="home-quick-copy">지금 바로 카운트를 시작해요.</span>
          <span className="home-quick-decoration" aria-hidden="true">✳</span>
        </Link>
        <article className="home-project-card">
          <div>
            <p className="eyebrow">다음에 만나요</p>
            <h2>프로젝트 관리</h2>
            <p>프로젝트 목록과 작업 파트는 준비 중이에요. 간편 카운터는 지금 사용할 수 있습니다.</p>
          </div>
          <span className="coming-soon">Phase 2 준비 중</span>
          {!email && <Link className="text-link" href="/login">이메일로 로그인하기 <span aria-hidden="true">→</span></Link>}
        </article>
      </section>
      <section className="account-panel" aria-label="계정 상태">
        {email ? (
          <><span>{email} 계정으로 로그인됨</span><SignOutButton /></>
        ) : (
          <span>간편 기록은 현재 기기의 브라우저에 저장됩니다.</span>
        )}
      </section>
      {!hasSupabaseEnv() && (
        <p className="notice" role="status">Supabase 환경변수가 없어 이메일 로그인은 현재 사용할 수 없습니다.</p>
      )}
    </div>
  );
}
