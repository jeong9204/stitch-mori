import { redirect } from "next/navigation";
import { AccountWorkItems } from "@/components/account-work-items";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  if (!hasSupabaseEnv()) redirect("/login");
  const client = await createClient();
  const { data } = await client.auth.getClaims();
  if (!data?.claims?.sub) redirect("/login");
  return <AccountWorkItems userId={data.claims.sub} />;
}
