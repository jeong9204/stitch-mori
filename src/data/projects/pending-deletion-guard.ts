import type { ServerCommandQueue } from "@/data/remote/server-command-queue";

/** Prevent hiding an account counter while this device still has unsent commands for it. */
export async function assertNoPendingCounterCommands(
  queue: Pick<ServerCommandQueue, "pending">, userId: string, workItemIds: string[],
): Promise<void> {
  for (const workItemId of workItemIds) {
    if ((await queue.pending(userId, workItemId)).length > 0) {
      throw new Error("이 기기에 미확정 카운터 명령이 있습니다. 파트 카운터에서 저장 또는 충돌을 먼저 확인해 주세요.");
    }
  }
}
