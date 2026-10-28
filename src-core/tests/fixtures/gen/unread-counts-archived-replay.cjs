// Conditional archived-source replay draft. Run only through root's approved
// remote carrier after the first actual-JS fixture and frozen originals exist.
// NODE_OPTIONS must include --experimental-vm-modules on Node versions that need it.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');

const root = process.env.MV_UNREAD_ROOT || process.cwd();
const originalDir = process.env.MV_UNREAD_ORIGINALS_DIR
  || path.join(root, 'src-core/tests/fixtures/gen/unread-counts-originals');
const fixturePath = process.env.MV_UNREAD_FIXTURE
  || path.join(root, 'src-core/tests/fixtures/unread-counts-cases.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const sourceFiles = [
  'src/stores/unreadCounts.js','src/utils/rowVisibility.js','src/stores/settingsStore.js',
  'src/stores/followUpStore.js','src/stores/snoozeStore.js','src/stores/tagStore.js',
  'src/stores/autoTagStore.js','src/stores/viewHideStore.js',
  'src/stores/slices/unifiedHelpers.js','src/utils/autoTagInboxFilter.js',
  'src/utils/replyPolicy.js','src/utils/ownAddresses.js','src/utils/emailIdentity.js',
];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const source = new Map();
for (const file of sourceFiles) {
  const encoded = fs.readFileSync(path.join(originalDir, file.replaceAll('/','__')+'.base64'), 'ascii').trim();
  const bytes = Buffer.from(encoded, 'base64');
  assert.equal(sha(bytes), fixture.sourceSha256[file], `archived ${file} changed`);
  source.set(file, bytes.toString('utf8'));
}
const context = vm.createContext({ console:{log(){},warn(){},error(){}}, Date, Set, Map,
  Promise, setTimeout, clearTimeout, AbortController, URL });
const modules = new Map();
function synthetic(id, exported) {
  if (modules.has(id)) return modules.get(id);
  const m = new vm.SyntheticModule(Object.keys(exported), function () {
    for (const [name,value] of Object.entries(exported)) this.setExport(name,value);
  }, { context, identifier:id });
  modules.set(id,m); return m;
}
for (const [file,text] of source) modules.set(file,new vm.SourceTextModule(text,{context,identifier:file}));
const stub = (...args) => args[0];
const methodStubs = {
  'src/stores/safeStorage': { safeStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    flushSafeStorage:async()=>{},safeStorageWritable:()=>true },
  'src/services/daemonClient': { daemonCall:async()=>{throw Error('Unexpected daemon I/O in archived oracle');} },
  'src/i18n/index.js': { t:key=>key },
  'src/services/workflows/mailboxTree.js': { isLocalMailbox:()=>false },
  'src/utils/notificationSounds': { normalizeNotificationSound:stub },
  'src/utils/insights/preferences': { normalizeInsightsPreferences:stub },
  'src/utils/appFont': { DEFAULT_APP_FONT:'system',normalizeAppFont:stub,normalizeTextScale:stub },
  'src/utils/quickActions': { DEFAULT_QUICK_ACTIONS:[],mapQuickActionSurfaces:stub,
    normalizeQuickActions:stub,quickActionOverridesAsDiffs:stub,resetQuickActionScope:stub,
    setQuickActionStyle:stub,setQuickActionStyleLink:stub,setQuickActionSurface:stub },
  'src/utils/quickActionPresets': { applyQuickActionPreset:stub },
  'src/utils/composeSize': { clampComposeSize:stub },
  'src/utils/folderIconColor': { folderColorKey:stub,normalizeFolderIconStyle:stub,
    normalizeFolderIconColors:stub },
  'src/services/export/social/socialLayout': { MACOS_WINDOW_RADIUS:12,EMAIL_WIDTH:680,
    normalizeEmailWidth:stub },
};
const projectRequire = createRequire(path.join(root, 'package.json'));
const zustand = projectRequire('zustand');
const middleware = projectRequire('zustand/middleware');
synthetic('zustand',{create:zustand.create});
synthetic('zustand/middleware',{persist:middleware.persist,createJSONStorage:middleware.createJSONStorage});
for (const [id,exports] of Object.entries(methodStubs)) synthetic(id,exports);
// The actual normalizeMessageId implementation is frozen in replyPolicy; the
// large emailParser module merely reexports it to these decision helpers.
synthetic('src/utils/emailParser.js',{normalizeMessageId:(...args) =>
  modules.get('src/utils/replyPolicy.js').namespace.normalizeMessageId(...args)});
function resolve(spec,ref) {
  if (spec==='zustand' || spec==='zustand/middleware') return spec;
  if (!spec.startsWith('.')) throw Error(`Unexpected archived import ${spec} from ${ref}`);
  let id=path.posix.normalize(path.posix.join(path.posix.dirname(ref),spec));
  if (modules.has(id)) return id;
  if (modules.has(id+'.js')) return id+'.js';
  throw Error(`Unpinned archived import ${spec} from ${ref}: ${id}`);
}
const snapshot = v => v === undefined ? { $undefined:true }
  : v instanceof Set ? { $set:[...v] }
  : Array.isArray(v) ? v.map(snapshot)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k,snapshot(x)]))
  : v;
