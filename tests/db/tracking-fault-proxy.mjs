// Local-only test fixture. Never logs credentials; only tracking request identities/results.
// Start: node tests/db/tracking-fault-proxy.mjs
// Control /tmp/stitchmori-tracking-fault-mode.txt: pass | offline | lose_response | hold
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const control=process.env.TRACKING_FAULT_FILE??'/tmp/stitchmori-tracking-fault-mode.txt';
const report=process.env.TRACKING_FAULT_REPORT??'/tmp/stitchmori-tracking-fault-report.json';
const logs=[];
const mode=()=>{try{return readFileSync(control,'utf8').trim();}catch{return 'pass';}};
const server=http.createServer(async(req,res)=>{
  if(!req.url?.startsWith('/')||req.url.startsWith('//')){res.writeHead(400).end();return;}
  const tracking=req.method==='POST'&&req.url.split('?')[0]==='/rest/v1/rpc/apply_project_tracking_command';
  let body;
  if(tracking){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=Buffer.concat(chunks);}
  const selected=tracking?mode():'pass';
  let entry;
  if(tracking){const parsed=JSON.parse(body.toString());entry={requestId:parsed.p_request_id,projectId:parsed.p_project_id,expectedRevision:parsed.p_expected_revision,action:parsed.p_action,mode:selected,status:null};logs.push(entry);writeFileSync(report,JSON.stringify(logs,null,2));}
  if(selected==='offline'){res.destroy();return;}
  if(selected==='hold'){for(let i=0;i<120&&mode()==='hold';i++)await new Promise(r=>setTimeout(r,250));}
  const upstream=http.request({hostname:'127.0.0.1',port:54321,path:req.url,method:req.method,headers:{...req.headers,host:'127.0.0.1:54321'}},response=>{
    if(!tracking){res.writeHead(response.statusCode??502,response.headers);response.pipe(res);return;}
    const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>{
      const content=Buffer.concat(chunks);try{entry.status=JSON.parse(content.toString()).status??`HTTP ${response.statusCode}`;}catch{entry.status=`HTTP ${response.statusCode}`;}writeFileSync(report,JSON.stringify(logs,null,2));
      if(selected==='lose_response'){res.destroy();return;}
      if(!res.destroyed){res.writeHead(response.statusCode??502,response.headers);res.end(content);}
    });
  });
  upstream.on('error',()=>{if(!res.destroyed){res.writeHead(503,{'access-control-allow-origin':'*'}).end('local test proxy upstream unavailable');}});
  if(tracking)upstream.end(body);else req.pipe(upstream);
});
server.listen(54325,'127.0.0.1',()=>console.log('Local tracking fault proxy: 127.0.0.1:54325 -> 127.0.0.1:54321 (credentials are not logged)'));
