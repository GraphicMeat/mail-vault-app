// @vitest-environment jsdom
// Conditional pre-port capture draft. Root must pin accepted S2 source, run remotely,
// inspect output, and commit frozen originals/provenance before any S3 product port.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

vi.mock('../../../../src/stores/safeStorage', () => ({
  safeStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  flushSafeStorage: async () => {}, safeStorageWritable: () => true,
}));
vi.mock('../../../../src/services/daemonClient', () => ({ daemonCall: vi.fn() }));

const { useSettingsStore } = await import('../../../../src/stores/settingsStore');
const { useSnoozeStore } = await import('../../../../src/stores/snoozeStore');
const { useFollowUpStore } = await import('../../../../src/stores/followUpStore');
const { useTagStore } = await import('../../../../src/stores/tagStore');
const { useAutoTagStore } = await import('../../../../src/stores/autoTagStore');
const { useViewHideStore } = await import('../../../../src/stores/viewHideStore');
const { rowVisibility } = await import('../../../../src/utils/rowVisibility');
const count = await import('../../../../src/stores/unreadCounts');

const A = 'a', B = 'b';
const accounts = [{ id:A, name:'Alpha', email:'a@example.test' },
  { id:B, name:'Beta', email:'b@example.test' }];
const row = (uid, extra={}) => ({ uid, flags:[], messageId:`<m${uid}@example.test>`, ...extra });
const seen = uid => row(uid, { flags:['\\Seen'] });
const due = (id, accountId=A, extra={}) => ({ id, accountId, state:'due', sentMailbox:'Sent', sentUid:1, seen:false, ...extra });
const full = (emails, totalEmails=emails.length) => ({ emails, totalEmails });
const entry = (accountId, mailbox, r) => ({ accountId, mailbox, row:r });
const snapshot = v => v === undefined ? { $undefined:true }
  : v instanceof Set ? { $set:[...v] }
  : Array.isArray(v) ? v.map(snapshot)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,snapshot(x)]))
  : v;
const clone = v => snapshot(v);
const original = {
  setOne:useSettingsStore.getState().setUnreadForAccount,
  setMap:useSettingsStore.getState().setUnreadPerAccount,
};
let list = {};
count.setListStore({ getState: () => list });

function reset(seed={}) {
  const writes=[];
  const base={ unreadPerAccount:{ [A]:7, [B]:5 }, hiddenAccounts:{}, displayNames:{},
    accountOrder:[], hideViewMail:false, ...seed.settings };
  useSettingsStore.setState({ ...base,
    setUnreadForAccount:(id,n) => {
      const before=clone(useSettingsStore.getState().unreadPerAccount);
      original.setOne(id,n);
      writes.push({ method:'setUnreadForAccount', args:clone([id,n]), before,
        after:clone(useSettingsStore.getState().unreadPerAccount) });
    },
    setUnreadPerAccount:m => {
      const before=clone(useSettingsStore.getState().unreadPerAccount);
      original.setMap(m);
      writes.push({ method:'setUnreadPerAccount', args:clone([m]), before,
        after:clone(useSettingsStore.getState().unreadPerAccount) });
    },
  });
  useSnoozeStore.setState({ rows:seed.snoozes || [] });
  useFollowUpStore.setState({ rows:seed.followUps || [] });
  useTagStore.setState({ byRow:seed.tagsByRow || {} });
  useAutoTagStore.setState({ rules:seed.autoTagRules || [] });
  useViewHideStore.setState({ keys: seed.viewHiddenKeys == null ? null : new Set(seed.viewHiddenKeys) });
  list={ archivedEmailIds:seed.archivedKeys == null ? null : new Set(seed.archivedKeys),
    deleteTombstones:seed.deleteTombstones == null ? null : new Set(seed.deleteTombstones) };
  return writes;
}

function runStep(step) {
  let result;
  switch (step.op) {
    case 'recount': result={ complete:count.isCompleteCache(step.cache),
      inbox:count.inboxCount(step.accountId || A, step.cache),
      wrote:count.recountInbox(step.accountId || A, step.cache) }; break;
    case 'shift': {
      const entries=step.unreadOnly ? count.unreadEntries(step.entries) : step.entries;
      result=count.shiftInbox(entries,step.sign); break;
    }
    case 'followUps': result=count.shiftFollowUps(step.before,step.after); break;
    case 'arrivals': result=count.addArrivals(step.accountId || A,step.count); break;
    case 'merge': result=count.applyRecounts(step.measured); break;
    case 'forget': result=count.forgetAccount(step.accountId || A); break;
    case 'rows': result={ rows:count.unreadRows(useSettingsStore.getState(),step.accounts || accounts),
      total:count.selectTotalUnread(useSettingsStore.getState(),step.accounts || accounts) }; break;
    case 'visibility': result=rowVisibility({ activeAccountId:step.accountId || A,
      activeMailbox:step.mailbox || 'INBOX',
      archivedEmailIds:list.archivedEmailIds, deleteTombstones:list.deleteTombstones,
      hiddenTagIds:useAutoTagStore.getState().hiddenTagIds(),
      tagsByRow:useTagStore.getState().byRow,
      localSnoozes:new Set(), viewHidden:useViewHideStore.getState().keys })(step.row); break;
    default: throw Error(`unknown capture operation ${step.op}`);
  }
  return { input:clone(step), result:clone(result), counts:clone(useSettingsStore.getState().unreadPerAccount) };
}
const cases=[];
const add=(id,name,seed,steps) => cases.push({ id,name,seed,steps });

