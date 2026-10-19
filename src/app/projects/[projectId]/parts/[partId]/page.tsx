import { notFound, redirect } from "next/navigation";
import { ServerCounterPanel } from "@/components/server-counter-panel";
import type { ProjectDetail } from "@/data/projects/project-part-store";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export default async function ProjectPartCounterPage({ params }: { params: Promise<{ projectId: string; partId: string }> }) {
  if (!hasSupabaseEnv()) redirect("/login");
  const client = await createClient();
  const { data } = await client.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  const { projectId, partId } = await params;
  const result = await client.rpc("get_project_detail", { p_project_id: projectId });
  if (result.error || !result.data) notFound();
  const detail = result.data as ProjectDetail;
  const part = detail.parts.find((item) => item.id === partId);
  if (!part) notFound();
  return <ServerCounterPanel userId={data.claims.sub} workItemId={part.workItemId}
    backHref={`/projects/${projectId}`} title={part.name} eyebrow={detail.name}
    readOnlyReason={detail.status === "active" ? undefined : "카운트하려면 프로젝트 상태를 진행 중으로 변경해 주세요."} />;
}
