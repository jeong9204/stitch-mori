import { redirect } from "next/navigation";
import { CounterConversionPanel } from "@/components/counter-conversion-panel";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
export const dynamic="force-dynamic";
export default async function AccountConversionPage({params}:{params:Promise<{workItemId:string}>}){
  if(!hasSupabaseEnv())redirect("/login");const client=await createClient();const {data}=await client.auth.getClaims();if(!data?.claims?.sub)redirect("/login");
  const {workItemId}=await params;return <CounterConversionPanel userId={data.claims.sub} workItemId={workItemId}/>;
}