// Complete-cache and coercion rule. Each variant calls the old export.
add('C01','null-cache',{},[{op:'recount',cache:null}]);
add('C02','missing-emails',{},[{op:'recount',cache:{totalEmails:2}}]);
add('C03','non-array-emails',{},[{op:'recount',cache:{emails:{0:row(1)},totalEmails:1}}]);
add('C04','empty-complete',{},[{op:'recount',cache:full([])}]);
add('C05','mixed-complete',{},[{op:'recount',cache:full([row(1),seen(2),row(3)])}]);
add('C06','one-of-five-hundred-partial',{},[{op:'recount',cache:full([row(1)],500)}]);
add('C07','missing-total',{},[{op:'recount',cache:{emails:[row(1),row(2)]}}]);
for (const [id,name,total] of [['C08a','null-total',null],['C08b','zero-total',0],['C08c','lower-total',1],
  ['C09a','numeric-string-greater','3'],['C09b','numeric-string-equal','2'],['C10','negative-total',-1]])
  add(id,name,{},[{op:'recount',cache:{emails:[row(1),row(2)],totalEmails:total}}]);
add('C11','duplicate-uid-counts-two-rows',{},[{op:'recount',cache:full([row(1),row(1)])}]);

// Visibility applies to the account's INBOX, with row-specific source fields.
add('V01','seen-and-absent-flags',{},[{op:'recount',cache:full([row(1,{flags:undefined}),seen(2)])}]);
add('V02','deleted-unarchived',{},[{op:'recount',cache:full([row(1,{flags:['\\Deleted']})])}]);
add('V03','deleted-in-archive-set',{archivedKeys:[`${A}:INBOX:1`]},[{op:'recount',cache:full([row(1,{flags:['\\Deleted']})])}]);
for (const [id,value] of [['V04a',false],['V04b',true]])
  add(id,`explicit-archived-${value}`,{archivedKeys:[`${A}:INBOX:1`]},
    [{op:'recount',cache:full([row(1,{flags:['\\Deleted'],isArchived:value})])}]);
const hideRule={tagId:'hidden',enabled:true,inboxAction:'hide'};
add('V05','enabled-hidden-tag',{autoTagRules:[hideRule],tagsByRow:{'a|INBOX|1':['hidden']}},
  [{op:'recount',cache:full([row(1)])}]);
add('V06','disabled-hidden-tag',{autoTagRules:[{...hideRule,enabled:false}],tagsByRow:{'a|INBOX|1':['hidden']}},
  [{op:'recount',cache:full([row(1)])}]);
add('V07a','unknown-tag-entry',{autoTagRules:[hideRule]},[{op:'recount',cache:full([row(1)])}]);
add('V07b','known-empty-tag-entry',{autoTagRules:[hideRule],tagsByRow:{'a|INBOX|1':[]}},
  [{op:'recount',cache:full([row(1)])}]);
add('V08','same-uid-other-account-and-folder',{autoTagRules:[hideRule],tagsByRow:{'b|INBOX|1':['hidden'],'a|Sent|1':['hidden']}},
  [{op:'recount',cache:full([row(1)])}]);
add('V09','exact-tombstone',{deleteTombstones:[`${A}|INBOX|1`]},[{op:'recount',cache:full([row(1)])}]);
add('V10','other-tombstone',{deleteTombstones:[`${B}|INBOX|1`,`${A}|Sent|1`]},
  [{op:'recount',cache:full([row(1)])}]);
add('V11','active-local-snooze',{snoozes:[{id:'s',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:'<m1@example.test>',state:'snoozed'}]},
  [{op:'recount',cache:full([row(1)])}]);
add('V12b','woken-local-snooze-does-not-hide',{snoozes:[{id:'w',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:'<m1@example.test>',state:'woken'}]},
  [{op:'recount',cache:full([row(1)])}]);
