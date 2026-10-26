// Native import is one persistence boundary. A frontend cache status cannot
// authorize it; native read failure is never an empty store.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeAccountsDaemon } from '../../db/__tests__/fakeAccountsDaemon.js';
const h=vi.hoisted(()=>({status:'granted',file:'[]',stored:{},version:1,failCredential:false,failMetadata:false,calls:[]}));
vi.mock('../../db/keychain.js',()=>({parseKeychainValue:(id,v)=>JSON.parse(v),getAccountsFromKeychain:()=>[],loadKeychain:async()=>({}),saveCredentials:async()=>{throw new Error('obsolete split write')},deleteCredentials:async()=>{},updateCredentials:async()=>true,beginNativeWrite:()=>()=>{},readCurrentCredentials:async()=>({}),markNativeMutationUncertain:()=>{},invalidateCredentialsCache:()=>{}}));
vi.mock('../../keychainSession.js',()=>({getStatus:()=> 'stale-frontend-status',E_KEYCHAIN_UNAVAILABLE:'E_KEYCHAIN_UNAVAILABLE',E_KEYCHAIN_WRITE:'E_KEYCHAIN_WRITE'}));
vi.mock('../../transport.js',()=>({send:async(cmd,args)=>{h.calls.push([cmd,args]);if(cmd==='get_app_data_dir')return '/synthetic';return h.handler(cmd,args);}}));
vi.mock('../../graphConfig.js',()=>({isPersonalMicrosoftEmail:()=>false}));
vi.mock('../../../i18n/index.js',()=>({t:k=>k}));
vi.mock('@tauri-apps/plugin-fs',()=>({exists:async()=>true,mkdir:async()=>{},remove:async()=>{}}));
const {saveAccounts,__resetAccountsForTests}=await import('../../db/accounts.js');
const incoming=[{id:'a',email:'a@x.test',password:'synthetic-a'},{id:'b',email:'b@x.test',authType:'oauth2',oauth2AccessToken:'synthetic-at',oauth2RefreshToken:'synthetic-rt'}];
beforeEach(()=>{
  __resetAccountsForTests();h.status='granted';h.file=JSON.stringify([{id:'old',email:'old@x.test'}]);h.stored={old:JSON.stringify({id:'old',email:'old@x.test',password:'synthetic-keep'})};h.version=1;h.failCredential=false;h.failMetadata=false;h.calls=[];
  const daemon=fakeAccountsDaemon({read:()=>h.file,write:text=>{if(h.failMetadata)throw new Error('errors.accountsWriteFailed');h.file=text;},credentials:{read:()=>{if(!['granted','empty'].includes(h.status))throw new Error('errors.keychainUnavailable');return {...h.stored};},write:next=>{if(h.failCredential)throw new Error('errors.keychainWriteFailed');h.stored=next;h.version+=1;},version:()=>h.version}});
  h.handler=(cmd,args)=>daemon.call(cmd,args);
});
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
