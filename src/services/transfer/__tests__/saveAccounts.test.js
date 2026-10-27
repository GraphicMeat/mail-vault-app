// Native import is one persistence boundary. A frontend cache status cannot
// authorize it; native read failure is never an empty store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAccountsDaemon } from '../../db/__tests__/fakeAccountsDaemon.js';
const h=vi.hoisted(()=>({status:'granted',file:'[]',stored:{},version:1,failCredential:false,failMetadata:false,calls:[],settings:{},configCalls:[]}));
vi.mock('../../db/keychain.js',()=>({parseKeychainValue:(id,v)=>JSON.parse(v),getAccountsFromKeychain:()=>[],loadKeychain:async()=>({}),saveCredentials:async()=>{throw new Error('obsolete split write')},deleteCredentials:async()=>{},updateCredentials:async()=>true,beginNativeWrite:()=>()=>{},readCurrentCredentials:async()=>({}),markNativeMutationUncertain:()=>{},invalidateCredentialsCache:()=>{}}));
vi.mock('../../keychainSession.js',()=>({getStatus:()=> 'stale-frontend-status',E_KEYCHAIN_UNAVAILABLE:'E_KEYCHAIN_UNAVAILABLE',E_KEYCHAIN_WRITE:'E_KEYCHAIN_WRITE'}));
vi.mock('../../transport.js',()=>({send:async(cmd,args)=>{h.calls.push([cmd,args]);if(cmd==='get_app_data_dir')return '/synthetic';return h.handler(cmd,args);}}));
vi.mock('../../graphConfig.js',()=>({isPersonalMicrosoftEmail:()=>false}));
vi.mock('../../../i18n/index.js',()=>({t:k=>k}));
vi.mock('@tauri-apps/plugin-fs',()=>({exists:async()=>true,mkdir:async()=>{},remove:async()=>{}}));
vi.mock('../../db',async()=>{const actual=await import('../../db/accounts.js');return {getAccounts:actual.getAccounts,saveAccounts:actual.saveAccounts,accountLogicalKey:actual.accountLogicalKey};});
vi.mock('../../daemonClient',()=>({daemonCall:async(method,args)=>{h.configCalls.push([method,args]);return {aiKeyError:false,contactsError:false};}}));
vi.mock('../../../stores/settingsStore',()=>({useSettingsStore:{getState:()=>h.settings,setState:patch=>Object.assign(h.settings,patch)},hasPremiumAccess:()=>false,FETCH_MODES:['onDemand','everything','hoarder']}));
vi.mock('../../../stores/themeStore',()=>({useThemeStore:{getState:()=>({theme:'dark',setTheme:()=>{}})}}));
vi.mock('../../../stores/safeStorage',()=>({flushSafeStorage:async()=>{}}));
const {saveAccounts,__resetAccountsForTests}=await import('../../db/accounts.js');
const {applyImport}=await import('../../workflows/transferAccounts.js');
const incoming=[{id:'a',email:'a@x.test',password:'synthetic-a'},{id:'b',email:'b@x.test',authType:'oauth2',oauth2AccessToken:'synthetic-at',oauth2RefreshToken:'synthetic-rt'}];
const nativeRetiredRefusal={jsonrpc:'2.0',id:1,result:{effects:'none',outcome:'retiredIdsRefused',retiredIds:['retired']}};
const nativeAcceptedRetry={jsonrpc:'2.0',id:1,result:{accepted:['remapped','fresh'],accounts:[
  {authType:'password',email:'retired@example.test',id:'remapped',imapHost:'h'},
  {authType:'password',email:'fresh@example.test',id:'fresh',imapHost:'h'},
],credentialVersion:1,hostChanged:false,skipped:{},version:3}};
const oldNativeBusy={jsonrpc:'2.0',id:1,error:{code:-32603,message:'errors.keychainBusy'}};
beforeEach(()=>{
  __resetAccountsForTests();h.status='granted';h.file=JSON.stringify([{id:'old',email:'old@x.test'}]);h.stored={old:JSON.stringify({id:'old',email:'old@x.test',password:'synthetic-keep'})};h.version=1;h.failCredential=false;h.failMetadata=false;h.calls=[];
  const daemon=fakeAccountsDaemon({read:()=>h.file,write:text=>{if(h.failMetadata)throw new Error('errors.accountsWriteFailed');h.file=text;},credentials:{read:()=>{if(!['granted','empty'].includes(h.status))throw new Error('errors.keychainUnavailable');return {...h.stored};},write:next=>{if(h.failCredential)throw new Error('errors.keychainWriteFailed');h.stored=next;h.version+=1;},version:()=>h.version}});
  h.handler=(cmd,args)=>cmd==='maildir_migrate_json_to_eml'?{}:daemon.call(cmd,args);
  h.configCalls=[];
  h.settings={signatures:{},accountOrder:[],notificationSettings:{accounts:{}},fetchModes:{}};
});
afterEach(()=>vi.unstubAllGlobals());
describe('native saveAccounts import',()=>{
  for(const status of ['denied','cancelled','timed_out','unavailable'])it(`native ${status} read refuses without target or metadata writes`,async()=>{
    h.status=status;const before={...h.stored};await expect(saveAccounts(incoming)).rejects.toThrow('E_KEYCHAIN_UNAVAILABLE');expect(h.stored).toEqual(before);expect(JSON.parse(h.file).map(a=>a.id)).toEqual(['old']);
  });
  it('sends one native batch, preserves unrelated records, and completes secret-free metadata',async()=>{
    const reply=await saveAccounts(incoming);expect(reply.accepted).toEqual(['a','b']);expect(Object.keys(h.stored).sort()).toEqual(['a','b','old']);expect(JSON.parse(h.stored.old).password==='synthetic-keep').toBe(true);expect(h.file).not.toMatch(/password|oauth2AccessToken|oauth2RefreshToken/);expect(h.calls.filter(([cmd])=>cmd==='accounts.save')).toHaveLength(1);expect(h.calls.some(([cmd])=>cmd==='credentials.save'||cmd==='accounts.put'||cmd==='store_credentials')).toBe(false);
  });
  it('keeps the issued client stamp next to its imported refresh token',async()=>{
    await saveAccounts([{...incoming[1],oauth2ClientId:'issued-client'}]);const row=JSON.parse(h.stored.b);expect(row.oauth2RefreshToken==='synthetic-rt'&&row.oauth2ClientId==='issued-client').toBe(true);
  });
  it('accepts native empty regardless of stale frontend read status',async()=>{h.status='empty';await saveAccounts(incoming);expect(Object.keys(h.stored).sort()).toEqual(['a','b','old']);});
  it('refuses credential failure with no metadata continuation',async()=>{h.failCredential=true;const before={...h.stored};await expect(saveAccounts(incoming)).rejects.toThrow('E_KEYCHAIN_WRITE: errors.keychainWriteFailed');expect(h.stored).toEqual(before);expect(JSON.parse(h.file).map(a=>a.id)).toEqual(['old']);});
  it('reports metadata failure truthfully after credential success without rollback',async()=>{h.failMetadata=true;await expect(saveAccounts(incoming)).rejects.toThrow('E_KEYCHAIN_WRITE: errors.accountsWriteFailed');expect(Object.keys(h.stored).sort()).toEqual(['a','b','old']);expect(JSON.parse(h.file).map(a=>a.id)).toEqual(['old']);});
  for(const reply of [undefined,{}, {version:2}, {accounts:[],accepted:['a'],skipped:{},version:2,credentialVersion:2,hostChanged:false}])it('malformed native completion is unknown failure without replay',async()=>{h.handler=()=>reply;await expect(saveAccounts(incoming)).rejects.toThrow(/^E_KEYCHAIN_WRITE/);expect(h.calls.filter(([cmd])=>cmd==='accounts.save')).toHaveLength(1);expect(h.calls.some(([cmd])=>cmd==='store_credentials'||cmd==='accounts_fallback')).toBe(false);});
});

