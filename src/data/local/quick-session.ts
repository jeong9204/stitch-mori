import { IndexedDbCounterStore } from "./indexeddb-counter-store";
import { QuickCounterSession } from "./quick-counter-session";

/** Shared across client routes so an in-flight quick write remains observable after navigation. */
export const quickCounterStore = new IndexedDbCounterStore();
export const quickCounterSession = new QuickCounterSession(quickCounterStore);
