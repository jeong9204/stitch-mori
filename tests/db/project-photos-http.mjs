// Local-only integration test. Uses isolated users and removes only its own fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import sharp from 'sharp';
const env=Object.fromEntries(readFileSync('.env.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')];}));
const url=env.NEXT_PUBLIC_SUPABASE_URL,key=env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,app=process.env.PHOTO_TEST_APP_URL??'http://127.0.0.1:3001';
assert.match(url,/^http:\/\/(127\.0\.0\.1|localhost):54321$/);assert.match(app,/^http:\/\/(127\.0\.0\.1|localhost):300[01]$/);
const admin=createClient(url,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});const users=[];
async function auth(){const jar=[];const client=createServerClient(url,key,{cookies:{getAll:()=>jar,setAll:changes=>{for(const cookie of changes){const i=jar.findIndex(c=>c.name===cookie.name);if(i>=0)jar.splice(i,1);jar.push({name:cookie.name,value:cookie.value});}}}});const email=`photo-http-${randomUUID()}@example.test`;assert.ifError((await client.auth.signInWithOtp({email})).error);let token;
 for(let i=0;i<30&&!token;i++){const mails=await(await fetch('http://127.0.0.1:54324/api/v1/messages')).json();token=mails.messages.find(m=>m.To.some(t=>t.Address===email))?.Snippet.match(/\b\d{6}\b/)?.[0];if(!token)await new Promise(r=>setTimeout(r,200));}
 assert.ok(token);const result=await client.auth.verifyOtp({email,token,type:'email'});assert.ifError(result.error);users.push(result.data.user.id);return{client,id:result.data.user.id,cookie:()=>jar.map(c=>`${c.name}=${encodeURIComponent(c.value)}`).join('; ')};}