add('V12','failed-or-remote-snooze',{snoozes:[
  {id:'failed',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:'<m1@example.test>',state:'failed'},
  {id:'remote',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'Snoozed',messageId:'<m2@example.test>',state:'snoozed'}]},
  [{op:'recount',cache:full([row(1),row(2)])}]);
add('V13','normalized-message-id-local-snooze',{snoozes:[{id:'s',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:'m1@example.test',state:'snoozed'}]},
  [{op:'recount',cache:full([row(1)])}]);
add('V13b','whitespace-message-id-snooze',{snoozes:[{id:'s',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:' <m1@example.test> ',state:'snoozed'}]},
  [{op:'recount',cache:full([row(1)])}]);
add('V13c','missing-message-id-does-not-snooze',{snoozes:[{id:'s',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:'<m1@example.test>',state:'snoozed'}]},
  [{op:'recount',cache:full([row(1,{messageId:undefined})])}]);
add('V14','view-hide-setting-on',{settings:{hideViewMail:true},viewHiddenKeys:[`${A}|INBOX|1`]},
  [{op:'recount',cache:full([row(1),row(2)])}]);
add('V15a','view-hide-setting-off',{settings:{hideViewMail:false},viewHiddenKeys:[`${A}|INBOX|1`]},
  [{op:'recount',cache:full([row(1),row(2)])}]);
add('V15b','view-hide-unknown',{settings:{hideViewMail:true},viewHiddenKeys:null},
  [{op:'recount',cache:full([row(1)])}]);

add('V15c','source-account-fallback-differs-between-helpers',{archivedKeys:[`${B}:INBOX:1`],
  autoTagRules:[hideRule],tagsByRow:{'b|INBOX|1':['hidden']}},
  [{op:'recount',cache:full([row(1,{_srcAccountId:B,flags:['\\Deleted']})])}]);

// Reminder rows and ordered transition behavior.
add('F01','due-unread-versus-seen-waiting-history',{followUps:[due('u'),due('seen',A,{seen:true}),due('wait',A,{state:'waiting'}),due('other',B)]},
  [{op:'recount',cache:full([])}]);
add('F02','empty-or-missing-sent-mailbox',{followUps:[due('empty',A,{sentMailbox:''}),due('missing',A,{sentMailbox:undefined})]},
  [{op:'recount',cache:full([])}]);
add('F03','integer-zero-string-and-missing-sent-uid',{followUps:[due('zero',A,{sentUid:0}),due('string',A,{sentUid:'1'}),due('missing',A,{sentUid:undefined})]},
  [{op:'recount',cache:full([])}]);
add('F04','another-account-reminder',{followUps:[due('b',B)]},[{op:'recount',cache:full([])}]);
add('F05','duplicate-reminder-rows',{followUps:[due('dup'),due('dup')]},[{op:'recount',cache:full([])}]);
add('F06','waiting-due-seen-unseen-dismiss',{},[
  {op:'followUps',before:[due('r',A,{state:'waiting'})],after:[due('r')]},
  {op:'followUps',before:[due('r')],after:[due('r',A,{seen:true})]},
  {op:'followUps',before:[due('r',A,{seen:true})],after:[due('r')]},
  {op:'followUps',before:[due('r')],after:[]}]);
add('F07','first-load-announced-versus-unannounced',{},[
  {op:'followUps',before:[],after:[due('old',A,{announced:true})]},
  {op:'followUps',before:[],after:[due('new',A,{announced:false})]}]);
add('F08','existing-id-announced-change',{},[
  {op:'followUps',before:[due('r',A,{seen:true})],after:[due('r',A,{announced:true})]}]);
add('F09','mixed-account-reminder-saturation',{settings:{unreadPerAccount:{a:0,b:1}}},[
  {op:'followUps',before:[due('a'),due('b',B)],after:[]}]);

// Shifts use the actual old unreadEntries helper only where the caller did.
add('S01','two-account-inbox-shift',{},[{op:'shift',entries:[entry(A,'INBOX',row(1)),entry(B,'INBOX',row(2))],sign:-1}]);
add('S02','non-inbox-and-missing-account',{},[{op:'shift',entries:[entry(A,'Sent',row(1)),entry('', 'INBOX',row(2))],sign:-1}]);
add('S03','saturation',{settings:{unreadPerAccount:{a:0,b:5}}},[{op:'shift',entries:[entry(A,'INBOX',row(1))],sign:-1}]);
add('S04','unread-only-seen-and-unseen',{},[{op:'shift',unreadOnly:true,entries:[entry(A,'INBOX',seen(1)),entry(A,'INBOX',row(2))],sign:-1}]);
add('S05','changed-read-state-formerly-seen',{},[{op:'shift',entries:[entry(A,'INBOX',seen(1))],sign:1}]);
add('S06','tombstone-installed-before-shift',{deleteTombstones:[`${A}|INBOX|1`]},
  [{op:'shift',entries:[entry(A,'INBOX',row(1))],sign:-1}]);