const revive = v => v && typeof v==='object' && v.$undefined===true ? undefined
  : v && typeof v==='object' && Array.isArray(v.$set) ? new Set(v.$set.map(revive))
  : Array.isArray(v) ? v.map(revive)
  : v && typeof v==='object' ? Object.fromEntries(Object.entries(v).map(([k,x])=>[k,revive(x)]))
  : v;
(async()=>{
  const reply=modules.get('src/utils/replyPolicy.js');
  await reply.link((specifier,referencingModule)=>modules.get(resolve(specifier,referencingModule.identifier)));
  await reply.evaluate();
  const main=modules.get('src/stores/unreadCounts.js');
  await main.link((specifier,referencingModule)=>modules.get(resolve(specifier,referencingModule.identifier)));
  await main.evaluate();
  const count=main.namespace;
  const store=name=>modules.get(`src/stores/${name}.js`).namespace;
  const settings=store('settingsStore').useSettingsStore;
  const snoozes=store('snoozeStore').useSnoozeStore;
  const followUps=store('followUpStore').useFollowUpStore;
  const tags=store('tagStore').useTagStore;
  const autoTags=store('autoTagStore').useAutoTagStore;
  const viewHide=store('viewHideStore').useViewHideStore;
  const rowVisibility=modules.get('src/utils/rowVisibility.js').namespace.rowVisibility;
  const original={one:settings.getState().setUnreadForAccount,map:settings.getState().setUnreadPerAccount};
  let list={};
  count.setListStore({getState:()=>list});
  let observed=0;
  for (const expected of fixture.cases) {
    const input=revive(expected.input), writes=[];
    settings.setState({unreadPerAccount:{a:7,b:5},hiddenAccounts:{},displayNames:{},
      accountOrder:[],hideViewMail:false,...input.seed.settings,
      setUnreadForAccount:(id,n)=>{const before=snapshot(settings.getState().unreadPerAccount);
        original.one(id,n);writes.push({method:'setUnreadForAccount',args:snapshot([id,n]),before,
          after:snapshot(settings.getState().unreadPerAccount)});},
      setUnreadPerAccount:m=>{const before=snapshot(settings.getState().unreadPerAccount);
        original.map(m);writes.push({method:'setUnreadPerAccount',args:snapshot([m]),before,
          after:snapshot(settings.getState().unreadPerAccount)});},
    });
    snoozes.setState({rows:input.seed.snoozes||[]});
    followUps.setState({rows:input.seed.followUps||[]});
    tags.setState({byRow:input.seed.tagsByRow||{}});
    autoTags.setState({rules:input.seed.autoTagRules||[]});
    viewHide.setState({keys:input.seed.viewHiddenKeys==null?null:new Set(input.seed.viewHiddenKeys)});
    list={archivedEmailIds:input.seed.archivedKeys==null?null:new Set(input.seed.archivedKeys),
      deleteTombstones:input.seed.deleteTombstones==null?null:new Set(input.seed.deleteTombstones)};
    const outputs=[];
    for (const step of input.steps) {
      let result;
      switch (step.op) {
        case 'recount':result={complete:count.isCompleteCache(step.cache),
          inbox:count.inboxCount(step.accountId||'a',step.cache),
          wrote:count.recountInbox(step.accountId||'a',step.cache)};break;
        case 'shift':result=count.shiftInbox(step.unreadOnly?count.unreadEntries(step.entries):step.entries,step.sign);break;
        case 'followUps':result=count.shiftFollowUps(step.before,step.after);break;
        case 'arrivals':result=count.addArrivals(step.accountId||'a',step.count);break;
        case 'merge':result=count.applyRecounts(step.measured);break;
        case 'forget':result=count.forgetAccount(step.accountId||'a');break;
        case 'rows':result={rows:count.unreadRows(settings.getState(),step.accounts||
          [{id:'a',name:'Alpha',email:'a@example.test'},{id:'b',name:'Beta',email:'b@example.test'}]),
          total:count.selectTotalUnread(settings.getState(),step.accounts||
          [{id:'a',name:'Alpha',email:'a@example.test'},{id:'b',name:'Beta',email:'b@example.test'}])};break;
        case 'visibility':result=rowVisibility({activeAccountId:step.accountId||'a',
          activeMailbox:step.mailbox||'INBOX',archivedEmailIds:list.archivedEmailIds,
          deleteTombstones:list.deleteTombstones,hiddenTagIds:autoTags.getState().hiddenTagIds(),
          tagsByRow:tags.getState().byRow,localSnoozes:new Set(),
          viewHidden:viewHide.getState().keys})(step.row);break;
        default:throw Error(`Unknown archived operation ${step.op}`);
      }
      outputs.push({input:snapshot(step),result:snapshot(result),
        counts:snapshot(settings.getState().unreadPerAccount)});
    }
    const actual={steps:outputs,writes:snapshot(writes),finalCounts:snapshot(settings.getState().unreadPerAccount)};
    assert.equal(JSON.stringify(actual),JSON.stringify(expected.output),`Archived replay differs: ${expected.id}`);
    observed++;
  }
  assert.equal(observed,fixture.caseCount);
  process.stdout.write(`W4S3_UNREAD_ARCHIVED_REPLAY_OK ${observed} ${sha(fs.readFileSync(fixturePath))}\n`);
})().catch(error=>{console.error(error);process.exitCode=1;});
