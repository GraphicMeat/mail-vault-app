// @vitest-environment jsdom
// Intended path: src/services/workflows/__tests__/unreadCountsRefreshCallerCapture.test.js
// Conditional old-JS O04 trace. The refresh workflow and unread exports are real;
// provider/cache boundaries are deterministic mocks. Do not run before S2 acceptance.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
let state;
const calls=[];
const provider=vi.fn();
vi.mock('../../../stores/mailStore',()=>({useMailStore:{getState:()=>state,
  setState:patch=>{state={...state,...(typeof patch==='function'?patch(state):patch)};}}}));
vi.mock('../../db',()=>({
  getEmailHeadersMeta:async(...a)=>{calls.push(['meta',...a]);return null;},
  listCachedUids:async(...a)=>{calls.push(['uids',...a]);return null;},
  getEmailHeaders:async(...a)=>{calls.push(['headers',...a]);return null;},
  getCachedMailboxes:async()=>[],saveEmailHeaders:async(...a)=>{calls.push(['save',a[0],a[1],a[2].length,a[3]]);},
}));
vi.mock('../../api',()=>({fetchEmails:(...a)=>{calls.push(['fetch',a[0].id,a[1],a[2]]);return provider(...a);},
  graphListFolders:vi.fn()}));
vi.mock('../../cacheManager',()=>({invalidateRestoreDescriptors:()=>{},
  getAccountCacheMailboxes:()=>null,listGraphMessages:vi.fn()}));
vi.mock('../../syncProbe',()=>({invalidate:async id=>{calls.push(['probe.invalidate',id]);return {invalidated:true};}}));
vi.mock('../helpers/mailboxRefetch',()=>({forceMailboxRefetch:vi.fn(),takeForcedMailboxRefetch:()=>false}));
vi.mock('../folderStatus',()=>({refreshFolderStatus:async()=>null,invalidateFolderStatus:()=>{}}));
vi.mock('../folderOps',()=>({loadLocalFolders:id=>{calls.push(['localFolders',id]);}}));
vi.mock('../adoptGraphFolderKeys',()=>({adoptGraphFolderKeysFromListing:vi.fn()}));
vi.mock('../../graphConfig',()=>({isGraphAccount:()=>false,storageKeyOf:f=>f?.displayName}));
vi.mock('../../authUtils',()=>({hasValidCredentials:()=>true,ensureFreshToken:async a=>a}));
vi.mock('../../../stores/slices/unifiedHelpers',async importOriginal=>({
  ...(await importOriginal()),_resolveMailboxPath:(_m,target)=>target}));
vi.mock('../../../stores/safeStorage',()=>({safeStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  flushSafeStorage:async()=>{},safeStorageWritable:()=>true}));
vi.mock('../../daemonClient',()=>({daemonCall:vi.fn()}));

const { useSettingsStore }=await import('../../../stores/settingsStore');
const unread=await import('../../../stores/unreadCounts');
const { refreshAllAccounts }=await import('../refreshAccounts');
const original={one:useSettingsStore.getState().setUnreadForAccount,
  map:useSettingsStore.getState().setUnreadPerAccount};
const row=(uid,seen=false)=>({uid,flags:seen?['\\Seen']:[],messageId:`m${uid}@example.test`,
  subject:`m${uid}`,from:{address:'sender@example.test'}});
const A={id:'a',email:'a@example.test'},B={id:'b',email:'b@example.test'};

it.skipIf(process.env.MAILVAULT_WRITE_UNREAD_O_FIXTURE!=='1')('captures actual refresh measurement and final unread merge O04',async()=>{
  calls.length=0;
  useSettingsStore.setState({unreadPerAccount:{a:9,b:5},hiddenAccounts:{},displayNames:{},accountOrder:[],
    setUnreadForAccount:(id,n)=>{calls.push(['setUnreadForAccount',id,n]);original.one(id,n);},
    setUnreadPerAccount:m=>{calls.push(['setUnreadPerAccount',{...m}]);original.map(m);},
  });
  state={accounts:[A,B],activeAccountId:A.id,activeMailbox:'INBOX',unifiedInbox:false,
    unifiedFolder:null,mailboxScope:null,emails:[row(1)],
    loadEmails:async()=>{
      calls.push(['loadEmails.enter']);
      state={...state,emails:[row(1,true),row(2)]};
      const wrote=unread.recountInbox(A.id,{emails:state.emails,totalEmails:2});
      calls.push(['loadEmails.recount',wrote]);
    }};
  provider.mockResolvedValue({emails:[row(11),row(12,true)],total:2,hasMore:false});
  const before={counts:{...useSettingsStore.getState().unreadPerAccount},
    activeAccountId:state.activeAccountId,emails:state.emails};
  const result=await refreshAllAccounts();
  const output={result,orderedCalls:[...calls],counts:{...useSettingsStore.getState().unreadPerAccount},
    activeAccountId:state.activeAccountId,emails:state.emails};
  const entry={id:'O04',name:'actual-refresh-inactive-measurement-merges-after-active-recount',
    input:before,output};
  expect(calls.some(c=>c[0]==='setUnreadForAccount')).toBe(true);
  expect(calls.some(c=>c[0]==='setUnreadPerAccount')).toBe(true);
  const destination=process.env.MAILVAULT_UNREAD_O04_OUTPUT;
  if (!destination) throw Error('MAILVAULT_UNREAD_O04_OUTPUT is required');
  writeFileSync(destination,JSON.stringify({version:1,cases:[entry]},null,2)+'\n');
  console.log('W4S3_UNREAD_REFRESH_O04_DRAFT '+JSON.stringify({cases:1,
    sha256:createHash('sha256').update(readFileSync(destination)).digest('hex')}));
});
