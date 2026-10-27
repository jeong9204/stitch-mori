import {Capacitor} from '@capacitor/core';
import {Directory,Filesystem} from '@capacitor/filesystem';
import {Share} from '@capacitor/share';
/** Native sharing is not proof that the user saved an external backup. */
export async function saveBackup(blob:Blob){
  const name=`stitchmori-poc-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;
  if(Capacitor.isNativePlatform()){
    const bytes=new Uint8Array(await blob.arrayBuffer());let raw='';for(let at=0;at<bytes.length;at+=32768)raw+=String.fromCharCode(...bytes.slice(at,at+32768));
    const file=await Filesystem.writeFile({path:name,directory:Directory.Cache,data:btoa(raw)});
    await Share.share({title:'StitchMori PoC 백업',files:[file.uri],dialogTitle:'앱 외부에 백업 파일 저장'});
    // Keep the temporary file until a later run: receivers may read asynchronously.
    return '공유 요청을 마쳤어요. 파일 앱에서 ZIP이 저장됐는지 확인해 주세요. 앱 캐시의 파일은 외부 백업이 아닙니다.';
  }
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
  return '다운로드를 요청했어요. 실제 파일 저장 여부를 확인해 주세요.';
}
