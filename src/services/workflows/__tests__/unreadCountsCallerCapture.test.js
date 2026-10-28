// @vitest-environment jsdom
// Intended path: src/services/workflows/__tests__/unreadCountsCallerCapture.test.js
// Conditional first-capture draft. It invokes the old production callers and
// records actual setter order, row state and final settings, with synthetic IDs.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { serverUids } from '../../../stores/slices/serverUids';
import { guardViewCounts } from '../../../test/viewCountsGuard';
guardViewCounts();
if (!globalThis.window) globalThis.window={addEventListener(){},removeEventListener(){}};
else { window.addEventListener ||= (()=>{}); window.removeEventListener ||= (()=>{}); }

let online=true;
let reminderRows=[];
const calls=[];
const apiDelete=vi.fn();
const apiMove=vi.fn();
const apiFlags=vi.fn().mockResolvedValue({success:true,written:[]});
const apiFind=vi.fn().mockResolvedValue({found:[],searched:1,failed:0,complete:true});
const daemon=vi.fn(async (method) => method==='follow_up.list' ? reminderRows : null);
vi.mock('../../db',()=>({
  getLocalEmailLight:vi.fn().mockResolvedValue(null),
  getEmailHeadersMeta:vi.fn().mockResolvedValue(null),
  getEmailHeadersPartial:vi.fn().mockResolvedValue({emails:[],totalEmails:0}),
  getVaultUidSets:vi.fn().mockResolvedValue({saved:new Set(),archived:new Set()}),
  getCachedMailboxEntry:vi.fn().mockResolvedValue(null),
  getLocalEmails:vi.fn().mockResolvedValue([]),
  readLocalEmailIndex:vi.fn().mockResolvedValue(null),
  getLocalIndexEntry:vi.fn().mockResolvedValue(null),
  getArchivedEmails:vi.fn().mockResolvedValue([]),
  deleteLocalEmail:vi.fn().mockResolvedValue(undefined),
  saveEmailHeaders:vi.fn().mockResolvedValue(undefined),
  queueOp:vi.fn().mockResolvedValue(1),clearOps:vi.fn().mockResolvedValue(undefined),
  initDB:vi.fn().mockResolvedValue(undefined),getAccounts:vi.fn().mockResolvedValue([]),
  ensureAccountsInFile:vi.fn().mockResolvedValue(undefined),saveMailboxes:vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../api',()=>({
  vaultApplyFlags:vi.fn().mockResolvedValue({renamed:0,mirrored:0,index_patched:0,sidecars_patched:0}),
  fetchEmailLight:vi.fn().mockResolvedValue(null),updateEmailFlags:(...a)=>apiFlags(...a),
  graphSetRead:vi.fn().mockResolvedValue(undefined),graphSetFlagged:vi.fn().mockResolvedValue(undefined),
  graphMoveEmails:vi.fn().mockResolvedValue(undefined),graphDeleteMessage:vi.fn().mockResolvedValue(undefined),
  deleteEmail:(...a)=>apiDelete(...a),moveEmails:(...a)=>apiMove(...a),
  findMessageId:(...a)=>apiFind(...a),
  appendLocalIndex:vi.fn().mockResolvedValue(undefined),
  removeFromLocalIndex:vi.fn().mockResolvedValue(undefined),
  vaultRebindUids:vi.fn().mockResolvedValue({rebound:[]}),
}));
vi.mock('../../daemonClient',async importOriginal=>({
  ...(await importOriginal()),daemonCall:(...a)=>{calls.push(['daemon',...a]);return daemon(...a);},
}));
vi.mock('../refreshAccounts',()=>({refreshCurrentView:vi.fn().mockResolvedValue(undefined),
  refreshAllAccounts:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../../authUtils',()=>({hasValidCredentials:()=>true,ensureFreshToken:async a=>a,
  resolveServerAccount:async (_id,account)=>({ok:true,account})}));
vi.mock('../../attachmentUtils',()=>({hasRealAttachments:()=>false,hydrateInlineImages:async e=>e}));
vi.mock('../../graphConfig',()=>({isGraphAccount:a=>a?.oauth2Transport==='graph',
  graphMessageToEmail:m=>m}));
vi.mock('../../cacheManager',()=>({getRestoreDescriptor:()=>null,saveRestoreDescriptor:vi.fn(),
  invalidateRestoreDescriptors:()=>{},getAccountCacheMailboxes:()=>null,
  listGraphMessages:vi.fn().mockResolvedValue({headers:[],graphMessageIds:[]}),
  getGraphMessageId:()=>null,resolveGraphMessageId:async()=>null,clearGraphIdMap:()=>{}}));
vi.mock('../../../stores/connectivityStore',()=>({useConnectivityStore:{getState:()=>({online})}}));
vi.mock('../../../stores/safeStorage',()=>({safeStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  flushSafeStorage:async()=>{},safeStorageWritable:()=>true}));
vi.mock('../../safeStorage',()=>({safeStorage:{getItem:()=>null,setItem(){},removeItem(){}}}));

const { useMailStore }=await import('../../../stores/mailStore');
const { useSettingsStore }=await import('../../../stores/settingsStore');
const { useFollowUpStore }=await import('../../../stores/followUpStore');
const { invalidateChatAndThreadCaches }=await import('../../../stores/slices/messageListSlice');
const { applyFlagToTargets,deleteEmailFromServer }=await import('../messageMutations');
const A={id:'a',email:'a@example.test'},B={id:'b',email:'b@example.test'};
const row=(uid,extra={})=>({uid,messageId:`m${uid}@example.test`,subject:`m${uid}`,flags:[],
  source:'server',from:{address:'sender@example.test'},date:'2026-09-01T10:00:00Z',...extra});
