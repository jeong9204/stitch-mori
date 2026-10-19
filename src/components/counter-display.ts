import type { CounterEvent, CounterType } from "@/domain/counter/types";

/** The latest event that actually changed the selected current value. */
export function lastCounterChange(events: readonly CounterEvent[], counter: CounterType): CounterEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.before[counter].current !== event.after[counter].current) return event;
  }
  return null;
}

export function changeText(event: CounterEvent, counter: CounterType): string {
  const before = event.before[counter].current;
  const after = event.after[counter].current;
  const delta = after - before;
  return `${before} → ${after} (${delta > 0 ? "+" : ""}${delta})`;
}
