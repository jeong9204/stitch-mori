import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseImportStore } from "../../src/data/import/supabase-import-store";
import type { LocalImportSnapshot } from "../../src/data/import/types";
import { initialCounterState } from "../../src/domain/counter/engine";

const snapshot: LocalImportSnapshot = {
  importId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  localWorkItemId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  state: initialCounterState("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), events: [],
};

describe("Supabase import adapter", () => {
  it("submits only the frozen snapshot to the import RPC and maps its receipt", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      status: "imported", importId: snapshot.importId, localWorkItemId: snapshot.localWorkItemId,
      serverWorkItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", importedRevision: 0,
    }, error: null });
    const store = new SupabaseImportStore({ rpc } as unknown as SupabaseClient);
    expect((await store.importSnapshot(snapshot)).status).toBe("imported");
    expect(rpc).toHaveBeenCalledWith("import_counter_snapshot", { p_payload: snapshot });
  });

  it("shows a usable local-language retry message for network failure", async () => {
    const rpc = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(new SupabaseImportStore({ rpc } as unknown as SupabaseClient).importSnapshot(snapshot)).rejects.toThrow("서버 연결에 실패했습니다");
  });

  it("maps a network failure returned by the Supabase client", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "TypeError: Failed to fetch" } });
    await expect(new SupabaseImportStore({ rpc } as unknown as SupabaseClient).importSnapshot(snapshot)).rejects.toThrow("서버 연결에 실패했습니다");
  });

  it("lists owner-scoped work items with their two counters", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", revision: 2, createdAt: "2026-10-19T00:00:00Z", stitch: 4, row: 1,
    }], error: null });
    const store = new SupabaseImportStore({ rpc } as unknown as SupabaseClient);
    expect(await store.listWorkItems()).toEqual([{
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", revision: 2, createdAt: "2026-10-19T00:00:00Z", stitch: 4, row: 1,
    }]);
    expect(rpc).toHaveBeenCalledWith("list_account_counters");
  });
});