async function rpc(client,name,args){const r=await client.rpc(name,args);assert.ifError(r.error);return r.data;}
function sql(query){return new Promise((resolve,reject)=>{const p=spawn('docker',['exec','-i','supabase_db_stitch-mori','psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],{stdio:['pipe','pipe','pipe']});let err='';p.stdout.resume();p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',c=>c===0?resolve():reject(new Error(err)));p.stdin.end(query);});}
try{
 const a=await auth(),b=await auth();const project=await rpc(a.client,'create_project',{p_request_id:randomUUID(),p_name:'사진 HTTP 검증 전용',p_notes:null});const base=`${app}/api/projects/${project.id}/photo`;
 const get=(owner=a)=>fetch(base,{headers:{cookie:owner.cookie()}});
 const send=(requestId,revision,body,method='POST',owner=a)=>fetch(base,{method,headers:{origin:app,cookie:owner.cookie(),'x-photo-request-id':requestId,'x-project-revision':String(revision),'content-type':'application/octet-stream'},body:method==='POST'?body:undefined});
 assert.equal((await fetch(base)).status,401);assert.equal((await get(b)).status,404);
 assert.equal((await fetch(base,{method:'POST',headers:{cookie:a.cookie()}})).status,403);
 assert.equal((await get()).status,200);assert.equal((await(await get()).json()).photo,null);
 const png=await sharp({create:{width:2200,height:1100,channels:3,background:'#e8a6b7'}}).withMetadata({orientation:6}).png().toBuffer();const request=randomUUID();
 let response=await send(request,0,png);let result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.status,'committed');
 const saved=await(await get()).json();assert.equal(saved.photo.id,result.photoId);assert.ok(saved.photo.width<=1600);assert.ok(saved.photo.height<=1600);
 const image=`${base}/image?photo=${saved.photo.id}`;response=await fetch(image,{headers:{cookie:a.cookie()}});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'private, no-store');const metadata=await sharp(Buffer.from(await response.arrayBuffer())).metadata();assert.equal(metadata.format,'webp');assert.equal(metadata.exif,undefined);
 assert.equal((await fetch(image,{headers:{cookie:b.cookie()}})).status,404);assert.equal((await fetch(image)).status,401);
 const ph=(await admin.from('project_photos').select('object_path').eq('id',saved.photo.id).single()).data;
 assert.ok((await b.client.storage.from('project-photos').download(ph.object_path)).error);
 assert.ok((await a.client.storage.from('project-photos').update(ph.object_path,png,{contentType:'image/webp'})).error);
 assert.ok((await a.client.storage.from('project-photos').upload(`${a.id}/${project.id}/${randomUUID()}.webp`,png,{contentType:'image/webp'})).error);
 await a.client.storage.from('project-photos').remove([ph.object_path]);assert.ifError((await a.client.storage.from('project-photos').download(ph.object_path)).error);
 // Ignore the first successful reply, then resend the exact request.
 response=await send(request,0,png);result=await response.json();assert.equal(response.status,200);assert.equal(result.duplicate,true);assert.equal(result.photoId,saved.photo.id);
 const changed=await sharp({create:{width:120,height:240,channels:3,background:'#b7c9b0'}}).webp().toBuffer();
 const competing=await Promise.all([send(randomUUID(),1,changed),send(randomUUID(),1,png)]);assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);for(const r of competing)await r.arrayBuffer();
 const winner=await(await get()).json();assert.equal(winner.revision,2);
 for(const data of [Buffer.from('fake JPEG'),Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')])assert.equal((await send(randomUUID(),2,data)).status,400);
 assert.equal((await send(randomUUID(),2,Buffer.alloc(10*1024*1024+1))).status,413);
 const streamed=new ReadableStream({start(c){c.enqueue(png);c.enqueue(new Uint8Array(10*1024*1024));c.close();}});
 assert.equal((await fetch(base,{method:'POST',duplex:'half',headers:{origin:app,cookie:a.cookie(),'x-photo-request-id':randomUUID(),'x-project-revision':'2'},body:streamed})).status,413);
 assert.equal((await(await get()).json()).photo.id,winner.photo.id);
 assert.equal((await send(randomUUID(),2,changed,'POST',b)).status,404);
 assert.equal((await send(randomUUID(),1,changed)).status,409);assert.equal((await(await get()).json()).photo.id,winner.photo.id);
 await rpc(a.client,'delete_project',{p_project_id:project.id,p_expected_revision:2});assert.equal((await get()).status,404);assert.ok((await a.client.storage.from('project-photos').download((await admin.from('project_photos').select('object_path').eq('id',winner.photo.id).single()).data.object_path)).error);
 await rpc(a.client,'restore_project',{p_project_id:project.id,p_request_id:randomUUID(),p_expected_revision:3});const restored=await(await get()).json();assert.equal(restored.photo.id,winner.photo.id);assert.equal(restored.revision,4);
 const deletion=randomUUID();response=await send(deletion,4,undefined,'DELETE');result=await response.json();assert.equal(response.status,200);assert.equal(result.status,'committed');assert.equal((await(await get()).json()).photo,null);
 assert.equal((await(await send(deletion,4,undefined,'DELETE')).json()).duplicate,true);
 assert.equal((await fetch(`${base}/image?photo=${winner.photo.id}`,{headers:{cookie:a.cookie()}})).status,404);
 const parts=await rpc(a.client,'get_project_detail',{p_project_id:project.id});assert.equal(parts.parts.length,1);assert.equal(parts.parts[0].stitch,0);
 console.log('PASS photo HTTP: OTP auth, upload/resize/EXIF stripping, private reads, direct Storage write denial, response-loss retry, concurrent replacements, invalid/oversized input, revision/ownership guards, soft delete/restore, delete retry, preserved counters.');
}finally{
 if(users.length){const {data:photos,error}=await admin.from('project_photos').select('object_path').in('user_id',users);assert.ifError(error);if(photos.length)assert.ifError((await admin.storage.from('project-photos').remove(photos.map(p=>p.object_path))).error);
 const ids=users.map(id=>`'${id}'`).join(',');await sql(`begin;
 update public.projects set cover_photo_id=null where user_id in (${ids});delete from public.project_photo_changes where user_id in (${ids});delete from public.project_photos where user_id in (${ids});
 delete from public.project_recovery_commands where user_id in (${ids});delete from public.project_parts where user_id in (${ids});delete from public.projects where user_id in (${ids});delete from public.counters where work_item_id in(select id from public.work_items where user_id in (${ids}));delete from public.work_items where user_id in (${ids});delete from auth.users where id in (${ids});commit;`);}
}
