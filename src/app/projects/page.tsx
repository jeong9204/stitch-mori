import Link from "next/link";
import { redirect } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  if (!hasSupabaseEnv()) redirect("/login");
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect("/login");

  return (
    <section className="simple-page">
      <p className="eyebrow">프로젝트</p>
      <h1>준비 중입니다</h1>
      <p>프로젝트 생성과 관리 기능은 Phase 2에서 구현합니다. 지금은 프로젝트를 만들 수 없습니다.</p>
      <Link className="text-link" href="/">홈으로 돌아가기</Link>
    </section>
  );
}
