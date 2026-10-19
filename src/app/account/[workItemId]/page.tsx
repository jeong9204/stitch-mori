import { redirect } from "next/navigation";
import { ServerCounterPanel } from "@/components/server-counter-panel";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AccountCounterPage({ params }: { params: Promise<{ workItemId: string }> }) {
  if (!hasSupabaseEnv()) redirect("/login");
  const client = await createClient();
  const { data } = await client.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  const { workItemId } = await params;
  return <ServerCounterPanel userId={data.claims.sub} workItemId={workItemId} />;
}
