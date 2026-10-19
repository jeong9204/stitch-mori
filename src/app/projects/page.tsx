import Link from "next/link";
import { ProjectManager } from "@/components/project-manager";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  let userId: string | undefined;
  if (hasSupabaseEnv()) {
    const supabase = await createClient();
    const { data } = await supabase.auth.getClaims();
    userId = typeof data?.claims?.sub === "string" ? data.claims.sub : undefined;
  }
  if (userId) return <ProjectManager userId={userId} />;
  return <section className="simple-page"><p className="eyebrow">프로젝트</p><h1>로그인 후 프로젝트를 시작하세요</h1><p>프로젝트는 계정에 저장됩니다. 로그인 없이 카운트하려면 간편 카운터를 사용할 수 있어요.</p><div className="project-form-actions"><Link className="button" href="/login">이메일로 로그인하기</Link><Link className="button button-secondary" href="/quick">간편 카운터</Link></div></section>;
}
