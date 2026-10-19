import Link from "next/link";
import { ProjectDetailView } from "@/components/project-detail-view";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export default async function ProjectDetailPage({ params }: { params: Promise<{ projectId: string }> }) {
  if (!hasSupabaseEnv()) return <section className="simple-page"><h1>로그인이 필요합니다</h1><Link href="/login">이메일로 로그인하기</Link></section>;
  const client = await createClient();
  const { data } = await client.auth.getClaims();
  if (!data?.claims?.sub) return <section className="simple-page"><h1>로그인이 필요합니다</h1><Link href="/login">이메일로 로그인하기</Link></section>;
  const { projectId } = await params;
  return <ProjectDetailView userId={data.claims.sub} projectId={projectId} />;
}
