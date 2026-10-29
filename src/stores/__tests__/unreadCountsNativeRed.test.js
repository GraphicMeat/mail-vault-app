// Intended path: src/stores/__tests__/unreadCountsNativeRed.test.js
// Compiling behavioral RED against current old exports. Keep it test-only
// until the S3 oracle is committed and root releases the accepted S2 source.
import { expect, it, vi } from 'vitest';
const native=vi.fn();
vi.mock('../safeStorage',()=>({safeStorage:{getItem:()=>null,setItem(){},removeItem(){}},
  flushSafeStorage:async()=>{},safeStorageWritable:()=>true}));
vi.mock('../../services/daemonClient',()=>({daemonCall:(...args)=>native(...args)}));
const { useSettingsStore }=await import('../settingsStore');
const { recountInbox, shiftInbox }=await import('../unreadCounts');
const { useFollowUpStore }=await import('../followUpStore');
const { useSnoozeStore }=await import('../snoozeStore');
const { useViewHideStore }=await import('../viewHideStore');

it('sends a complete recount and a later raw shift through one native ordered lane',async()=>{
  useSettingsStore.setState({unreadPerAccount:{a:7,b:5},hiddenAccounts:{},
    displayNames:{},accountOrder:[],hideViewMail:false});
  useFollowUpStore.setState({rows:[]});
  useSnoozeStore.setState({rows:[]});
  useViewHideStore.setState({keys:null});
  let releaseFirst;
  const first=new Promise(resolve=>{releaseFirst=resolve;});
  native.mockReset().mockImplementationOnce(()=>first)
    .mockResolvedValueOnce({counts:{a:0,b:5},rows:[],total:0,wrote:true});
  const recount=recountInbox('a',{emails:[{uid:1,flags:[]},{uid:2,flags:['\\Seen']}],totalEmails:2});
  const shift=shiftInbox([{accountId:'a',mailbox:'INBOX',row:{uid:1,flags:[]}}],-1);
  expect(native, 'W4S3_ADAPTER_RED old count exports must submit the native route').toHaveBeenCalledTimes(1);
  expect(native.mock.calls[0][0]).toBe('counts.unread');
  expect(native.mock.calls[0][1]).toMatchObject({op:'recountRows',accountId:'a'});
  expect(useSettingsStore.getState().unreadPerAccount).toEqual({a:7,b:5});
  releaseFirst({counts:{a:1,b:5},rows:[],total:0,wrote:true});
  await Promise.all([recount,shift]);
  for(let n=0;n<5;n++) await Promise.resolve();
  expect(native).toHaveBeenCalledTimes(2);
  expect(native.mock.calls[1][1]).toMatchObject({op:'shift',sign:-1});
  expect(useSettingsStore.getState().unreadPerAccount).toEqual({a:0,b:5});
});
