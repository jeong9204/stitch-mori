import { applyCounterCommand, initialCounterState } from "../../domain/counter/engine";
import type { CounterCommand, CounterCommandResult, CounterEvent } from "../../domain/counter/types";
import type { LocalImportSnapshot } from "../import/types";
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
        const request = indexedDB.open(this.databaseName, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("work_items")) db.createObjectStore("work_items", { keyPath: "localWorkItemId" });
          if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
          if (!db.objectStoreNames.contains("counter_events")) {
            const events = db.createObjectStore("counter_events", { keyPath: "eventId" });
            events.createIndex("workItemId", "workItemId");
            events.createIndex("commandId", "commandId", { unique: true });
          }
          if (!db.objectStoreNames.contains("import_snapshots")) db.createObjectStore("import_snapshots", { keyPath: "importId" });
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

  async getQuickIfExists(): Promise<LocalCounterRecord | null> {
    const db = await this.database();
    const tx = db.transaction(["meta", "work_items"], "readonly");
    const done = transactionDone(tx);
    const pointer = await requestResult(tx.objectStore("meta").get(QUICK_POINTER)) as { value: string } | undefined;
    const record = pointer ? await requestResult(tx.objectStore("work_items").get(pointer.value)) as LocalCounterRecord | undefined : undefined;
    await done;
    return record ?? null;
  }

  async getImportSnapshot(importId: string): Promise<LocalImportSnapshot | null> {
    const db = await this.database();
    const tx = db.transaction("import_snapshots", "readonly");
    const done = transactionDone(tx);
    const snapshot = await requestResult(tx.objectStore("import_snapshots").get(importId)) as LocalImportSnapshot | undefined;
    await done;
    return snapshot ?? null;
  }

  /** A write transaction freezes one consistent saved revision before any network request. */
  async beginImport(localWorkItemId: string): Promise<LocalImportSnapshot> {
    const db = await this.database();
    const tx = db.transaction(["work_items", "counter_events", "import_snapshots"], "readwrite");
    const done = transactionDone(tx);
    try {
      const records = tx.objectStore("work_items");
      const record = await requestResult(records.get(localWorkItemId)) as LocalCounterRecord | undefined;
      if (!record) throw new Error("로컬 작업을 찾을 수 없습니다.");
      if (record.importStatus === "imported") throw new Error("이미 계정에 가져온 기록입니다.");
      const snapshots = tx.objectStore("import_snapshots");
      let snapshot = await requestResult(snapshots.get(record.importId)) as LocalImportSnapshot | undefined;
      if (!snapshot) {
        const events = await requestResult(tx.objectStore("counter_events").index("workItemId").getAll(localWorkItemId)) as CounterEvent[];
        events.sort((a, b) => a.after.revision - b.after.revision);
        if (record.state.revision !== events.length) throw new Error("로컬 기록과 변경 이력의 개수가 일치하지 않습니다.");
        snapshot = { importId: record.importId, localWorkItemId, state: record.state, events };
        snapshots.add(snapshot);
      }
      if (snapshot.localWorkItemId !== localWorkItemId) throw new Error("가져오기 기록의 작업 ID가 일치하지 않습니다.");
      records.put({ ...record, importStatus: "importing" });
      await done;
      return snapshot;
    } catch (error) {
      try { tx.abort(); } catch { /* Already settled. */ }
      void done.catch(() => undefined);
      throw error;
    }
  }

  async finishImport(snapshot: LocalImportSnapshot, userId: string, serverWorkItemId: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction("work_items", "readwrite");
    const done = transactionDone(tx);
    try {
      const records = tx.objectStore("work_items");
      const record = await requestResult(records.get(snapshot.localWorkItemId)) as LocalCounterRecord | undefined;
      if (!record || record.importId !== snapshot.importId || record.state.revision < snapshot.state.revision) {
        throw new Error("로컬 기록 연결 정보를 확인할 수 없습니다.");
      }
      if (record.importedByUserId && record.importedByUserId !== userId) throw new Error("다른 계정에 연결된 로컬 기록입니다.");
      if (record.serverWorkItemId && record.serverWorkItemId !== serverWorkItemId) throw new Error("서버 작업 연결이 일치하지 않습니다.");
      records.put({ ...record, importStatus: "imported", importedByUserId: userId, importedRevision: snapshot.state.revision, serverWorkItemId });
      await done;
    } catch (error) {
      try { tx.abort(); } catch { /* Already settled. */ }
      void done.catch(() => undefined);
      throw error;
    }
  }

  async releaseImport(localWorkItemId: string): Promise<void> {
    const db = await this.database();
    const tx = db.transaction("work_items", "readwrite");
    const done = transactionDone(tx);
    const records = tx.objectStore("work_items");
    const record = await requestResult(records.get(localWorkItemId)) as LocalCounterRecord | undefined;
    if (record?.importStatus === "importing") records.put({ ...record, importStatus: "failed" });
    await done;
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
      if (record.importStatus === "importing") throw new Error("계정으로 가져오는 동안에는 카운터 조작을 잠시 멈춰 주세요.");
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
