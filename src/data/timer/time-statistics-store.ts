import type {SupabaseClient} from '@supabase/supabase-js';
import type {TimeStatistics} from '../../domain/timer/statistics';
export const ACCOUNT_TIME_ZONE='Asia/Seoul';
export async function loadAccountTimeStatistics(client:SupabaseClient,userId:string,projectId?:string,workItemId?:string,offset=0):Promise<TimeStatistics> {
  async function auth(){const {data,error}=await client.auth.getClaims();if(error || data?.claims?.sub!==userId)throw new Error('로그인 계정을 다시 확인해 주세요.');}
  await auth();const {data,error}=await client.rpc('get_work_time_statistics',{p_zone:ACCOUNT_TIME_ZONE,p_project_id:projectId??null,p_work_item_id:workItemId??null,p_offset:offset});
  if(error)throw new Error(error.message);await auth();
  if(!data || !Array.isArray(data.works) || !Array.isArray(data.recent) || data.zone!==ACCOUNT_TIME_ZONE || data.recent.some((s:{userId:string})=>s.userId!==userId))throw new Error('작업 시간 응답을 확인할 수 없습니다.');
  return data;
}
