/** Real backup buttons and exact native request receipts in the rebuilt app. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, openSettings, closeSettings, clickSettingsNav } from './helpers.js';
const wait = (predicate, timeout, message) => browser.waitUntil(predicate,{timeout,interval:200,timeoutMsg:message});
const invoke = (command,args={}) => browser.executeAsync((c,a,done) => { window.__TAURI__.core.invoke(c,a).then(done,e=>done({__error:String(e?.message||e)})); },command,args);
const rpc = (method,params={}) => invoke('daemon_rpc',{method,params});
const card = id => browser.execute(account => {
  const button = document.querySelector(`[data-testid="backup-account-card"][data-account-id="${account}"] [data-testid="backup-now-button"]`);
  return button ? {disabled:button.disabled,label:button.textContent.trim()} : null;
},id);
const lastStatus = id => browser.execute(account => window.__SETTINGS_STORE__.getState().backupState?.[account]?.lastStatus,id);
const click = selector => browser.execute(sel => { const button=document.querySelector(sel); if(!button||button.disabled)return false;button.scrollIntoView({block:'center',behavior:'instant'});button.click();return true; },selector);

describe('Backup buttons use the native queue and retained results',function(){
  this.timeout(360000);
  let luke,vader,root;
  before(async function(){
    await waitForApp();await waitForEmails();
    await wait(()=>browser.execute(()=>!!window.__BACKUP_SCHEDULER__&&!!window.__SETTINGS_STORE__),20000,'Native backup probe unavailable');
    luke=browser.mockAccounts.find(a=>a.email==='luke@mock.test');vader=browser.mockAccounts.find(a=>a.email==='vader@mock.test');
    root=mkdtempSync(join(tmpdir(),'mv-native-manual-'));const saved=await invoke('backup_save_external_location',{path:root});assert.equal(saved?.__error,undefined);
    await browser.execute(()=>window.__SETTINGS_STORE__.setState({language:'en',billingProfile:{hasSubscription:true,premiumAccess:true,status:'active',clientAccessGranted:true},backupGlobalEnabled:false,backupSchedules:{},hiddenAccounts:{},snapshotAutoEnabled:false,backupNotifyOnSuccess:false,backupNotifyOnFailure:false}));
    await wait(async()=>{const s=await rpc('settings.get');return s.values?.['mailvault-settings']?.state?.billingProfile?.hasSubscription===true;},15000,'Premium settings were not durable');
    await openSettings();assert.equal(await clickSettingsNav('Backup & Restore'),true);
    await browser.execute(()=>{const buttons=[...document.querySelectorAll('button')].filter(b=>b.offsetHeight>0&&b.textContent.trim()==='Backup Schedule');buttons.at(-1)?.click();});
    await wait(async()=>!!(await card(luke.id))&&!!(await card(vader.id)),15000,'Backup cards unavailable');
  });
  after(async function(){
    await rpc('backup.stop');await wait(async()=>{const s=await rpc('backup.schedule.status');return !s.active&&!s.queue.length;},30000,'Native backup did not drain');
    await closeSettings();if(root)rmSync(root,{recursive:true,force:true});
  });
  it('exposes native controls and daemon ownership',async function(){
    const status=await rpc('backup.schedule.get');assert.equal(status.owner,'daemon');assert.equal(status.automaticOwner,'daemon');
    assert.deepEqual(await browser.execute(()=>Object.keys(window.__BACKUP_SCHEDULER__).sort()),['status','stopAll','triggerManualBackup']);
  });
  it('runs the real manual button during an offline pause without clearing that pause',async function(){
    await browser.execute(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});window.dispatchEvent(new Event('offline'));});
    await wait(async()=>(await rpc('backup.schedule.status')).context?.paused===true,10000,'Offline observation did not reach native worker');
    assert.equal(await click(`[data-testid="backup-account-card"][data-account-id="${luke.id}"] [data-testid="backup-now-button"]`),true);
    await wait(async()=>!(await card(luke.id)).disabled&&['success','degraded'].includes(await lastStatus(luke.id)),180000,'Manual button did not settle its native receipt');
    assert.equal((await rpc('backup.schedule.status')).context.paused,true);
    const cur=join(root,luke.email,'INBOX','cur');assert.ok(existsSync(cur)&&readdirSync(cur).length>0,'No real mirrored messages');
    await browser.execute(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});window.dispatchEvent(new Event('online'));});
  });
  it('joins duplicate local manual clicks into one native request',async function(){
    const before=await rpc('backup.schedule.status');const count=Object.keys(before.requests).length;
    await browser.execute(id=>{window.__MANUAL_JOIN_RESULTS__=null;Promise.all([window.__BACKUP_SCHEDULER__.triggerManualBackup(id),window.__BACKUP_SCHEDULER__.triggerManualBackup(id)]).then(results=>{window.__MANUAL_JOIN_RESULTS__=results;});},luke.id);
    await wait(()=>browser.execute(()=>window.__MANUAL_JOIN_RESULTS__?.length===2),180000,'Joined manual promises did not settle');
    const outcomes=await browser.execute(()=>window.__MANUAL_JOIN_RESULTS__);assert.ok(outcomes.every(r=>['success','degraded'].includes(r.status)));
    const after=await rpc('backup.schedule.status');assert.equal(Object.keys(after.requests).length,count+1,'Duplicate local clicks created two requests');
  });
  it('backs up all accounts from the real button while user interaction continues',async function(){
    assert.equal(await click('[data-testid="backup-all-button"]'),true);
    for(let i=0;i<3;i++){await browser.execute(()=>{document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}));document.dispatchEvent(new Event('click',{bubbles:true}));});await browser.pause(700);}
    await wait(async()=>{const s=await rpc('backup.schedule.status');return !s.active&&!s.queue.length&&['success','degraded'].includes(await lastStatus(vader.id));},240000,'Back up all did not drain');
    await wait(()=>browser.execute(()=>{const button=document.querySelector('[data-testid="backup-all-button"]');return button&&!button.disabled;}),15000,'Back up all button stayed disabled');
    for(const account of [luke,vader]){const cur=join(root,account.email,'INBOX','cur');assert.ok(existsSync(cur)&&readdirSync(cur).length>0,`${account.email} has no mirrored mail`);}
  });
});