const summary=()=>({counts:{...useSettingsStore.getState().unreadPerAccount},
  rows:useMailStore.getState().emails.map(x=>({uid:x.uid,flags:x.flags})),
  sorted:useMailStore.getState().sortedEmails.map(x=>x.uid),
  tombstones:[...(useMailStore.getState().deleteTombstones||[])],
  undo:!!useMailStore.getState().undo?.canUndo,calls:[...calls]});
const originals={one:useSettingsStore.getState().setUnreadForAccount,
  map:useSettingsStore.getState().setUnreadPerAccount};
function trackSettings(counts={a:7,b:5}) {
  calls.length=0;
  useSettingsStore.setState({unreadPerAccount:{...counts},hiddenAccounts:{},displayNames:{},
    accountOrder:[],hideViewMail:false,
    setUnreadForAccount:(id,n)=>{calls.push(['setUnreadForAccount',id,n]);originals.one(id,n);},
    setUnreadPerAccount:m=>{calls.push(['setUnreadPerAccount',{...m}]);originals.map(m);},
  });
}
function prime(emails,total=emails.length) {
  useMailStore.setState({accounts:[A,B],activeAccountId:A.id,activeMailbox:'INBOX',
    unifiedInbox:false,unifiedFolder:null,mailboxScope:null,mailboxes:[],viewMode:'all',
    emails,sentEmails:[],localEmails:[],savedEmailIds:new Set(),archivedEmailIds:new Set(),
    serverUids:serverUids(emails.map(e=>e.uid),{complete:false}),deleteTombstones:new Set(),
    totalEmails:total,selectedEmailIds:new Set(),selectedEmail:null,selectedEmailId:null,
    selectedThread:null,emailCache:new Map(),loadEmails:vi.fn(),undo:null,error:null,
    _sortedEmailsFingerprint:''});
  invalidateChatAndThreadCaches();
  useMailStore.getState().updateSortedEmails();
  trackSettings(); // The pre-action persisted baseline, after initial list paint.
}
const target=uid=>({account:A,accountId:A.id,mailbox:'INBOX',uid});
const due=(id,extra={})=>({id,accountId:A.id,state:'due',sentMailbox:'Sent',sentUid:9,
  seen:false,announced:false,...extra});
const copy=x=>x===undefined?{$undefined:true}
  : x instanceof Set?{$set:[...x].map(copy)}
  : Array.isArray(x)?x.map(copy)
  : x&&typeof x==='object'?Object.fromEntries(Object.entries(x).map(([k,v])=>[k,copy(v)]))
  : x;

it.skipIf(process.env.MAILVAULT_WRITE_UNREAD_O_FIXTURE!=='1')('captures actual old mutation and reminder callers O01-O03',async()=>{
  // The caller schedules a detached import of this real store. Finish its
  // initialization before the actions so its count timer is available.
  await import('../../../stores/viewStore');
  const cases=[];
  online=true;apiFlags.mockResolvedValue({success:true,written:[]});
  prime([row(1),row(2)]);
  const o1Before=summary();
  await applyFlagToTargets([target(1)],'\\Seen',true);
  cases.push({id:'O01',name:'mutation-shift-then-complete-list-recount',
    input:{rows:[row(1),row(2)],total:2,baseline:{a:7,b:5}},
    output:{before:o1Before,after:summary()}});

  online=true;apiDelete.mockResolvedValue({trash:'Trash',trashUid:5});
  apiMove.mockResolvedValue({success:true,moved:1,newUids:[41]});
  prime([row(1),row(2)],500);
  const o2Before=summary();
  await deleteEmailFromServer(1);
  const o2Deleted=summary();
  const undoResult=await useMailStore.getState().runUndo();
  cases.push({id:'O02',name:'partial-inbox-delete-and-undo',
    input:{rows:[row(1),row(2)],total:500,baseline:{a:7,b:5}},
    output:{before:o2Before,deleted:o2Deleted,undoResult,after:summary()}});

  prime([],0);
  useFollowUpStore.setState({rows:[]});
  trackSettings();
  reminderRows=[due('announced',{announced:true}),due('new')];
  const o3Before=summary();
  await useFollowUpStore.getState().loadRows();
  const o3Loaded=summary();
  await useFollowUpStore.getState().setSeen('new',true);
  const o3Seen=summary();
  await useFollowUpStore.getState().setSeen('new',false);
  const o3Unread=summary();
  await useFollowUpStore.getState().dismiss('new');
  cases.push({id:'O03',name:'actual-follow-up-load-optimistic-seen-unseen-dismiss',
    input:{rows:reminderRows,baseline:{a:7,b:5}},
    output:{before:o3Before,loaded:o3Loaded,seen:o3Seen,unread:o3Unread,after:summary()}});

  expect(cases.map(c=>c.id)).toEqual(['O01','O02','O03']);
  const destination=process.env.MAILVAULT_UNREAD_O_OUTPUT;
  if (!destination) throw Error('MAILVAULT_UNREAD_O_OUTPUT is required');
  writeFileSync(destination,JSON.stringify({version:1,cases:copy(cases)},null,2)+'\n');
  console.log('W4S3_UNREAD_CALLERS_DRAFT '+JSON.stringify({cases:cases.length,
    sha256:createHash('sha256').update(readFileSync(destination)).digest('hex')}));
});
