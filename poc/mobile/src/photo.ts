import type { Photo } from './model';
export const digest=async(bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes)))].map(x=>x.toString(16).padStart(2,'0')).join('');
export function signature(bytes:Uint8Array){
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if([137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))return 'image/png';
  if(String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
  throw new Error('JPEG·PNG·WebP 사진만 지원합니다.');
}
async function decode(blob:Blob){
  if(typeof createImageBitmap==='function'){try{const bitmap=await createImageBitmap(blob,{imageOrientation:'from-image'});return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close()};}catch{/* HTML image fallback */}}
  const url=URL.createObjectURL(blob),image=new Image();try{await new Promise<void>((ok,no)=>{image.onload=()=>ok();image.onerror=()=>no(new Error('손상되거나 지원하지 않는 사진입니다.'));image.src=url;});return {source:image,width:image.naturalWidth,height:image.naturalHeight,close:()=>URL.revokeObjectURL(url)};}catch(e){URL.revokeObjectURL(url);throw e;}
}
export async function preparePhoto(file:File):Promise<Photo>{
  if(!file.size||file.size>10*1024*1024)throw new Error('사진은 10MiB 이하로 선택해 주세요.');
  signature(new Uint8Array(await file.slice(0,12).arrayBuffer()));const image=await decode(file);
  try{
    if(!image.width||!image.height||image.width*image.height>40_000_000)throw new Error('사진은 4천만 화소 이하로 선택해 주세요.');
    const ratio=Math.min(1,1600/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('사진 최적화를 사용할 수 없습니다.');ctx.fillStyle='#f7f1e8';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image.source,0,0,canvas.width,canvas.height);
    const blob=await new Promise<Blob>((ok,no)=>canvas.toBlob(b=>b?ok(b):no(new Error('사진 변환 실패')),'image/jpeg',.8));if(blob.size>2*1024*1024)throw new Error('최적화 사진이 2MiB를 초과합니다.');
    return{blob,width:canvas.width,height:canvas.height,sha256:await digest(new Uint8Array(await blob.arrayBuffer()))};
  }finally{image.close();}
}
export async function verifyPhoto(photo:Photo){
  const bytes=new Uint8Array(await photo.blob.arrayBuffer());if(signature(bytes)!=='image/jpeg'||await digest(bytes)!==photo.sha256)throw new Error('사진 해시·형식이 일치하지 않습니다.');
  if(typeof document!=='undefined'){const image=await decode(photo.blob);try{if(image.width!==photo.width||image.height!==photo.height)throw new Error('사진 크기가 다릅니다.');}finally{image.close();}}
}
