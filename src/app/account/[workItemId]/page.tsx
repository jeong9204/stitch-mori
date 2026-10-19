import { notFound, redirect } from "next/navigation";
import { ServerCounterPanel } from "@/components/server-counter-panel";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type LinkedProject = { name: string; status: "active" | "paused" | "completed" };
export default async function AccountCounterPage({ params }: { params: Promise<{ workItemId: string }> }) {
  if (!hasSupabaseEnv()) redirect("/login");
  const client = await createClient();
  const { data } = await client.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  const { workItemId } = await params;
  // RLS hides another user's work item and any soft-deleted project part.
  const work = await client.from("work_items").select("id").eq("id", workItemId).maybeSingle();
  if (work.error || !work.data) notFound();
  const linked = await client.from("project_parts")
    .select("id,name,project_id,projects(name,status)").eq("work_item_id", workItemId).maybeSingle();
  if (linked.error) notFound();
  const part = linked.data;
  const project = part?.projects as LinkedProject | null | undefined;
  return <ServerCounterPanel userId={data.claims.sub} workItemId={workItemId}
    backHref={part ? `/projects/${part.project_id}` : "/account"}
    title={part?.name ?? "계정 카운터"} eyebrow={project?.name ?? "계정에 저장된 기록"}
    readOnlyReason={project && project.status !== "active" ? "카운트하려면 프로젝트 상태를 진행 중으로 변경해 주세요." : undefined} />;
}
