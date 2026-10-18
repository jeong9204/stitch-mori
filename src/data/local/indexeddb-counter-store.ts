import { applyCounterCommand, initialCounterState } from "../../domain/counter/engine";
import type { CounterCommand, CounterCommandResult, CounterEvent } from "../../domain/counter/types";
import type { LocalCounterRecord, LocalCounterStore } from "./types";

const DATABASE_NAME = "stitchmori-local-v1";
const QUICK_POINTER = "quick-work-item";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("로컬 저장소 요청에 실패했습니다."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("로컬 저장을 완료하지 못했습니다."));
    transaction.onerror = () => reject(transaction.error ?? new Error("로컬 저장 중 오류가 발생했습니다."));
  });
}

export class IndexedDbCounterStore implements LocalCounterStore {
  private databasePromise: Promise<IDBDatabase> | null = null;
  constructor(private readonly databaseName = DATABASE_NAME) {}

  private database(): Promise<IDBDatabase> {
    if (!this.databasePromise) {
      this.databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
          reject(new Error("이 브라우저에서는 IndexedDB를 사용할 수 없습니다."));
          return;
        }
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("work_items", { keyPath: "localWorkItemId" });
          db.createObjectStore("meta", { keyPath: "key" });
          const events = db.createObjectStore("counter_events", { keyPath: "eventId" });
          events.createIndex("workItemId", "workItemId");
          events.createIndex("commandId", "commandId", { unique: true });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB를 열 수 없습니다."));
        request.onblocked = () => reject(new Error("다른 탭에서 로컬 저장소를 사용 중입니다. 탭을 닫고 다시 시도해 주세요."));
      }).catch((error) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise!;
  }

  async getOrCreateQuick(): Promise<LocalCounterRecord> {
    const db = await this.database();
    const tx = db.transaction(["meta", "work_items"], "readwrite");
    const done = transactionDone(tx);
    try {
      const pointer = await requestResult(tx.objectStore("meta").get(QUICK_POINTER)) as { key: string; value: string } | undefined;
      if (pointer) {
        const record = await requestResult(tx.objectStore("work_items").get(pointer.value)) as LocalCounterRecord | undefined;
        if (!record) throw new Error("간편 카운터 연결 정보가 손상되었습니다.");
        await done;
        return record;
      }
      const id = crypto.randomUUID();
      const record: LocalCounterRecord = {
        localWorkItemId: id,
        deviceId: crypto.randomUUID(),
        state: initialCounterState(id),
        importId: crypto.randomUUID(),
        importStatus: "local",
        serverWorkItemId: null,
        updatedAt: new Date().toISOString(),
      };
      tx.objectStore("work_items").add(record);
      tx.objectStore("meta").add({ key: QUICK_POINTER, value: id });
      await done;
      return record;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction already finished. */ }
      void done.catch(() => undefined);
      throw error;
    }
  }

  async getEvents(workItemId: string): Promise<CounterEvent[]> {
    const db = await this.database();
    const tx = db.transaction("counter_events", "readonly");
    const done = transactionDone(tx);
    const events = await requestResult(tx.objectStore("counter_events").index("workItemId").getAll(workItemId)) as CounterEvent[];
    await done;
    return events.sort((a, b) => a.after.revision - b.after.revision);
  }

  async applyCommand(command: CounterCommand): Promise<CounterCommandResult> {
    const db = await this.database();
    const tx = db.transaction(["work_items", "counter_events"], "readwrite");
    const done = transactionDone(tx);
    try {
      const records = tx.objectStore("work_items");
      const eventStore = tx.objectStore("counter_events");
      const record = await requestResult(records.get(command.workItemId)) as LocalCounterRecord | undefined;
      if (!record) throw new Error("간편 카운터를 찾을 수 없습니다.");
      const events = await requestResult(eventStore.index("workItemId").getAll(command.workItemId)) as CounterEvent[];
      events.sort((a, b) => a.after.revision - b.after.revision);
      const result = applyCounterCommand(record.state, events, command);
      if (result.status === "applied" && result.event) {
        records.put({ ...record, state: result.state, updatedAt: command.occurredAt });
        eventStore.add(result.event);
      }
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* Transaction already finished. */ }
      void done.catch(() => undefined);
      throw error;
    }
  }
}
