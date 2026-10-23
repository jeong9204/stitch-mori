import {ImportTimerPanel} from "@/components/import-timer-panel";
import { redirect } from "next/navigation";
import { ImportCounterPanel } from "@/components/import-counter-panel";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  if (!hasSupabaseEnv()) redirect("/login");
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  return <><ImportCounterPanel userId={data.claims.sub} email={typeof data.claims.email === "string" ? data.claims.email : ""} /><ImportTimerPanel userId={data.claims.sub}/></>;
}
