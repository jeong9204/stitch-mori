import "fake-indexeddb/auto";
import { timerDisplay } from "../../src/components/timer-display";
import { describe,it,expect,vi } from "vitest";
import { accountTimer } from "../../src/data/timer/timer-runtime";
import { TimerController,isCountChange } from "../../src/data/timer/timer-controller";
import { LocalTimerBackend,type TimerContext,type TimerUiBackend,type TimerMode } from "../../src/data/timer/timer-ui-backend";
import { IndexedDbTimerStore } from "../../src/data/timer/indexeddb-timer-store";
import { applyTimerCommand } from "../../src/domain/timer/engine";
import { applyCounterCommand,initialCounterState } from "../../src/domain/counter/engine";
import type { CounterAction,CounterEvent } from "../../src/domain/counter/types";
import type { TimerCommand,TimerEvent,TimerResult,WorkSession } from "../../src/domain/timer/types";
const at="2026-10-20T14:00:00.000Z", work=crypto.randomUUID();
function event(revision=0,action:CounterAction={type:"change",counter:"stitch",delta:1}):CounterEvent {
  const state={...initialCounterState(work),revision};
  const result=applyCounterCommand(state,[],{commandId:crypto.randomUUID(),workItemId:work,expectedRevision:revision,occurredAt:at,deviceId:"test",action});
  if(result.status!=="applied" || !result.event)throw new Error("bad event");return result.event;
}
class Backend implements TimerUiBackend {
  scope="test";workItemId=work;server=false;
  context:TimerContext={mode:"manual",modeRevision:0,activationRevision:0,counterRevision:0,state:null,active:null,activeName:"다른 작업",workName:"테스트 작업",canStart:true,serverNow:at};
  store=new IndexedDbTimerStore(`timer-ui-${crypto.randomUUID()}`);
  events:TimerEvent[]=[]; calls:TimerCommand[]=[];network=false;lostAck=false;releaseFailure=false;
  async load(){return structuredClone(this.context);}
  async pending(){return (await this.store.pending("user"))?.command??null;}
  async send(command:TimerCommand):Promise<TimerResult>{
    this.calls.push(structuredClone(command));await this.store.retain("user",command);
    if(this.network)throw new Error("network failed");
    const result=applyTimerCommand(this.context.state?.sessionId===command.sessionId?this.context.state:null,this.events,command);
    if(result.status==="applied"){
      this.events.push({eventId:command.commandId,command,effectiveAt:command.occurredAt,before:this.context.state,after:result.state});
      this.context.state=result.state;this.context.active=result.state.status==="ended"?null:result.state;
    }
    if(this.lostAck){this.lostAck=false;throw new Error("lost response");}
    if(result.status==="applied"||result.status==="duplicate")await this.store.release("user",command.commandId);
    return result;
  }
  release(id:string){return this.store.release("user",id);}
  async setMode(mode:TimerMode){this.context.mode=mode;this.context.modeRevision++;}
  readMarker(){return this.store.readUi<number>("marker").then(n=>n??0);}
  writeMarker(n:number){return this.store.writeUi("marker",n);}
  async deviceId(){return "test-device";}
}
async function setup(auto=false){const backend=new Backend(),controller=new TimerController(backend,0,()=>at);await controller.load();if(auto)await controller.setMode("auto");return {backend,controller};}
describe("timer UI coordinator",()=>{
  it("keeps the displayed time through failed/lost end acknowledgements and resets only after retry confirms",async()=>{
    let now=at;
    const backend=new Backend(),controller=new TimerController(backend,0,()=>now);
    const display=()=>{const v=controller.getSnapshot();return timerDisplay(v.context?.state,v.pending,controller.elapsed());};
    await controller.load();await controller.action("start");
    now="2026-10-20T14:00:10.000Z";await controller.action("pause");
    expect(display().time).toBe("00:00:10");
    now="2026-10-20T14:00:20.000Z";await controller.action("resume");
    now="2026-10-20T14:00:30.000Z";backend.network=true;await controller.action("end");
    expect(controller.getSnapshot().status).toBe("failed");expect(display().time).toBe("00:00:20");
    const request=controller.getSnapshot().pending!.commandId;
    backend.network=false;backend.lostAck=true;await controller.retry();
    expect(display().lastSessionTime).toBeNull();
    await controller.load();expect(controller.getSnapshot().context?.state?.status).toBe("ended");
    expect(display()).toEqual({time:"00:00:20",lastSessionTime:null});
    await controller.retry();expect(backend.calls.at(-1)?.commandId).toBe(request);
    expect(display()).toEqual({time:"00:00:00",lastSessionTime:"00:00:20"});
    expect(backend.context.state?.accumulatedMs).toBe(20000);
    expect(backend.events).toHaveLength(4);
    await controller.load();expect(display().time).toBe("00:00:00");
    now="2026-10-20T14:01:00.000Z";await controller.action("start");
    expect(display()).toEqual({time:"00:00:00",lastSessionTime:null});
  });

  it("defaults to manual, serializes duplicate clicks, pauses/resumes/ends, then starts a new session",async()=>{
    const {backend,controller}=await setup();expect(controller.getSnapshot().context?.mode).toBe("manual");
    await Promise.all([controller.action("start"),controller.action("start"),controller.action("start")]);
    expect(backend.calls).toHaveLength(1);const first=controller.getSnapshot().context!.state!.sessionId;
    await controller.action("pause");expect(controller.getSnapshot().context?.state?.status).toBe("paused");
    await controller.action("resume");await controller.action("end");expect(controller.getSnapshot().context?.state?.status).toBe("ended");
    await controller.action("start");expect(controller.getSnapshot().context?.state?.sessionId).not.toBe(first);
  });
  it("starts on the first confirmed count exactly once under rapid confirmation events",async()=>{
    const {backend,controller}=await setup(true);await Promise.all([controller.confirmed(event()),controller.confirmed(event(1)),controller.confirmed(event(2))]);
    expect(backend.calls).toHaveLength(1);expect(controller.getSnapshot().context?.state?.status).toBe("running");
  });
  it("never treats targets, unchanged direct values, or another work item as count activity",async()=>{
    const {backend,controller}=await setup(true);
    const target=event(0,{type:"setTarget",counter:"stitch",value:10});expect(isCountChange(target)).toBe(false);
    await controller.confirmed(target);await controller.confirmed(event(0,{type:"setValue",counter:"stitch",value:0}));
    await controller.confirmed({...event(),workItemId:"another"});expect(backend.calls).toHaveLength(0);
  });
  it("does not auto resume paused sessions; an ended session starts fresh on a later count",async()=>{
    const {backend,controller}=await setup(true);await controller.confirmed(event());await controller.action("pause");
    await controller.confirmed(event(1));expect(backend.calls.map(c=>c.action)).toEqual(["start","pause"]);
    await controller.action("end");await controller.confirmed(event(2));expect(backend.calls.at(-1)?.action).toBe("start");
    expect(new Set(backend.calls.filter(c=>c.action==="start").map(c=>c.sessionId)).size).toBe(2);
  });
  it("preserves a failed automatic start and retries with the identical envelope after reopening",async()=>{
    const {backend,controller}=await setup(true);backend.network=true;const count=event();await controller.confirmed(count);
    expect(controller.getSnapshot()).toMatchObject({status:"failed",durable:true,pending:{commandId:count.commandId,sessionId:count.commandId}});
    const reopened=new TimerController(backend,1,()=>at);await reopened.load();expect(backend.calls).toHaveLength(1);
    backend.network=false;await reopened.retry();expect(backend.calls).toHaveLength(2);expect(backend.calls[0]).toEqual(backend.calls[1]);
    expect(reopened.getSnapshot().pending).toBeNull();
  });
  it("does not double-start when an applied response is lost",async()=>{
    const {backend,controller}=await setup(true);backend.lostAck=true;await controller.confirmed(event());await controller.retry();
    expect(backend.events).toHaveLength(1);expect(controller.getSnapshot().context?.state?.revision).toBe(1);
  });
  it("keeps an in-memory stable start when even auto-intent storage fails",async()=>{
    const {backend,controller}=await setup(true);vi.spyOn(backend,"writeMarker").mockRejectedValueOnce(new Error("disk full"));
    const count=event();await controller.confirmed(count);
    expect(controller.getSnapshot()).toMatchObject({status:"failed",durable:false,pending:{commandId:count.commandId}});
    expect(backend.calls).toHaveLength(0);await controller.retry();expect(backend.calls[0].commandId).toBe(count.commandId);
  });
  it("keeps confirmed running state for an offline pause instead of showing it as paused",async()=>{
    const {backend,controller}=await setup();await controller.action("start");backend.network=true;await controller.action("pause");
    expect(controller.getSnapshot()).toMatchObject({status:"failed",context:{state:{status:"running"}},pending:{action:"pause"},durable:true});
    backend.network=false;await controller.retry();expect(controller.getSnapshot().context?.state?.status).toBe("paused");
  });
  it("retains offline end even when context refresh is unavailable",async()=>{
    const {backend,controller}=await setup();await controller.action("start");
    backend.network=true;vi.spyOn(backend,"load").mockRejectedValue(new Error("network failed"));
    await controller.action("end");
    expect(controller.getSnapshot()).toMatchObject({status:"failed",durable:true,pending:{action:"end"},context:{state:{status:"running"}}});
    expect(await backend.pending()).toEqual(controller.getSnapshot().pending);
  });
  it("preserves revision conflicts and releases only on explicit confirmation",async()=>{
    const {backend,controller}=await setup();await controller.action("start");backend.network=true;await controller.action("pause");
    backend.network=false;
    // A second device advanced the session while this client's pause was pending.
    backend.context.state={...backend.context.state!,revision:2};await controller.retry();
    expect(controller.getSnapshot().status).toBe("conflict");expect(await backend.pending()).not.toBeNull();
    await controller.releasePending();expect(await backend.pending()).toBeNull();
  });
  it("does not transmit or clear another work item's pending command",async()=>{
    const {backend,controller}=await setup();const pending:TimerCommand={commandId:crypto.randomUUID(),sessionId:crypto.randomUUID(),workItemId:"other",expectedRevision:0,occurredAt:at,deviceId:"test",action:"start"};
    await backend.store.retain("user",pending);await controller.load();await controller.retry();await controller.releasePending();
    expect(backend.calls).toHaveLength(0);expect(await backend.pending()).toEqual(pending);
  });
  it("blocks automatic/manual start when another work is active or project access is read-only",async()=>{
    const {backend,controller}=await setup(true);backend.context.active={workItemId:"other",status:"paused"} as WorkSession;
    await controller.confirmed(event());await controller.action("start");expect(backend.calls).toHaveLength(0);
    backend.context.active=null;backend.context.canStart=false;await controller.confirmed(event(1));await controller.action("start");expect(backend.calls).toHaveLength(0);
  });
  it("does not publish sensitive state after logout/disposal during an in-flight load",async()=>{
    const {backend,controller}=await setup();let finish!:(context:TimerContext)=>void;
    vi.spyOn(backend,"load").mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const loading=controller.load();controller.dispose();finish(backend.context);await loading;
    expect(controller.getSnapshot().context).toBeNull();
  });
  it("keeps the confirmed mode when preference persistence fails",async()=>{
    const {backend,controller}=await setup();
    vi.spyOn(backend,"setMode").mockRejectedValueOnce(new Error("network failed"));
    await controller.setMode("auto");
    expect(controller.getSnapshot()).toMatchObject({status:"failed",context:{mode:"manual"}});
    await controller.confirmed(event());expect(backend.calls).toHaveLength(0);
    await controller.setMode("auto");expect(controller.getSnapshot().context?.mode).toBe("auto");
  });
  it("does not replace an operation with a stale background refresh",async()=>{
    const {backend,controller}=await setup();let finish!:(context:TimerContext)=>void;
    const stale=structuredClone(backend.context);
    vi.spyOn(backend,"load").mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const refresh=controller.load();
    let save!:()=>void;vi.spyOn(backend,"setMode").mockImplementationOnce(()=>new Promise(resolve=>{save=()=>{backend.context.mode="auto";resolve();};}));
    const changing=controller.setMode("auto");finish(stale);await refresh;
    expect(controller.getSnapshot().status).toBe("saving");save();await changing;
    expect(controller.getSnapshot()).toMatchObject({status:"ready",context:{mode:"auto"}});
  });
  it("ignores an old refresh arriving after a newer setting has finished",async()=>{
    const {backend,controller}=await setup();let finish!:(context:TimerContext)=>void;
    const stale=structuredClone(backend.context);
    vi.spyOn(backend,"load").mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const refresh=controller.load();await controller.setMode("auto");finish(stale);await refresh;
    expect(controller.getSnapshot()).toMatchObject({status:"ready",context:{mode:"auto"}});
  });
  it("clears a cached account controller on logout even after its card unmounts",async()=>{
    const {backend}=await setup();let notify!:(event:string,session:null)=>void;
    const unsubscribe=vi.fn();const user=crypto.randomUUID();
    const client={auth:{onAuthStateChange:vi.fn(callback=>{notify=callback;return {data:{subscription:{unsubscribe}}};}),getClaims:async()=>({data:{claims:{sub:user}}})},rpc:async()=>({data:backend.context,error:null})};
    const controller=accountTimer(client as never,user,work,0);await controller.load();
    expect(controller.getSnapshot().context).not.toBeNull();
    notify("SIGNED_OUT",null);expect(controller.getSnapshot().context).toBeNull();expect(unsubscribe).toHaveBeenCalledOnce();
    const another=accountTimer(client as never,crypto.randomUUID(),work,0);
    expect(another).not.toBe(controller);expect(another.getSnapshot().context).toBeNull();
    notify("SIGNED_OUT",null);
  });
  it("persists local work-scoped mode without changing the counter DB schema",async()=>{
    const name=`timer-mode-${crypto.randomUUID()}`,store=new IndexedDbTimerStore(name);
    const counters={getQuickIfExists:vi.fn().mockResolvedValue({localWorkItemId:work,state:{revision:4}})};
    const local=new LocalTimerBackend(work,store,counters as never);await local.setMode("auto");await store.close();
    const reloaded=new LocalTimerBackend(work,new IndexedDbTimerStore(name),counters as never);
    expect(await reloaded.load()).toMatchObject({mode:"auto",activationRevision:4});
    expect(await new LocalTimerBackend("other",new IndexedDbTimerStore(name),counters as never).load()).toMatchObject({mode:"manual"});
  });
});
