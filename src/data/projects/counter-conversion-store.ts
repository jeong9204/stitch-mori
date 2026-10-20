import type { SupabaseClient } from "@supabase/supabase-js";
export type CounterProjectLink = { projectId:string;partId:string;projectName:string;deleted:boolean };
export type ConversionResult = {status:"converted"|"duplicate";projectId:string;partId:string;workItemId:string;revision:number}
  | {status:"conflict";latestRevision:number};
export interface CounterConversionRemote {
  convert(workItemId:string,requestId:string,expectedRevision:number,name:string):Promise<ConversionResult>;
}
export class CounterConversionStore implements CounterConversionRemote {
  constructor(private readonly client:SupabaseClient) {}
  async link(workItemId:string):Promise<CounterProjectLink|null> {
    const {data,error}=await this.client.rpc("get_counter_project_link",{p_work_item_id:workItemId});if(error)throw new Error(error.message);return data;
  }
  async convert(workItemId:string,requestId:string,expectedRevision:number,name:string):Promise<ConversionResult> {
    const {data,error}=await this.client.rpc("convert_counter_to_project",{p_work_item_id:workItemId,p_request_id:requestId,p_expected_revision:expectedRevision,p_name:name});
    if(error){if(error.code==="22023")throw new Error("이미 프로젝트에 연결됐거나 전환 요청을 확인할 수 없습니다. 최신 상태를 확인해 주세요.");if(error.code==="P0002")throw new Error("이 계정의 카운터를 찾을 수 없습니다.");throw new Error(error.message);}
    if(!data||!["converted","duplicate","conflict"].includes(data.status))throw new Error("전환 응답이 올바르지 않습니다.");
    if(data.status!=="conflict"&&(data.workItemId!==workItemId||data.revision!==expectedRevision||typeof data.projectId!=="string"||typeof data.partId!=="string"))throw new Error("전환 결과가 원래 카운터와 일치하지 않습니다.");
    return data;
  }
}
