/** Fresh shell -> native worker -> provider/files/settings/manifest proof. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForApp, waitForEmails, openSettings } from './helpers.js';
import { appDataDir } from './mockImap.js';
const wait=(predicate,timeout,message)=>browser.waitUntil(predicate,{timeout,interval:250,timeoutMsg:message});
const invoke=(command,args={})=>browser.executeAsync((c,a,done)=>{window.__TAURI__.core.invoke(c,a).then(done,e=>done({__error:String(e?.message||e)}));},command,args);
const rpc=(method,params={})=>invoke('daemon_rpc',{method,params});
const stateOnDisk=()=>JSON.parse(readFileSync(join(appDataDir(browser.testDataDir),'frontend-settings.json'),'utf8'))['mailvault-settings']?.state;
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
const scheduleKeys=['enabled','interval','timeOfDay','dayOfWeek','dayOfMonth','weekday'];
const schedulingEvidence=(state,id)=>({
  now:Date.now(),backupGlobalEnabled:state?.backupGlobalEnabled,
  globalConfig:pick(state?.backupGlobalConfig,scheduleKeys),targetSchedule:pick(state?.backupSchedules?.[id],scheduleKeys),targetHidden:state?.hiddenAccounts?.[id],
  billing:pick(state?.billingProfile,['hasSubscription','clientAccessGranted','premiumAccess','status','currentPeriodEnd']),shareGrant:pick(state?.shareGrant,['expiresAt']),
  backupState:pick(state?.backupState?.[id],['lastBackupTime','lastStatus','lastSchedulerRunId','emailsBackedUp']),
  history:(state?.backupHistory?.[id]||[]).map(row=>pick(row,['timestamp','emailsBackedUp','durationSecs','success','errors','externalCopyOk','externalCopyFailedCount'])),
});
async function observeActualContext(){
  await browser.execute(()=>{
    const original=window.__TAURI__.core.invoke;
    const diagnostic={frames:[],events:[]};window.__BACKUP_CONTEXT_DIAGNOSTIC__=diagnostic;
    const append=(rows,row)=>{rows.push(row);if(rows.length>400)rows.shift();};
    const select=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,value[key]]));
    const wrapped=function(command,args){
      const observed=command==='daemon_rpc'&&args?.method==='backup.context';
      const frame=observed?{sentAt:Date.now(),payload:select(args.params,['surfaceId','sessionId','sequence','kind','lastActivityAt','loading','visibility','online','observedAt','heartbeatGap'])}:null;
      if(frame)append(diagnostic.frames,frame);
      const actual=original.call(this,command,args);
      if(frame)Promise.resolve(actual).then(reply=>{frame.repliedAt=Date.now();frame.reply=select(reply,['accepted','surfaceId','sessionId','sequence','retired']);},error=>{frame.repliedAt=Date.now();frame.errorName=error?.name;});
      return actual;
    };
    window.__TAURI__.core.invoke=wrapped;
    const event=e=>append(diagnostic.events,{at:Date.now(),type:e.type,trusted:e.isTrusted,online:navigator.onLine,visibility:document.visibilityState});
    const events=['keydown','click','mousemove','scroll','visibilitychange'];events.forEach(name=>document.addEventListener(name,event,{passive:true}));
    window.addEventListener('online',event);window.addEventListener('offline',event);
    diagnostic.restore=()=>{if(window.__TAURI__.core.invoke===wrapped)window.__TAURI__.core.invoke=original;events.forEach(name=>document.removeEventListener(name,event));window.removeEventListener('online',event);window.removeEventListener('offline',event);};
  });
}
const actualContextEvidence=()=>browser.execute(()=>({now:Date.now(),online:navigator.onLine,visibility:document.visibilityState,frames:window.__BACKUP_CONTEXT_DIAGNOSTIC__?.frames||[],events:window.__BACKUP_CONTEXT_DIAGNOSTIC__?.events||[]}));


describe('Native backup scheduler survives observers and owns automatic work',function(){
  this.timeout(720000);
  let luke,vader,root,main;
  before(async function(){
    await waitForApp();await waitForEmails();main=await browser.getWindowHandle();
    await wait(()=>browser.execute(()=>!!window.__BACKUP_UI_OBSERVER__&&!!window.__BACKUP_SCHEDULER__),20000,'Native observer diagnostics unavailable');
    luke=browser.mockAccounts.find(a=>a.email==='luke@mock.test');vader=browser.mockAccounts.find(a=>a.email==='vader@mock.test');
    root=mkdtempSync(join(tmpdir(),'mv-native-scheduler-'));assert.equal((await invoke('backup_save_external_location',{path:root}))?.__error,undefined);
    await browser.execute(()=>{
      window.__SETTINGS_STORE__.setState({language:'en',billingProfile:{hasSubscription:true,premiumAccess:true,status:'active',clientAccessGranted:true},backupGlobalEnabled:false,backupSchedules:{},snapshotAutoEnabled:true,snapshotCadence:'after_every_backup',backupNotifyOnSuccess:false,backupNotifyOnFailure:false});
      const original=window.__TAURI__.core.invoke;window.__AUTOMATIC_UI_SNAPSHOT_CALLS__=0;
      window.__TAURI__.core.invoke=function(command,args){if(command==='snapshot_create_from_maildir'||(command==='daemon_rpc'&&args?.method==='snapshot.create_from_maildir'))window.__AUTOMATIC_UI_SNAPSHOT_CALLS__++;return original.call(this,command,args);};
    });
    await wait(async()=>{const s=await rpc('settings.get');return s.values?.['mailvault-settings']?.state?.snapshotAutoEnabled===true;},15000,'Snapshot settings were not durable');
  });
  after(async function(){
    if((await browser.getWindowHandles()).includes(main))await browser.switchToWindow(main);
    await rpc('backup.stop');await wait(async()=>{const s=await rpc('backup.schedule.status');return !s.active&&!s.queue.length;},30000,'Worker did not drain after Stop');
    await browser.execute(()=>window.__BACKUP_UI_OBSERVER__?.attach());if(root)rmSync(root,{recursive:true,force:true});
  });
  it('keeps unavailable access pending, joins two requests and completes once with no UI observer or snapshot call',async function(){
    rmSync(root,{recursive:true,force:true});
    const first=await rpc('backup.run_now',{accountId:luke.id,requestId:'native-access-first'});
    const joined=await rpc('backup.run_now',{accountId:luke.id,requestId:'native-access-joined'});assert.equal(first.runId,joined.runId);
    await wait(async()=>(await rpc('backup.schedule.status')).pendingAccess?.some(i=>i.runId===first.runId),15000,'Configured unavailable access did not stay pending');
    assert.equal(existsSync(root),false,'A missing mount point was recreated');assert.equal(stateOnDisk().backupHistory?.[luke.id]?.length||0,0,'Pending access was filed as success');
    await browser.execute(()=>window.__BACKUP_UI_OBSERVER__.detach());
    mkdirSync(root,{recursive:true});assert.equal((await invoke('backup_save_external_location',{path:root}))?.__error,undefined);
    await rpc('backup.run_now',{accountId:luke.id,requestId:'native-access-first'});
    await wait(async()=>{const s=await rpc('backup.schedule.status');return s.requests?.['native-access-first']?.status==='success'&&s.requests?.['native-access-joined']?.status==='success';},180000,'Native authorized attach did not complete joined requests');
    await wait(async()=>{const s=await rpc('backup.schedule.status');return s.lastOutcomes.some(o=>o.intent.runId===first.runId&&o.snapshot?.status==='applied');},30000,'Native automatic manifest did not finish bookkeeping');
    const saved=stateOnDisk();assert.equal(saved.backupHistory[luke.id].length,1);assert.ok(saved.snapshotLastTimes[luke.id]>0);
    const files=readdirSync(join(root,luke.email,'INBOX','cur'));assert.ok(files.length>0,'Provider wrote no mirrored messages');
    const manifests=readdirSync(join(appDataDir(browser.testDataDir),'snapshots',luke.id)).filter(f=>f.endsWith('.gz'));assert.equal(manifests.length,1);
    assert.equal(await browser.execute(()=>window.__AUTOMATIC_UI_SNAPSHOT_CALLS__),0,'UI created the automatic snapshot');
    await browser.execute(()=>window.__BACKUP_UI_OBSERVER__.attach());
    await browser.executeAsync(done=>window.__TAURI__.event.emit('daemon-events-lagged',{}).then(()=>done(true)));
    const replay=await rpc('backup.run_now',{accountId:luke.id,requestId:'native-access-first'});assert.equal(replay.runId,first.runId);assert.equal(stateOnDisk().backupHistory[luke.id].length,1);
  });
  it('aggregates main loading and child activity, then admits automatically after native idle with its observer detached',async function(){
    await observeActualContext();
    await openSettings();assert.equal(await browser.execute(()=>{const button=document.querySelector('[data-testid="settings-detach"]');button?.click();return !!button;}),true);
    await wait(async()=>(await browser.getWindowHandles()).length===2,15000,'Settings did not detach');
    const child=(await browser.getWindowHandles()).find(h=>h!==main);
    await browser.switchToWindow(child);await observeActualContext();
    await browser.switchToWindow(main);
    await browser.execute(id=>{
      window.__MAIL_STORE__.setState({loading:true});
      const hidden=Object.fromEntries(window.__MAIL_STORE__.getState().accounts.filter(a=>a.id!==id).map(a=>[a.id,true]));
      window.__SETTINGS_STORE__.setState({hiddenAccounts:hidden});
    },vader.id);
    await wait(async()=>(await rpc('backup.schedule.status')).context?.loading===true,10000,'Main loading was not observed');
    await rpc('backup.schedule.set',{patch:{backupGlobalEnabled:true,backupGlobalConfig:{interval:'daily',timeOfDay:'03:00'},snapshotAutoEnabled:false}});
    const idleStart=Date.now();
    await wait(async()=>Date.now()-idleStart>=185000,190000,'Native idle observation period did not elapse');
    let s=await rpc('backup.schedule.status');assert.equal(s.context.loading,true,'Child false cleared main loading');assert.equal(s.active,null);assert.ok(!s.queue.some(i=>i.accountId===vader.id));
    await browser.switchToWindow(child);await browser.execute(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true})));
    console.log('NATIVE_IDLE_CHILD_CONTEXT '+JSON.stringify(await actualContextEvidence()));
    await browser.closeWindow();await browser.switchToWindow(main);
    await wait(async()=>(await browser.getWindowHandles()).length===1,15000,'Child window did not retire');
    await browser.execute(()=>{window.__BACKUP_UI_OBSERVER__.detach();window.__MAIL_STORE__.setState({loading:false});});
    await wait(async()=>(await rpc('backup.schedule.status')).context?.loading===false,10000,'Main loading did not clear');
    s=await rpc('backup.schedule.status');assert.ok(Date.now()-s.context.lastActivityAt<15000,'Child activity did not survive native retirement');assert.ok(!s.active&&!s.queue.length,'Recent child activity did not gate admission');
    console.log('NATIVE_IDLE_BEFORE_SETTINGS '+JSON.stringify(schedulingEvidence(stateOnDisk(),vader.id)));
    try {
      await wait(async()=>stateOnDisk().backupHistory?.[vader.id]?.some(h=>h.success===true),240000,'Native idle deadline never admitted the automatic account');
    } finally {
      // Observe after the bounded waiter, never add an RPC or poll during it.
      try {
        console.log('NATIVE_IDLE_AFTER_CONTEXT '+JSON.stringify(await actualContextEvidence()));
        const status=await rpc('backup.schedule.status');
        const intent=value=>pick(value,['accountId','runId','executionId','stage','manual','retries','notBefore','pauseRequested','cancelRequested']);
        console.log('NATIVE_IDLE_AFTER_STATUS '+JSON.stringify({now:Date.now(),ready:status.ready,context:status.context,active:intent(status.active),queue:(status.queue||[]).map(intent),pendingAccess:(status.pendingAccess||[]).map(intent),outcomes:(status.lastOutcomes||[]).map(outcome=>({at:outcome.at,status:outcome.status,applied:outcome.applied,intent:intent(outcome.intent)}))}));
        console.log('NATIVE_IDLE_AFTER_SETTINGS '+JSON.stringify(schedulingEvidence(stateOnDisk(),vader.id)));
      } catch(error) { console.log('NATIVE_IDLE_DIAGNOSTIC_ERROR '+error?.name); }
      await browser.execute(()=>window.__BACKUP_CONTEXT_DIAGNOSTIC__?.restore());
    }
    s=await rpc('backup.schedule.status');const outcome=s.lastOutcomes.find(o=>o.intent.accountId===vader.id&&o.status==='success');assert.ok(outcome);assert.equal(outcome.intent.manual,false);
    assert.ok(readdirSync(join(root,vader.email,'INBOX','cur')).length>0);assert.equal(await browser.execute(()=>window.__AUTOMATIC_UI_SNAPSHOT_CALLS__),0);
  });
  it('keeps explicit Stop latched through delayed surface facts',async function(){
    await rpc('backup.stop');
    await browser.execute(()=>{window.__MAIL_STORE__.setState({loading:true});window.__MAIL_STORE__.setState({loading:false});document.dispatchEvent(new Event('visibilitychange'));});
    await browser.pause(20000);
    const s=await rpc('backup.schedule.status');assert.equal(s.context.automaticEnabled,false);assert.equal(s.active,null);assert.equal(s.queue.length,0);
  });
});
