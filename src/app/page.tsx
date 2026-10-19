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
            <p className="eyebrow">계정에 저장</p>
            <h2>프로젝트 관리</h2>
            <p>프로젝트를 만들고 기본 파트의 카운터를 계정에서 이어서 사용하세요.</p>
          </div>
          <Link className="button" href="/projects">프로젝트 관리 열기</Link>
          {!email && <Link className="text-link" href="/login">이메일로 로그인하기 <span aria-hidden="true">→</span></Link>}
        </article>
      </section>
      <section className="account-panel" aria-label="계정 상태">
        {email ? (
          <><span>{email} 계정으로 로그인됨</span><Link className="text-link" href="/account">계정 카운터 이어하기</Link><Link className="text-link" href="/import">로컬 기록 가져오기</Link><SignOutButton /></>
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
