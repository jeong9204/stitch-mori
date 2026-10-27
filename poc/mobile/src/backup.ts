import {strFromU8,strToU8,zipSync,unzipSync} from 'fflate';
import {validateSnapshot,type Snapshot} from './model';
import {verifyPhoto} from './photo';
const MAX_ZIP=24*1024*1024,MAX_META=16*1024*1024;
export async function exportZip(snapshot:Snapshot):Promise<Blob>{
  validateSnapshot(snapshot);if(snapshot.photo)await verifyPhoto(snapshot.photo);
  const metadata={format:'stitchmori-storage-poc',version:1,createdAt:new Date().toISOString(),snapshot:{...snapshot,photo:snapshot.photo?{width:snapshot.photo.width,height:snapshot.photo.height,sha256:snapshot.photo.sha256}:null}};
  const json=strToU8(JSON.stringify(metadata));if(json.length>MAX_META)throw new Error('백업 메타데이터 한도(16MiB)를 초과했습니다. 일부만 내보내지 않습니다.');
  const files:Record<string,Uint8Array>={'metadata.json':json};if(snapshot.photo)files['photo.jpg']=new Uint8Array(await snapshot.photo.blob.arrayBuffer());
  const bytes=zipSync(files,{level:0});if(bytes.length>MAX_ZIP)throw new Error('백업은 최대 24MiB입니다.');return new Blob([new Uint8Array(bytes)],{type:'application/zip'});
}
function crc(bytes:Uint8Array){let c=0xffffffff;for(const x of bytes){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
/** Inspect ZIP directory before inflation. Accept only the small, known PoC format, no ZIP64/encryption/descriptors. */
export function readZip(bytes:Uint8Array):Record<string,Uint8Array>{
  if(bytes.length<22||bytes.length>MAX_ZIP)throw new Error('백업 크기 한도는 24MiB입니다.');
  const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),end=bytes.length-22;
  if(d.getUint32(end,true)!==0x06054b50||d.getUint16(end+20,true)!==0||d.getUint16(end+4,true)!==0||d.getUint16(end+6,true)!==0)throw new Error('지원하지 않는 ZIP 형식입니다.');
  const count=d.getUint16(end+10,true),start=d.getUint32(end+16,true),size=d.getUint32(end+12,true);
  if(count<1||count>2||count!==d.getUint16(end+8,true)||start+size!==end)throw new Error('ZIP 디렉터리가 올바르지 않습니다.');
  let at=start;const entries=new Map<string,{size:number;crc:number;from:number;to:number}>();
  for(let i=0;i<count;i++){
    if(at+46>end||d.getUint32(at,true)!==0x02014b50)throw new Error('ZIP 항목이 손상됐습니다.');
    const flags=d.getUint16(at+8,true),method=d.getUint16(at+10,true),compressed=d.getUint32(at+20,true),length=d.getUint32(at+24,true),nameLength=d.getUint16(at+28,true),next=at+46+nameLength+d.getUint16(at+30,true)+d.getUint16(at+32,true),offset=d.getUint32(at+42,true);
    if(next>end||flags&~2048||![0,8].includes(method)||d.getUint16(at+34,true)!==0)throw new Error('ZIP 기능이 지원되지 않습니다.');
    const name=strFromU8(bytes.slice(at+46,at+46+nameLength));
    if(!['metadata.json','photo.jpg'].includes(name)||entries.has(name)||length>(name==='metadata.json'?MAX_META:2*1024*1024)||offset+30>start||d.getUint32(offset,true)!==0x04034b50)throw new Error('ZIP 경로·중복·크기 오류입니다.');
    const localNameLength=d.getUint16(offset+26,true),dataStart=offset+30+localNameLength+d.getUint16(offset+28,true);
    if(d.getUint16(offset+6,true)!==flags||d.getUint16(offset+8,true)!==method||d.getUint32(offset+18,true)!==compressed||d.getUint32(offset+22,true)!==length||dataStart+compressed>start||strFromU8(bytes.slice(offset+30,offset+30+localNameLength))!==name)throw new Error('ZIP 헤더가 일치하지 않습니다.');
    const checksum=d.getUint32(at+16,true);if(d.getUint32(offset+14,true)!==checksum)throw new Error('ZIP 체크섬 헤더가 다릅니다.');
    entries.set(name,{size:length,crc:checksum,from:offset,to:dataStart+compressed});at=next;
  }
  if(at!==end||!entries.has('metadata.json'))throw new Error('백업 항목이 누락됐습니다.');
  const ranges=[...entries.values()].sort((a,b)=>a.from-b.from);if(ranges[0].from!==0||ranges.some((x,i)=>x.to!==(ranges[i+1]?.from??start)))throw new Error('ZIP 데이터 범위가 올바르지 않습니다.');
  const files=unzipSync(bytes,{filter:file=>{const e=entries.get(file.name);if(!e||file.originalSize!==e.size)throw new Error('압축 해제 한도 오류');return true;}});
  for(const [name,e]of entries){if(files[name]?.length!==e.size||crc(files[name])!==e.crc)throw new Error('백업 파일 무결성 오류입니다.');}return files;
}
export async function importZip(blob:Blob):Promise<Snapshot>{
  if(blob.size>MAX_ZIP)throw new Error('백업은 24MiB 이하만 지원합니다.');
  const files=readZip(new Uint8Array(await blob.arrayBuffer()));const data=JSON.parse(strFromU8(files['metadata.json']));
  if(data?.format!=='stitchmori-storage-poc'||data.version!==1||!data.snapshot||!Number.isFinite(Date.parse(data.createdAt)))throw new Error('StitchMori PoC 백업 v1이 아닙니다.');
  const photo=data.snapshot.photo;if(Boolean(photo)!==Boolean(files['photo.jpg']))throw new Error('사진 파일 연결이 올바르지 않습니다.');
  const snapshot={...data.snapshot,photo:photo?{...photo,blob:new Blob([new Uint8Array(files['photo.jpg'])],{type:'image/jpeg'})}:null};
  validateSnapshot(snapshot);if(snapshot.photo)await verifyPhoto(snapshot.photo);return snapshot;
}
