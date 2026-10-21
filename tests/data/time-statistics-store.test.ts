import {it,expect,vi} from 'vitest';
import {loadAccountTimeStatistics} from '../../src/data/timer/time-statistics-store';
const summary={zone:'Asia/Seoul',day:'2026-10-21',serverNow:'2026-10-21T00:00:00Z',works:[],recent:[],hasMore:false};
function client() {return {auth:{getClaims:vi.fn().mockResolvedValue({data:{claims:{sub:'owner'}}})},rpc:vi.fn().mockResolvedValue({data:summary,error:null})};}
it('sends fixed account timezone and project/work filters without fetching event payloads',async()=>{
  const c=client();expect(await loadAccountTimeStatistics(c as never,'owner','project','part',20)).toEqual(summary);
  expect(c.rpc).toHaveBeenCalledWith('get_work_time_statistics',{p_zone:'Asia/Seoul',p_project_id:'project',p_work_item_id:'part',p_offset:20});
});
it('does not return a delayed result after account change',async()=>{
  const c=client();c.auth.getClaims.mockResolvedValueOnce({data:{claims:{sub:'owner'}}}).mockResolvedValueOnce({data:{claims:{sub:'other'}}});
  await expect(loadAccountTimeStatistics(c as never,'owner')).rejects.toThrow('계정');
});
it('reports a network failure and allows a subsequent explicit retry',async()=>{
  const c=client();c.rpc.mockResolvedValueOnce({data:null,error:{message:'network failed'}});
  await expect(loadAccountTimeStatistics(c as never,'owner')).rejects.toThrow('network');expect(await loadAccountTimeStatistics(c as never,'owner')).toEqual(summary);
});
it('rejects another user in the response and does not query under another login',async()=>{
  const c=client();c.rpc.mockResolvedValueOnce({data:{...summary,recent:[{userId:'other'}]},error:null});
  await expect(loadAccountTimeStatistics(c as never,'owner')).rejects.toThrow('응답');
  c.rpc.mockClear();await expect(loadAccountTimeStatistics(c as never,'different')).rejects.toThrow('계정');expect(c.rpc).not.toHaveBeenCalled();
});
