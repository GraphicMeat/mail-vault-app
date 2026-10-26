// @vitest-environment jsdom
// Real Settings/compose/import callers and account adapters; only the native
// transport, filesystem and provider boundaries are synthetic.
import React from 'react';
import { writeFileSync } from 'node:fs';
const traces=[];
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { fakeAccountsDaemon } from '../../../services/db/__tests__/fakeAccountsDaemon.js';
const h=vi.hoisted(()=>({blob:{},file:'[]',version:0,calls:[],boxes:[],beforeWrite:null,exchange:{},handler:async cmd=>cmd==='get_app_data_dir'?'/synthetic':{}}));
vi.mock('../../../services/transport.js',()=>({send:(cmd,args={})=>h.handler(cmd,args)}));
vi.mock('@tauri-apps/plugin-shell',()=>({open:async()=>{}}));
vi.mock('@tauri-apps/plugin-fs',()=>({exists:async()=>true,mkdir:async()=>{},remove:async()=>{}}));
vi.mock('../../../services/db',async()=>({...await import('../../../services/db/accounts.js'),getCachedMailboxes:async()=>h.boxes,saveMailboxes:async()=>{}}));
vi.mock('../../../services/db/index.js',async()=>({...await import('../../../services/db/accounts.js'),getCachedMailboxes:async()=>h.boxes,saveMailboxes:async()=>{}}));
vi.mock('../../../services/api',async original=>({...await original(),ensureSentMailbox:async()=> 'Sent created',fetchMailboxes:async()=>[{path:'Sent created',name:'Sent created'}],getOAuth2AuthUrl:async()=>({authUrl:'https://example.test/auth',state:'synthetic-state'}),exchangeOAuth2Code:async()=>h.exchange}));
vi.mock('../../../services/daemonClient',()=>({daemonCall:async(method,args)=>{h.calls.push([method,args]);return {};}}));
vi.mock('../../../stores/safeStorage',()=>({safeStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},safeStorageWritable:()=>true,flushSafeStorage:async()=>{}}));
import { AccountSettings } from '../AccountSettings';
import { useMailStore } from '../../../stores/mailStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { t } from '../../../i18n';
import * as accounts from '../../../services/db/accounts.js';
import * as keychain from '../../../services/db/keychain.js';
import { resolveSentMailboxForAccount } from '../../../services/composeSend';
import { applyImport } from '../../../services/workflows/transferAccounts';
const stale=()=>({id:'g',name:'Personal',email:'me@example.test',imapHost:'h',authType:'oauth2',oauth2Provider:'google',oauth2AccessToken:'synthetic-old-at',oauth2RefreshToken:'synthetic-old-rt',oauth2ExpiresAt:1});
const fresh=a=>({...a,oauth2AccessToken:'synthetic-new-at',oauth2RefreshToken:'synthetic-new-rt',oauth2ExpiresAt:99});
const metadata=a=>Object.fromEntries(Object.entries(a).filter(([k])=>!['password','oauth2AccessToken','oauth2RefreshToken'].includes(k)));
const pairSurvived=()=>{const a=JSON.parse(h.blob.g);return a.oauth2AccessToken==='synthetic-new-at'&&a.oauth2RefreshToken==='synthetic-new-rt'&&a.oauth2ExpiresAt===99;};
beforeEach(()=>{
  accounts.__resetAccountsForTests();keychain.__resetKeychainForTests();
  h.blob={g:JSON.stringify(fresh(stale()))};h.file=JSON.stringify([metadata(stale())]);h.version=1;h.calls=[];h.boxes=[{path:'Sent chosen',name:'Sent chosen'}];h.beforeWrite=null;h.exchange={accessToken:'synthetic-signin-at',refreshToken:'synthetic-signin-rt',expiresAt:999};
  const daemon=fakeAccountsDaemon({read:()=>h.file,write:text=>{h.file=text;},credentials:{read:()=>({...h.blob}),write:next=>{h.blob=next;h.version+=1;},version:()=>h.version}});
  h.handler=async(cmd,args)=>{
    h.calls.push([cmd,args]);
    if(cmd==='get_app_data_dir')return '/synthetic';
    if(cmd==='credentials.get'||cmd==='get_credentials')return {status:Object.keys(h.blob).length?'granted':'empty',credentials:{...h.blob}};
    if(cmd==='credentials.save') {if(h.beforeWrite){const f=h.beforeWrite;h.beforeWrite=null;f();}Object.assign(h.blob,args.records);return {saved:Object.keys(args.records),version:++h.version};}
    if(cmd==='credentials.update'){if(!h.blob[args.id])return {updated:false,version:h.version};h.blob[args.id]=JSON.stringify({...JSON.parse(h.blob[args.id]),...args.fields});return {updated:true,version:++h.version};}
    if(cmd==='credentials.delete'){args.ids.forEach(id=>delete h.blob[id]);return {deleted:args.ids,version:++h.version};}
    if(cmd==='accounts_fallback')return daemon.call(args.method,args.params);
    if(cmd==='accounts.save'&&h.beforeWrite){const f=h.beforeWrite;h.beforeWrite=null;f();}
    if(cmd.startsWith('accounts.'))return daemon.call(cmd,args);
    return {};
  };
  window.__TAURI__={core:{invoke:(cmd,args)=>h.handler(cmd,args)},event:{listen:async()=>()=>{}}};
  vi.spyOn(window,'alert').mockImplementation(()=>{});
  useSettingsStore.setState({signatures:{},displayNames:{},sendAsAddresses:{},accountColors:{},accountOrder:[],hiddenAccounts:{},notificationSettings:{accounts:{}}});
  useMailStore.setState({accounts:[stale()],activeAccountId:'g',activeMailbox:'INBOX',mailboxes:[],connectionStatus:'connected',connectionError:null,connectionErrorType:null,init:async()=>{}});
});
afterEach(()=>{if(process.env.MV_S2_CALLER_TRACE)writeFileSync(process.env.MV_S2_CALLER_TRACE,JSON.stringify({source:'b9c9b2512ff570c3b95b00cc9439edb546b8ad56',traces},null,2)+'\n');cleanup();vi.restoreAllMocks();});
async function settings(){render(<AccountSettings accounts={[stale()]} initialSection="connection"/>);await screen.findByRole('combobox',{name:t('settings.accounts.sentFolder2')});}
it('explicit Settings Sent selection preserves native rotated credentials',async()=>{
  await settings();fireEvent.change(screen.getByRole('combobox',{name:t('settings.accounts.sentFolder2')}),{target:{value:'Sent chosen'}});fireEvent.click(screen.getByRole('button',{name:t('settings.accounts.saveSentFolder')}));
  await waitFor(()=>expect(JSON.parse(h.file).find(a=>a.id==='g').sentFolderOverride).toBe('Sent chosen'));
  traces.push({caller:'settings-sent',saved:JSON.parse(h.file).find(a=>a.id==='g').sentFolderOverride,ui:useMailStore.getState().accounts[0].sentFolderOverride});
  expect(pairSurvived(),'Settings must preserve newer native pair').toBe(true);
  expect(useMailStore.getState().accounts[0].sentFolderOverride).toBe('Sent chosen');
});
it('Settings auto-create Sent preserves native rotated credentials',async()=>{
  await settings();fireEvent.click(screen.getByRole('button',{name:t('settings.accounts.autoDetectCreate')}));
  await waitFor(()=>expect(JSON.parse(h.file).find(a=>a.id==='g').sentFolderOverride).toBe('Sent created'));
  traces.push({caller:'settings-create-sent',saved:JSON.parse(h.file).find(a=>a.id==='g').sentFolderOverride,ui:useMailStore.getState().accounts[0].sentFolderOverride});
  expect(pairSurvived(),'auto-create must preserve newer native pair').toBe(true);
  expect(useMailStore.getState().accounts[0].sentFolderOverride).toBe('Sent created');
});
it('actual compose Sent resolution preserves native rotated credentials',async()=>{
  h.boxes=[];
  const result=await resolveSentMailboxForAccount(stale());
  traces.push({caller:'compose-sent',path:result.path,ui:useMailStore.getState().accounts[0].sentFolderOverride});
  expect(result.path).toBe('Sent created');expect(pairSurvived(),'compose must preserve newer native pair').toBe(true);
});
it('actual transfer import excludes concurrent native duplicates from count and settings',async()=>{
  const file={id:'file-new',email:'new@example.test',imapHost:'h',password:'synthetic-import'};
  h.beforeWrite=()=>{const concurrent={...file,id:'native-winner',password:'synthetic-winner'};h.blob[concurrent.id]=JSON.stringify(concurrent);h.file=JSON.stringify([...JSON.parse(h.file),metadata(concurrent)]);};
  const result=await applyImport({accounts:[file],accountSettings:{signatures:{'file-new':{html:'file signature'}}},accountOrder:['file-new']},{selectedIds:['file-new'],applyAppSettings:false});
  traces.push({caller:'concurrent-import',imported:result.imported,settings:useSettingsStore.getState().signatures});
  expect(result.imported).toBe(0);expect(useSettingsStore.getState().signatures).toEqual({});
  expect(Object.keys(h.blob).sort()).toEqual(['g','native-winner']);
});

