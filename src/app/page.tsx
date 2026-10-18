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
    <div className="page-stack">
      <section className="hero">
        <p className="eyebrow">한 코씩 쌓이는 나의 뜨개 이야기</p>
        <h1>StitchMori</h1>
        <p>뜨개 작업을 위한 카운터와 프로젝트 공간을 준비하고 있어요.</p>
      </section>
      <section className="card-grid" aria-label="시작 메뉴">
        <article className="card">
          <h2>간편 카운터</h2>
          <p>로그인 없이 사용할 수 있는 카운터가 다음 단계에서 제공됩니다.</p>
          <Link className="button" href="/quick">준비 상태 보기</Link>
        </article>
        <article className="card">
          <h2>프로젝트 관리</h2>
          <p>프로젝트 기능은 로그인 후 제공될 예정입니다.</p>
          <Link className="button button-secondary" href={email ? "/projects" : "/login"}>
            {email ? "준비 상태 보기" : "로그인하기"}
          </Link>
        </article>
      </section>
      <section className="account-panel">
        {email ? (
          <><span>{email} 계정으로 로그인됨</span><SignOutButton /></>
        ) : (
          <span>로그인하지 않아도 간편 카운터를 이용할 수 있도록 준비 중입니다.</span>
        )}
      </section>
      {!hasSupabaseEnv() && (
        <p className="notice" role="status">Supabase 환경변수가 없어 이메일 로그인은 현재 사용할 수 없습니다.</p>
      )}
    </div>
  );
}
