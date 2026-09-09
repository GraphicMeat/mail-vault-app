// @vitest-environment jsdom
import { describe,it,expect,vi } from 'vitest';
import { createInsightsStore } from '../insightsStore';
import { createInsightsSession } from '../../services/insightsSession';
import { createInsightsWorkerHandler } from '../../workers/insightsWorker';
import { A, B, COUNT_FIXTURE } from '../../../tests/fixtures/insights';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function harness() {
  const result={totals:{received:5,sent:2,both:7},senders:[],days:[],lanes:[]};
  const sessions=[];
  const savePreferences=vi.fn(),cancelSelection=vi.fn();
  const mail={accounts:[{id:'a',email:'me@example.test'}],activeMailbox:'Archive',sortedEmails:[{uid:5}],searchQuery:'project',viewMode:'all'};
  const store=createInsightsStore({
    cancelSelection,
    getAccounts:()=>mail.accounts, getOwnAddresses:()=>({a:['alias@example.test']}),
    getPreferences:()=>({range:'30d',direction:'received'}), savePreferences,
    now:()=>new Date('2026-09-09T12:00:00Z'), timeZone:()=> 'Europe/Vilnius',
    createSession:()=>{ const session={load:vi.fn(async()=>({coverage:{status:'partial',missingHeaders:4}})),query:vi.fn(async()=>result),messages:vi.fn(async()=>[{key:'one'}]),dispose:vi.fn()};sessions.push(session);return session;},
  });
  return {store,mail,result,sessions,savePreferences,cancelSelection};
}
describe('Insights workspace lifecycle',()=>{
  it('opens a complete local snapshot and leaves ordinary mailbox state untouched',async()=>{
    const h=harness(), before=structuredClone(h.mail);
    await h.store.getState().openInsights();
    expect(h.store.getState()).toMatchObject({isOpen:true,status:'ready',result:h.result,coverage:{status:'partial'}});
    expect(h.store.getState().query).toMatchObject({accountIds:['a'],startDate:'2026-08-11',endDate:'2026-09-09',direction:'received'});
    expect(h.sessions[0].load.mock.calls[0][0]).toMatchObject({accountIds:['a'],ownAddressesByAccount:{a:['alias@example.test']}});
    h.store.getState().closeInsights();
    expect(h.sessions[0].dispose).toHaveBeenCalledOnce();expect(h.store.getState().isOpen).toBe(false);expect(h.mail).toEqual(before);
  });
  it('ignores a filter response superseded by a newer query',async()=>{
    const h=harness();await h.store.getState().openInsights();
    const old=deferred();h.sessions[0].query.mockImplementationOnce(()=>old.promise).mockResolvedValueOnce({totals:{sent:9}});
    const first=h.store.getState().setQuery({direction:'sent'});
    await h.store.getState().setQuery({direction:'both'});
    old.resolve({totals:{sent:1}});await first;
    expect(h.store.getState().result.totals.sent).toBe(9);
    expect(h.store.getState().query.direction).toBe('both');
  });
  it('retains successful results but marks them stale after a failed refresh',async()=>{
    const h=harness();await h.store.getState().openInsights();
    const opening=h.store.getState().refresh();h.sessions[1].load.mockRejectedValue(new Error('read failed'));
    // The first load is already in flight; force its existing promise to fail through query.
    h.sessions[1].query.mockRejectedValue(new Error('read failed'));await opening;
    expect(h.store.getState()).toMatchObject({status:'error',result:h.result,coverage:{status:'stale'},error:'read failed'});
  });
  it('does not publish data after the workspace closes during loading',async()=>{
    const h=harness();await h.store.getState().openInsights();
    const pending=deferred();const start=h.store.getState().refresh();h.sessions[1].query.mockImplementation(()=>pending.promise);
    await Promise.resolve();h.store.getState().closeInsights();pending.resolve({totals:{received:999}});await start;
    expect(h.store.getState()).toMatchObject({isOpen:false,status:'idle',result:null});
  });
  it('persists only validated preferences and clears drill-down when filters change',async()=>{
    const h=harness();await h.store.getState().openInsights();
    await h.store.getState().loadMessages({senderAddress:'ana@example.test'});
    expect(h.store.getState().messages).toEqual([{key:'one'}]);
    await h.store.getState().setQuery({direction:'sent',headers:['private'],range:'custom',startDate:'2026-09-01',endDate:'2026-09-09'});
    expect(h.store.getState().messages).toEqual([]);
    const saved=h.savePreferences.mock.calls.at(-1)[0];
    expect(saved).toMatchObject({direction:'sent',range:'custom'});expect(saved).not.toHaveProperty('headers');expect(saved).not.toHaveProperty('result');
  });
  it('releases the previous session and prunes deleted account IDs on refresh',async()=>{
    const h=harness();await h.store.getState().openInsights();h.mail.accounts=[];
    await h.store.getState().refresh();
    expect(h.sessions[0].dispose).toHaveBeenCalledOnce();expect(h.store.getState().query.accountIds).toEqual([]);
  });
});