for(const stamped of [true,false])it(`actual reconnect persists one grant and ${stamped?'replaces':'unsets'} the old client stamp`,async()=>{
  const account={...stale(),oauth2ClientId:'old-client'};h.blob.g=JSON.stringify({...fresh(account),name:'Native current name'});h.file=JSON.stringify([metadata(account)]);
  if(stamped)h.exchange.clientId='new-client';
  render(<AccountSettings accounts={[account]} initialSection="connection"/>);
  fireEvent.click(screen.getByRole('button',{name:t('settings.accounts.reconnect')}));
  await waitFor(()=>expect(JSON.parse(h.blob.g).oauth2RefreshToken==='synthetic-signin-rt').toBe(true));
  const stored=JSON.parse(h.blob.g),meta=JSON.parse(h.file)[0];expect(stored.oauth2AccessToken==='synthetic-signin-at'&&stored.oauth2ExpiresAt===999).toBe(true);expect(stored.name).toBe('Native current name');
  if(stamped){expect(stored.oauth2ClientId).toBe('new-client');expect(meta.oauth2ClientId).toBe('new-client');}else{expect(Object.hasOwn(stored,'oauth2ClientId')).toBe(false);expect(Object.hasOwn(meta,'oauth2ClientId')).toBe(false);}
  const writes=h.calls.filter(([cmd])=>cmd==='accounts.save');expect(writes).toHaveLength(1);expect(Object.keys(writes[0][1].patch.fields).sort()).toEqual(stamped?['oauth2AccessToken','oauth2ClientId','oauth2ExpiresAt','oauth2RefreshToken']:['oauth2AccessToken','oauth2ExpiresAt','oauth2RefreshToken']);
});
it('password edit patches only the new secret without store_password or stale tokens',async()=>{
  const account={...stale(),authType:'password',password:'synthetic-old-password'};h.blob.g=JSON.stringify(fresh(account));h.file=JSON.stringify([metadata(account)]);
  render(<AccountSettings accounts={[account]} initialSection="connection"/>);
  fireEvent.click(screen.getByRole('button',{name:t('settings.accounts.update')}));fireEvent.change(screen.getByLabelText(t('settings.accounts.newPassword')),{target:{value:'synthetic-new-password'}});fireEvent.click(screen.getByRole('button',{name:t('settings.accounts.savePassword')}));
  await waitFor(()=>expect(JSON.parse(h.blob.g).password==='synthetic-new-password').toBe(true));expect(pairSurvived()).toBe(true);expect(h.calls.some(([cmd])=>cmd==='store_password')).toBe(false);
  const patch=h.calls.find(([cmd])=>cmd==='accounts.save')[1].patch;expect(Object.keys(patch.fields)).toEqual(['password']);expect(patch.expected.fields.authType).toBe('password');
});
it('failed optional compose persistence retains the current send path without marking the account saved',async()=>{
  h.boxes=[];const real=h.handler;h.handler=async(cmd,args)=>{if(cmd==='accounts.save')throw new Error('errors.accountsWriteFailed');return real(cmd,args);};
  const result=await resolveSentMailboxForAccount(stale());expect(result.path).toBe('Sent created');expect(useMailStore.getState().accounts[0].sentFolderOverride).toBeUndefined();expect(JSON.parse(h.file)[0].sentFolderOverride).toBeUndefined();expect(pairSurvived()).toBe(true);
});

