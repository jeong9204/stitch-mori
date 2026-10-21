import "fake-indexeddb/auto";
import {describe,it,expect,vi} from "vitest";
import {QuickCounterSession} from "../../src/data/local/quick-counter-session";
import {IndexedDbCounterStore} from "../../src/data/local/indexeddb-counter-store";
import {IndexedDbServerCommandQueue} from "../../src/data/remote/server-command-queue";
import {ServerCounterSession} from "../../src/data/remote/server-counter-session";
import {initialCounterState,applyCounterCommand} from "../../src/domain/counter/engine";
import type {CounterEvent,CounterCommand} from "../../src/domain/counter/types";
const plus={type:"change",counter:"stitch",delta:1} as const;
describe("counter persistence boundary for timer observers",()=>{
  it("does not notify for a failed local save; retries notify only after persistence",async()=>{
    const store=new IndexedDbCounterStore(`confirmation-${crypto.randomUUID()}`), original=store.applyCommand.bind(store),observer=vi.fn();
    const apply=vi.spyOn(store,"applyCommand").mockRejectedValueOnce(new Error("disk full")).mockImplementation(original);
    const session=new QuickCounterSession(store,undefined,undefined,observer);await session.load();
    session.enqueue(plus);await session.whenSettled();expect(observer).not.toHaveBeenCalled();
    await session.retry();expect(observer).toHaveBeenCalledTimes(1);expect(apply).toHaveBeenCalledTimes(2);
    expect((await store.getQuickIfExists())?.state.stitch.current).toBe(1);
  });
  it("timer observer failure never changes a successful local count into a failed count",async()=>{
    const store=new IndexedDbCounterStore(`confirmation-${crypto.randomUUID()}`);
    const session=new QuickCounterSession(store,undefined,undefined,()=>{throw new Error("timer failed");});
    await session.load();session.enqueue(plus);await session.whenSettled();expect(session.getSnapshot().status).toBe("saved");
  });
  it("server optimistic counts do not notify; only confirmed responses do, with no rollback on timer failure",async()=>{
    const work=crypto.randomUUID();let state=initialCounterState(work);const events:CounterEvent[]=[];let failing=true;
    const remote={getWorkItem:async()=>state,getEvents:async()=>structuredClone(events),createWorkItem:async()=>state,applyCommand:vi.fn(async (command:CounterCommand)=>{
      if(failing)throw new Error("network failed");const applied=applyCounterCommand(state,events,command);
      if(applied.status!=="applied"||!applied.event)throw new Error("bad");state=applied.state;events.push(applied.event);
      return {...applied,revision:state.revision,latestRevision:state.revision};
    })};
    const observer=vi.fn().mockRejectedValue(new Error("timer failed"));
    const session=new ServerCounterSession("user",work,remote,new IndexedDbServerCommandQueue(`confirmation-${crypto.randomUUID()}`),async()=>true,undefined,undefined,observer);
    await session.load();await session.enqueue(plus);await session.whenSettled();expect(observer).not.toHaveBeenCalled();
    failing=false;await session.retry();await session.whenSettled();expect(observer).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().status).toBe("saved");expect(state.stitch.current).toBe(1);
  });
});