// Real store -> real session -> real worker/model. Only the native inventory
// and browser worker transport are in-memory boundaries, with controllable I/O.
function integratedHarness() {
  let preferences={range:'30d',direction:'received'};
  let today=new Date('2026-09-09T12:00:00Z');
  let nextInventory=null, nextMessages=null;
  const workers=[];
  const store=createInsightsStore({
    getAccounts:()=>[{id:A,email:'me@example.test'},{id:B,email:'second@example.test'}],
    getOwnAddresses:()=>({[A]:['me@example.test'],[B]:['second@example.test']}),
    getPreferences:()=>preferences,savePreferences:value=>{preferences=value;},
    now:()=>today,timeZone:()=> 'Europe/Vilnius',
    createSession:()=>{
      const inventory=nextInventory;nextInventory=null;
      const listeners=new Map();
      const transport={terminated:false,addEventListener:(type,listener)=>listeners.set(type,listener),
        removeEventListener:type=>listeners.delete(type),terminate(){this.terminated=true;listeners.clear();},
        postMessage:message=>queueMicrotask(()=>handle({data:message})),
      };
      const handle=createInsightsWorkerHandler(reply=>{
        if(reply.type==='messages' && nextMessages){
          const delayed=nextMessages;nextMessages=null;delayed.started.resolve();
          void delayed.promise.then(()=>listeners.get('message')?.({data:reply}));
        } else queueMicrotask(()=>listeners.get('message')?.({data:reply}));
      });
      workers.push(transport);
      return createInsightsSession({workerFactory:()=>transport,api:{
        beginInsightsSnapshot:async()=>({snapshotId:'synthetic-snapshot',inventoryCount:COUNT_FIXTURE.length,coverage:{status:'reading'}}),
        readInsightsPage:async()=>{
          if(inventory){inventory.started.resolve();await inventory.promise;}
          return {rows:COUNT_FIXTURE,nextCursor:null,coverage:{status:'ready'}};
        },
        releaseInsightsSnapshot:async()=>{},
      }});
    },
  });
  const gate=()=>({...deferred(),started:deferred()});
  return {store,workers,advanceDate:value=>{today=new Date(value);},pauseInventory:()=>{nextInventory=gate();return nextInventory;},
    pauseMessages:()=>{nextMessages=gate();return nextMessages;}};
}