add('S07','duplicate-entries',{},[{op:'shift',entries:[entry(A,'INBOX',row(1)),entry(A,'INBOX',row(1))],sign:-1}]);
add('S08','hidden-local-snoozed-and-view-held-shift',{settings:{hideViewMail:true},
  autoTagRules:[hideRule],tagsByRow:{'a|INBOX|1':['hidden']},
  snoozes:[{id:'s',accountId:A,fromMailbox:'INBOX',snoozedMailbox:'',messageId:'<m2@example.test>',state:'snoozed'}],
  viewHiddenKeys:[`${A}|INBOX|3`]},
  [{op:'shift',entries:[entry(A,'INBOX',row(1)),entry(A,'INBOX',row(2)),entry(A,'INBOX',row(3)),entry(A,'INBOX',row(4))],sign:-1}]);

add('S08b','deleted-flag-still-suppresses-shift',{},
  [{op:'shift',entries:[entry(A,'INBOX',row(1,{flags:['\\Deleted']}))],sign:-1}]);

// Merge, forget, rows and tray account order use the real settingsStore comparator.
add('M01','arrival-existing-and-missing',{},[{op:'arrivals',accountId:A,count:2},{op:'arrivals',accountId:'new',count:1}]);
add('M02','merge-measured-b-preserves-a',{},[{op:'merge',measured:{b:1}}]);
add('M03','merge-empty-map',{},[{op:'merge',measured:{}}]);
add('M04','forget-a-preserves-b',{},[{op:'forget',accountId:A}]);
add('R01','visible-hidden-removed',{settings:{unreadPerAccount:{a:7,b:5,gone:100},hiddenAccounts:{b:true}}},[{op:'rows'}]);
add('R02','empty-account-list-keeps-stored-counts',{},[{op:'rows',accounts:[]}]);
add('R03','label-fallbacks',{settings:{displayNames:{a:'Preferred',b:''}}},[{op:'rows',accounts:[{id:A,name:'Alpha',email:'a@example.test'},{id:B,email:'b@example.test'}]}]);
add('R04','real-order-unknown-and-duplicate-last-index',{settings:{accountOrder:[B,A,B]}},[{op:'rows',accounts:[...accounts,{id:'c',name:'Gamma'}]}]);
add('R05','missing-count-and-hidden-map',{settings:{unreadPerAccount:{a:1},hiddenAccounts:undefined}},[{op:'rows'}]);

it.skipIf(process.env.MAILVAULT_WRITE_UNREAD_FIXTURE !== '1')('captures actual pre-port unread exports and real settings account order', () => {
  const observed=[];
  for (const c of cases) {
    const writes=reset(c.seed);
    const outputs=c.steps.map(runStep);
    observed.push({id:c.id,name:c.name,input:clone({seed:c.seed,steps:c.steps}),
      output:{steps:outputs,writes:clone(writes),finalCounts:clone(useSettingsStore.getState().unreadPerAccount)}});
  }
  expect(new Set(observed.map(c => c.id)).size).toBe(observed.length);
  expect(observed.length).toBe(63);
  const sourcePaths=[
    'src/stores/unreadCounts.js','src/utils/rowVisibility.js','src/stores/settingsStore.js',
    'src/stores/followUpStore.js','src/stores/snoozeStore.js','src/stores/tagStore.js',
    'src/stores/autoTagStore.js','src/stores/viewHideStore.js',
    'src/stores/slices/unifiedHelpers.js','src/utils/autoTagInboxFilter.js',
    'src/utils/replyPolicy.js','src/utils/ownAddresses.js','src/utils/emailIdentity.js',
  ];
  const sourceSha256=Object.fromEntries(sourcePaths.map(p => [p,
    createHash('sha256').update(readFileSync(p)).digest('hex')]));
  const fixture={version:1,sourceSha256,caseCount:observed.length,cases:observed};
  const destination=process.env.MAILVAULT_UNREAD_FIXTURE_OUTPUT;
  if (!destination) throw Error('MAILVAULT_UNREAD_FIXTURE_OUTPUT is required');
  writeFileSync(destination,JSON.stringify(fixture,null,2)+'\n');
  console.log('W4S3_UNREAD_ORACLE_DRAFT_CAPTURE '+JSON.stringify({cases:observed.length,
    sha256:createHash('sha256').update(readFileSync(destination)).digest('hex')}));
});
