import type { CounterCommand } from "../../domain/counter/types";

export interface PendingServerCommand {
  id: number;
  userId: string;
  workItemId: string;
  command: CounterCommand;
}

export interface ServerCommandQueue {
  deviceId(): Promise<string>;
  pending(userId: string, workItemId: string): Promise<PendingServerCommand[]>;
  add(userId: string, workItemId: string, command: CounterCommand): Promise<PendingServerCommand>;
  remove(id: number): Promise<void>;
  clear(userId: string, workItemId: string): Promise<void>;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("로컬 대기 명령 저장에 실패했습니다."));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("로컬 대기 명령 저장에 실패했습니다."));
    tx.onerror = () => reject(tx.error ?? new Error("로컬 대기 명령 저장에 실패했습니다."));
  });
}

/** Account-scoped durable outbox. A command is written here before its RPC starts. */
export class IndexedDbServerCommandQueue implements ServerCommandQueue {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly databaseName = "stitchmori-server-commands-v1") {}

  private database(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB를 사용할 수 없습니다.")); return; }
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          const commands = db.createObjectStore("commands", { keyPath: "id", autoIncrement: true });
          commands.createIndex("ownerWork", ["userId", "workItemId"]);
          db.createObjectStore("meta", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB를 열 수 없습니다."));
      }).catch((error: unknown) => { this.dbPromise = null; throw error; });
    }
    return this.dbPromise;
  }

  async deviceId(): Promise<string> {
    const db = await this.database();
    const tx = db.transaction("meta", "readwrite");
    const complete = done(tx);
    const store = tx.objectStore("meta");
    const existing = await result(store.get("deviceId")) as { key: string; value: string } | undefined;
    const value = existing?.value ?? crypto.randomUUID();
    if (!existing) store.add({ key: "deviceId", value });
    await complete;
    return value;
  }

  async pending(userId: string, workItemId: string): Promise<PendingServerCommand[]> {
    const db = await this.database();
    const tx = db.transaction("commands", "readonly");
    const complete = done(tx);
    const records = await result(tx.objectStore("commands").index("ownerWork").getAll([userId, workItemId])) as PendingServerCommand[];
    await complete;
    return records.sort((a, b) => a.id - b.id);
  }

  async add(userId: string, workItemId: string, command: CounterCommand): Promise<PendingServerCommand> {
    if (command.workItemId !== workItemId) throw new Error("대기 명령의 작업 ID가 일치하지 않습니다.");
    const db = await this.database();
    const tx = db.transaction("commands", "readwrite");
    const complete = done(tx);
    const id = await result(tx.objectStore("commands").add({ userId, workItemId, command })) as number;
    await complete;
    return { id, userId, workItemId, command };
  }

  async remove(id: number): Promise<void> {
    const db = await this.database();
    const tx = db.transaction("commands", "readwrite");
    const complete = done(tx);
    tx.objectStore("commands").delete(id);
    await complete;
  }

  async clear(userId: string, workItemId: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction("commands", "readwrite");
    const complete = done(tx);
    const store = tx.objectStore("commands");
    const keys = await result(store.index("ownerWork").getAllKeys([userId, workItemId]));
    for (const key of keys) store.delete(key);
    await complete;
  }
}