it('retired transfer remaps once and applies accepted settings and config through the real save adapter',async()=>{
  // Exact native refusal and accepted retry frames captured by the P6 route
  // test. The fake daemon supplies only external persistence behind the real
  // db adapter and settings producer.
  vi.stubGlobal('crypto',{randomUUID:()=> 'remapped'});
  const base=h.handler;
  h.handler=(cmd,args)=>{
    if(cmd==='accounts.save'&&args.entries.some(row=>row.id==='retired'))return nativeRetiredRefusal.result;
    if(cmd==='accounts.save'){
      const persisted=base(cmd,args);
      expect(persisted.accepted).toEqual(nativeAcceptedRetry.result.accepted);
      return nativeAcceptedRetry.result;
    }
    return base(cmd,args);
  };
  const bundle={accounts:[{id:'retired',email:'retired@example.test',imapHost:'h',password:'synthetic-password'},
    {id:'fresh',email:'fresh@example.test',imapHost:'h',password:'synthetic-password'}],
    accountSettings:{signatures:{retired:{html:'retired signature'},fresh:{html:'fresh signature'}}},
    accountOrder:['retired','fresh'],appConfig:{tags:[]}};
  let result;
  try {
    result=await applyImport(bundle,{selectedIds:['retired','fresh'],applyAppSettings:true});
  } catch(error) {
    // Baseline observation: the real pre-P6 daemon error is generic Busy.
    // It gives no authority to remap or replay.
    expect(h.calls.filter(([cmd])=>cmd==='accounts.save').map(([,args])=>args.entries.map(row=>row.id)))
      .toEqual([['retired','fresh']]);
    expect(h.settings.signatures).toEqual({});
    expect(h.settings.accountOrder).toEqual([]);
    expect(h.configCalls).toEqual([]);
    throw error;
  }
  const saves=h.calls.filter(([cmd])=>cmd==='accounts.save');
  expect(saves).toHaveLength(2);
  expect(saves[0][1].entries.map(row=>row.id)).toEqual(['retired','fresh']);
  const remapped=saves[1][1].entries[0].id;
  expect(remapped).not.toBe('retired');
  expect(saves[1][1].entries.map(row=>row.id)).toEqual([remapped,'fresh']);
  expect(saves[1][1].entries[0].createdAt).toBe(saves[0][1].entries[0].createdAt);
  expect(result.imported).toBe(2);
  expect(h.settings.signatures).toEqual({[remapped]:{html:'retired signature'},fresh:{html:'fresh signature'}});
  expect(h.settings.accountOrder).toEqual(['old',remapped,'fresh']);
  expect(h.configCalls).toEqual([['transfer.apply_config',expect.objectContaining({accountMap:{retired:remapped,fresh:'fresh'}})]]);
  expect(JSON.parse(h.file).map(row=>row.id)).toEqual(['old','remapped','fresh']);
  expect(Object.keys(h.stored).sort()).toEqual(['fresh','old','remapped']);
});