for(const kind of ['missing','overlap','unknown accepted','unknown skipped'])it(`fix1 actual import stops all settings and config effects for ${kind} completion`,async()=>{
  const file={id:'file-new',email:'new@example.test',imapHost:'h',password:'synthetic-import'};
  const accepted=kind==='overlap'?['file-new']:kind==='unknown accepted'?['alien']:[];
  const skipped=kind==='overlap'?{'file-new':'g'}:kind==='unknown skipped'?{alien:'g'}:{};
  const reply={accounts:accepted.map(id=>({id,email:'new@example.test',imapHost:'h'})),accepted,skipped,version:2,credentialVersion:2,hostChanged:false};
  const real=h.handler;h.handler=async(cmd,args)=>cmd==='accounts.save'?reply:real(cmd,args);
  useSettingsStore.setState({undoSendDelay:5,signatures:{g:{html:'keep existing'}}});
  const bundle={accounts:[file],accountSettings:{signatures:{'file-new':{html:'must not apply'}}},appSettings:{undoSendDelay:32},appConfig:{views:[]},accountOrder:['file-new']};
  let failure;try{await applyImport(bundle,{selectedIds:['file-new'],applyAppSettings:true});}catch(error){failure=error;}
  expect.soft(useSettingsStore.getState().undoSendDelay).toBe(5);
  expect.soft(useSettingsStore.getState().signatures).toEqual({g:{html:'keep existing'}});
  expect.soft(h.calls.some(([cmd])=>cmd==='transfer.apply_config')).toBe(false);
  expect(failure?.message).toContain('E_KEYCHAIN_WRITE');
  expect(()=>keychain.assertLegacyWriteAllowed()).toThrow('errors.keychainWriteFailed');
});