describe('Insights selection and loading integration',()=>{
  it('reopens with sender, selected day, and zoom intact while releasing header data on close',async()=>{
    const h=integratedHarness();await h.store.getState().openInsights();
    await h.store.getState().selectSender('ana@example.test');
    await h.store.getState().selectDay('2026-09-09');
    await h.store.getState().setQuery({direction:'both',timelineBucket:'message',senderSort:'name'});
    h.store.getState().closeInsights();
    expect(h.store.getState()).toMatchObject({isOpen:false,result:null,messages:[],coverage:null,
      selectedDay:'2026-09-09',query:{senderAddress:'ana@example.test',timelineBucket:'message',senderSort:'name'}});
    expect(h.workers[0].terminated).toBe(true);
    await h.store.getState().openInsights();
    expect(h.store.getState()).toMatchObject({status:'ready',selectedDay:'2026-09-09',
      result:{totals:{received:2,sent:1,both:3}},query:{senderAddress:'ana@example.test',timelineBucket:'message',senderSort:'name'}});
    h.store.getState().resetSession();
    expect(h.store.getState()).toMatchObject({query:{},selectedDay:null,isOpen:false,result:null});
    await h.store.getState().openInsights();
    expect(h.store.getState().query).toMatchObject({senderAddress:null,timelineBucket:'week'});
    h.store.getState().resetSession();
  });

  it('keeps loading while initial-scan filters change and evaluates only the latest scope afterward',async()=>{
    const h=integratedHarness(), gate=h.pauseInventory();
    const opening=h.store.getState().openInsights();await gate.started.promise;
    try {
      await h.store.getState().setQuery({direction:'sent'});
      await h.store.getState().setQuery({direction:'both',senderAddress:'ana@example.test',timelineBucket:'day'});
      expect(h.store.getState()).toMatchObject({status:'loading',error:null,result:null});
    } finally {gate.resolve();await opening;}
    expect(h.store.getState()).toMatchObject({status:'ready',error:null,result:{totals:{received:2,sent:1,both:3}},
      displayQuery:{direction:'both',senderAddress:'ana@example.test',timelineBucket:'day'}});
    h.store.getState().resetSession();
  });

  it('preserves the old snapshot while refresh filters change without querying an unbuilt replacement',async()=>{
    const h=integratedHarness();await h.store.getState().openInsights();
    const prior=h.store.getState().result, gate=h.pauseInventory();
    const refreshing=h.store.getState().refresh();await gate.started.promise;
    try {
      await h.store.getState().setQuery({range:'custom',startDate:'2026-09-08',endDate:'2026-09-08'});
      expect(h.store.getState()).toMatchObject({status:'loading',error:null,coverage:{status:'stale'}});
      expect(h.store.getState().result).toBe(prior);
    } finally {gate.resolve();await refreshing;}
    expect(h.store.getState()).toMatchObject({status:'ready',result:{totals:{received:0,sent:0,both:0}},
      displayQuery:{startDate:'2026-09-08',endDate:'2026-09-08'}});
    h.store.getState().resetSession();
  });

  it('does not reopen an old drill-down after the user changes tabs',async()=>{
    const h=integratedHarness();await h.store.getState().openInsights();
    const gate=h.pauseMessages(), pending=h.store.getState().loadMessages({senderAddress:'ana@example.test'});
    await gate.started.promise;
    try {
      h.store.getState().setTab('activity');
      expect(h.store.getState()).toMatchObject({tab:'activity',selection:null,messages:[],messagesLoading:false});
    } finally {gate.resolve();await pending;}
    expect(h.store.getState()).toMatchObject({selection:null,messages:[],messagesLoading:false});
    h.store.getState().resetSession();
  });

  it('clears a retained selected day when reopening advances the rolling date range past it',async()=>{
    const h=integratedHarness();await h.store.getState().openInsights();
    await h.store.getState().selectDay('2026-08-11');
    h.store.getState().closeInsights();h.advanceDate('2026-09-10T12:00:00Z');
    await h.store.getState().openInsights();
    expect(h.store.getState()).toMatchObject({selectedDay:null,query:{startDate:'2026-08-12',endDate:'2026-09-10'}});
    h.store.getState().resetSession();
  });
});


it('cancels the previous body read immediately when another date bucket is selected',async()=>{
 const h=harness();await h.store.getState().openInsights();await h.store.getState().loadMessages({startDate:'2026-09-01',endDate:'2026-09-01'});
 h.cancelSelection.mockClear();const next=h.store.getState().loadMessages({startDate:'2026-09-02',endDate:'2026-09-02'});
 expect(h.cancelSelection).toHaveBeenCalledOnce();await next;
});
it('cancels body reads before closing or clearing the workspace',async()=>{
 const h=harness();await h.store.getState().openInsights();h.cancelSelection.mockClear();h.store.getState().closeInsights();expect(h.cancelSelection).toHaveBeenCalledOnce();
});
