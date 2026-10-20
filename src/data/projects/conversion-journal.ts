export type ConversionIntent = {
  key: string; userId: string; source: string; requestId: string; name: string;
  workItemId: string | null; expectedRevision: number | null; projectId?: string;
};
export interface ConversionJournal {
  get(userId: string, source: string): Promise<ConversionIntent | null>;
  begin(userId: string, source: string, name: string, workItemId: string | null, expectedRevision: number | null): Promise<ConversionIntent>;
  save(intent: ConversionIntent): Promise<void>;
  clear(userId: string, source: string): Promise<void>;
}
function request<T>(req: IDBRequest<T>): Promise<T> { return new Promise((resolve,reject)=>{ req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error); }); }
function done(tx: IDBTransaction): Promise<void> { return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error ?? new Error("전환 상태 저장 실패"));tx.onerror=()=>reject(tx.error);}); }
export class IndexedDbConversionJournal implements ConversionJournal {
  constructor(private readonly databaseName="stitchmori-conversions-v1") {}
  private async database() {
    const req=indexedDB.open(this.databaseName,1);
    req.onupgradeneeded=()=>req.result.createObjectStore("intents",{keyPath:"key"});
    return request(req);
  }
  async get(userId:string,source:string) {
    const db=await this.database();try { const tx=db.transaction("intents","readonly");const complete=done(tx);const item=await request(tx.objectStore("intents").get(`${userId}:${source}`));await complete;return item as ConversionIntent ?? null; } finally {db.close();}
  }
  async begin(userId:string,source:string,name:string,workItemId:string|null,expectedRevision:number|null) {
    const db=await this.database();try { const tx=db.transaction("intents","readwrite");const complete=done(tx);const store=tx.objectStore("intents");const key=`${userId}:${source}`;
      const existing=await request(store.get(key)) as ConversionIntent|undefined;
      const intent=existing ?? {key,userId,source,name,workItemId,expectedRevision,requestId:crypto.randomUUID()};
      if(!existing) store.add(intent);await complete;return intent;
    } finally {db.close();}
  }
  async save(intent:ConversionIntent) {
    const db=await this.database();try {const tx=db.transaction("intents","readwrite");const complete=done(tx);const store=tx.objectStore("intents");const previous=await request(store.get(intent.key)) as ConversionIntent|undefined;
      if(previous?.requestId===intent.requestId) store.put(intent);await complete;
    } finally {db.close();}
  }
  async clear(userId:string,source:string) {const db=await this.database();try {const tx=db.transaction("intents","readwrite");const complete=done(tx);tx.objectStore("intents").delete(`${userId}:${source}`);await complete;}finally{db.close();}}
}
