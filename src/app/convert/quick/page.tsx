import Link from "next/link";
import { CounterConversionPanel } from "@/components/counter-conversion-panel";
import { hasSupabaseEnv } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
export const dynamic="force-dynamic";
export default async function QuickConversionPage(){
  let userId:string|undefined;
  if(hasSupabaseEnv()){const client=await createClient();const {data}=await client.auth.getClaims();userId=data?.claims?.sub;}
  return userId?<CounterConversionPanel userId={userId}/>:<section className="simple-page"><h1>프로젝트로 전환하려면 로그인해 주세요</h1><p>로그인만으로 기록을 업로드하지 않습니다. 전환 내용을 확인하고 직접 선택할 수 있습니다.</p><div className="project-form-actions"><Link className="button" href="/login?next=/convert/quick">이메일로 로그인</Link><Link className="button button-secondary" href="/quick">간편 카운터로 돌아가기</Link></div></section>;
}