it('the old generic Busy refusal never remaps or repeats',async()=>{
  const base=h.handler;
  h.handler=(cmd,args)=>cmd==='accounts.save'?Promise.reject(new Error(oldNativeBusy.error.message)):base(cmd,args);
  const bundle={accounts:[{id:'retired',email:'retired@example.test',imapHost:'h',password:'synthetic-password'}],
    accountSettings:{signatures:{retired:{html:'signature'}}},accountOrder:['retired'],appConfig:{tags:[]}};
  await expect(applyImport(bundle,{selectedIds:['retired'],applyAppSettings:true})).rejects.toThrow('E_KEYCHAIN_WRITE: errors.keychainBusy');
  expect(h.calls.filter(([cmd])=>cmd==='accounts.save').map(([,args])=>args.entries.map(row=>row.id))).toEqual([['retired']]);
  expect(h.settings.signatures).toEqual({});
  expect(h.configCalls).toEqual([]);
});

it('unknown save never remaps or repeats',async()=>{
  const base=h.handler;
  h.handler=(cmd,args)=>cmd==='accounts.save'?undefined:base(cmd,args);
  const bundle={accounts:[{id:'retired',email:'retired@example.test',imapHost:'h',password:'synthetic-password'}]};
  await expect(applyImport(bundle,{selectedIds:['retired'],applyAppSettings:true})).rejects.toThrow(/^E_KEYCHAIN_WRITE/);
  expect(h.calls.filter(([cmd])=>cmd==='accounts.save')).toHaveLength(1);
  expect(h.configCalls).toEqual([]);
});

it('malformed retirement refusal cannot retry',async()=>{
  const invalid=[
    {...nativeRetiredRefusal.result,retiredIds:[]},
    {...nativeRetiredRefusal.result,retiredIds:['retired','retired']},
    {...nativeRetiredRefusal.result,retiredIds:['foreign']},
    {...nativeRetiredRefusal.result,accepted:[]},
    {...nativeRetiredRefusal.result,effects:'unknown'},
  ];
  const bundle={accounts:[{id:'retired',email:'retired@example.test',imapHost:'h',password:'synthetic-password'}]};
  for(const reply of invalid){
    const base=h.handler;
    h.handler=(cmd,args)=>cmd==='accounts.save'?reply:base(cmd,args);
    await expect(applyImport(bundle,{selectedIds:['retired'],applyAppSettings:true})).rejects.toThrow(/^E_KEYCHAIN_WRITE/);
    expect(h.calls.filter(([cmd])=>cmd==='accounts.save')).toHaveLength(1);
    expect(h.configCalls).toEqual([]);
    h.calls=[];
    h.handler=base;
  }
});

it('second refusal stops with stable mapping and no settings or config effects',async()=>{
  vi.stubGlobal('crypto',{randomUUID:()=> 'remapped'});
  const base=h.handler;
  h.handler=(cmd,args)=>{
    if(cmd==='accounts.save')return args.entries[0].id==='retired'
      ?nativeRetiredRefusal.result:{...nativeRetiredRefusal.result,retiredIds:['remapped']};
    return base(cmd,args);
  };
  const bundle={accounts:[{id:'retired',email:'retired@example.test',imapHost:'h',password:'synthetic-password'}],
    accountSettings:{signatures:{retired:{html:'signature'}}},appConfig:{tags:[]}};
  await expect(applyImport(bundle,{selectedIds:['retired'],applyAppSettings:true})).rejects.toThrow('E_KEYCHAIN_WRITE: errors.keychainBusy');
  const saves=h.calls.filter(([cmd])=>cmd==='accounts.save').map(([,args])=>args.entries[0]);
  expect(saves.map(row=>row.id)).toEqual(['retired','remapped']);
  expect(saves[1].createdAt).toBe(saves[0].createdAt);
  expect(h.settings.signatures).toEqual({});
  expect(h.configCalls).toEqual([]);
});
