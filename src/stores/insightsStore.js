import { create } from 'zustand';
import { useMailStore } from './mailStore';
import { useSettingsStore } from './settingsStore';
import * as api from '../services/insightsApi';
import { createInsightsSession } from '../services/insightsSession';
import { cancelInsightsSelection } from '../services/workflows/selectEmail';
import { normalizeInsightsPreferences, insightsDateRange } from '../utils/insights/preferences';

const defaults = {
  cancelSelection: cancelInsightsSelection,
  getAccounts: () => useMailStore.getState().accounts,
  getOwnAddresses: () => Object.fromEntries(Object.entries(useSettingsStore.getState().sendAsAddresses || {}).map(([id, address]) => [id, [address]])),
  getPreferences: () => useSettingsStore.getState().insightsPreferences,
  savePreferences: value => useSettingsStore.getState().setInsightsPreferences(value),
  now: () => new Date(), timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  createSession: () => createInsightsSession({api, workerFactory: () => new Worker(new URL('../workers/insightsWorker.js', import.meta.url), {type:'module'})}),
};
const initial = () => ({isOpen:false,tab:'map',query:{},preferences:normalizeInsightsPreferences(),status:'idle',progress:null,coverage:null,result:null,displayQuery:null,selectedDay:null,selection:null,messages:[],messagesLoading:false,detailOpen:false,error:null});

/** Only UI preferences are persisted. Headers and native handles live in this session. */
export function createInsightsStore(options = {}) {
  const deps = {...defaults,...options};
  let session = null, loadingSession = null, generation = 0, queryGeneration = 0, messageGeneration = 0;
  return create((set,get) => {
    const clearDetail = () => { deps.cancelSelection(); ++messageGeneration; set({messages:[],selection:null,messagesLoading:false,detailOpen:false}); };
    const configure = candidate => {
      const accounts = deps.getAccounts();
      const preferences = normalizeInsightsPreferences(candidate, accounts.map(a=>a.id));
      const query = {...get().query,...insightsDateRange(preferences,deps.now(),deps.timeZone()),
        accountIds:preferences.accountIds || accounts.map(a=>a.id),timeZone:deps.timeZone(),direction:preferences.direction,
        hideAutomated:preferences.hideAutomated,senderAddress:get().query.senderAddress || null,timelineBucket:get().query.timelineBucket || 'week',senderSort:get().query.senderSort || 'recent'};
      const selectedDay=get().selectedDay;
      set({preferences,tab:preferences.tab,query,
        selectedDay:selectedDay && selectedDay>=query.startDate && selectedDay<=query.endDate?selectedDay:null});
      return {accounts,preferences,query};
    };
    const runQuery = async () => {
      if (!session || !get().isOpen || loadingSession===session) return;
      const id=++queryGeneration, current=session, query={...get().query};
      set({status:'querying',error:null});
      try {
        const result=await current.query(query);
        if(id!==queryGeneration || current!==session || !get().isOpen) return;
        set({result,displayQuery:query,status:'ready'});
      } catch(error) {
        if(id!==queryGeneration || current!==session || error.name==='AbortError') return;
        set({status:'error',error:error.message,coverage:{...get().coverage,status:get().result?'stale':'error'}});
      }
    };
    return {...initial(),
      async openInsights() {
        if(get().isOpen) return;
        configure(deps.getPreferences());set({isOpen:true});await get().refresh();
      },
      closeInsights() {
        deps.cancelSelection();
        ++generation; ++queryGeneration; ++messageGeneration;
        session?.dispose();session=null;loadingSession=null;
        // A workspace visit ends the header/worker lifetime, not the user's
        // in-memory sender, day, zoom, or sort selection.
        set({isOpen:false,status:'idle',progress:null,coverage:null,result:null,displayQuery:null,
          selection:null,messages:[],messagesLoading:false,detailOpen:false,error:null});
      },
      resetSession() { get().closeInsights();set(initial()); },
      async refresh() {
        if(!get().isOpen) return;
        const id=++generation; ++queryGeneration;clearDetail();
        session?.dispose();session=deps.createSession();const current=session;loadingSession=current;
        const {accounts,query}=configure(get().preferences);
        set({status:'loading',error:null,progress:null,coverage:get().coverage?{...get().coverage,status:'stale'}:null});
        try {
          const {coverage}=await current.load({accountIds:query.accountIds,accounts,ownAddressesByAccount:deps.getOwnAddresses(),
            onProgress:progress=>{if(id===generation && get().isOpen)set({progress});}});
          if(id!==generation || !get().isOpen) return;
          loadingSession=null;set({coverage});await runQuery();
        } catch(error) {
          if(id!==generation || error.name==='AbortError') return;
          if(loadingSession===current)loadingSession=null;
          set({status:'error',error:error.message,coverage:{...get().coverage,status:get().result?'stale':'error'}});
        }
      },
      setTab(tab) {
        const preferences=normalizeInsightsPreferences({...get().preferences,tab});
        if(preferences.tab!==get().tab)clearDetail();
        deps.savePreferences(preferences);set({tab:preferences.tab,preferences});
      },
      async setQuery(patch) {
        const priorIds=get().query.accountIds;
        const {preferences,query}=configure({...get().preferences,...patch});
        const next={...query};
        if('senderAddress' in patch)next.senderAddress=patch.senderAddress || null;
        if(['week','day','message'].includes(patch.timelineBucket))next.timelineBucket=patch.timelineBucket;
        if(['recent','count','name','volume'].includes(patch.senderSort))next.senderSort=patch.senderSort;
        set({query:next,selectedDay:get().selectedDay && get().selectedDay>=next.startDate && get().selectedDay<=next.endDate?get().selectedDay:null});
        clearDetail();deps.savePreferences(preferences);
        if(JSON.stringify(priorIds)!==JSON.stringify(next.accountIds)) await get().refresh();else await runQuery();
      },
      selectSender(address) { return get().setQuery({senderAddress:address}); },
      async selectDay(date) {set({selectedDay:date});if(date)await get().loadMessages({startDate:date,endDate:date});else clearDetail();},
      async loadMessages(selection) {
        if(!session || get().status!=='ready')return;
        deps.cancelSelection();
        const id=++messageGeneration, current=session;
        set({selection,messages:[],messagesLoading:true,detailOpen:false});
        try {
          const rows=await current.messages(get().query,selection);
          if(id===messageGeneration && current===session && get().isOpen)set({messages:selection.messageKey?rows.filter(row=>row.key===selection.messageKey):rows,messagesLoading:false});
        } catch(error) {
          if(id===messageGeneration && error.name!=='AbortError')set({messagesLoading:false,error:error.message});
        }
      },
      closeMessages:clearDetail,
      setDetailOpen:detailOpen=>set({detailOpen}),
    };
  });
}
export const useInsightsStore = createInsightsStore();
