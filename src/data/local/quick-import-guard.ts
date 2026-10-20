import { quickCounterSession } from "./quick-session";

/** Observe this route and other open quick tabs before freezing a local import. */
export async function hasPendingQuickTab(): Promise<boolean> {
  const current = quickCounterSession.getSnapshot();
  if (current.pendingCount > 0 || current.status === "failed") return true;
  const channel = new BroadcastChannel("stitchmori-import-v1");
  const nonce = crypto.randomUUID();
  let pending = false;
  channel.onmessage = (message: MessageEvent<{ type?: string; nonce?: string; status?: string; pendingCount?: number }>) => {
    if (message.data.type === "status-response" && message.data.nonce === nonce
      && (message.data.pendingCount || message.data.status === "failed")) pending = true;
  };
  channel.postMessage({ type: "status-request", nonce });
  await new Promise((resolve) => setTimeout(resolve, 250));
  channel.close();
  return pending;
}
