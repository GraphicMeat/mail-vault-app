import {it,expect,vi} from 'vitest';
import {createInsightsReaderScope} from '../insightsReaderScope';
function setup(options={}){
 const row={uid:7,_accountId:'a',_mailbox:'Archive',messageId:'<seven>',subject:'Current',flags:['\\Seen']};
 const state={accounts:[{id:'a'}],activeAccountId:'a',activeMailbox:'Archive',unifiedInbox:false,emails:[row],sortedEmails:[row],localEmails:[],sentEmails:[],selectedEmailId:7,selectedEmail:{...row,flags:[]},selectedEmailSource:'server',selectedThread:null,searchQuery:'report',selectEmail:vi.fn(),selectThread:vi.fn(),closeEmail:vi.fn()};
 const mail={getState:()=>state};const cancel=vi.fn();return {state,row,cancel,scope:createInsightsReaderScope(mail,{cancelSelection:cancel,...options})};
}
it('restores the original reader through current flags and explicit location without rewriting mailbox state',async()=>{
 const h=setup();h.scope.enter();h.state.selectedEmailId='b:INBOX:7';h.state.selectedEmail={uid:7,_accountId:'b',_mailbox:'INBOX'};
 await h.scope.exit();expect(h.cancel).toHaveBeenCalled();
 expect(h.state.selectEmail).toHaveBeenCalledWith(7,'server','Archive',{accountId:'a',mailbox:'Archive',uid:7,header:h.row});
 expect(h.state.searchQuery).toBe('report');expect(h.state.sortedEmails).toEqual([h.row]);
});
it('does not resurrect a deleted or UID-reused message when returning',async()=>{
 const h=setup();h.scope.enter();h.state.emails=[{...h.row,messageId:'<reused>'}];h.state.sortedEmails=h.state.emails;
 await h.scope.exit();expect(h.state.selectEmail).not.toHaveBeenCalled();expect(h.state.closeEmail).toHaveBeenCalled();
});
it('leaves the reader closed when no original message was selected',async()=>{
 const h=setup();h.state.selectedEmailId=null;h.state.selectedEmail=null;h.scope.enter();await h.scope.exit();expect(h.state.closeEmail).toHaveBeenCalled();expect(h.state.selectEmail).not.toHaveBeenCalled();
});
it('never restores an account that was removed while Insights was open',async()=>{
 const h=setup();h.scope.enter();h.state.accounts=[];await h.scope.exit();expect(h.state.selectEmail).not.toHaveBeenCalled();expect(h.state.closeEmail).toHaveBeenCalled();
});

it('stamps an ordinary single-folder row on restore without modifying that row',async()=>{
 const h=setup();h.state.emails=[{uid:7,_srcAccountId:'a',messageId:'<seven>',flags:['\\Seen']}];h.state.sortedEmails=h.state.emails;
 h.scope.enter();await h.scope.exit();
 expect(h.state.selectEmail).toHaveBeenCalledWith(7,'server','Archive',expect.objectContaining({header:expect.objectContaining({_accountId:'a',_mailbox:'Archive',uid:7})}));
 expect(h.state.emails[0]).not.toHaveProperty('_mailbox');
});
it('cancels an ordinary pending read immediately on entering Insights',()=>{
 const h=setup();h.scope.enter();expect(h.cancel).toHaveBeenCalledOnce();
});
it('discards the previous reader when navigating directly to mail',async()=>{
 const h=setup();h.scope.enter();await h.scope.exit({restoreSelection:false});
 expect(h.state.closeEmail).toHaveBeenCalledOnce();expect(h.state.selectEmail).not.toHaveBeenCalled();
 await h.scope.exit();expect(h.state.selectEmail).not.toHaveBeenCalled();
});

function delayedReader() {
 let generation=0;
 const h=setup({getSelectionGeneration:()=>generation}), finishes=[];
 h.cancel.mockImplementation(()=>{++generation;});
 h.state.closeEmail.mockImplementation(()=>Object.assign(h.state,{selectedEmail:null,selectedEmailId:null,loadingEmail:false}));
 h.state.selectEmail.mockImplementation((uid,_source,_mailbox,{header})=>{
   const request=++generation;
   h.state.selectedEmailId=uid;h.state.loadingEmail=true;
   return new Promise(resolve=>finishes.push(()=>{
     if(request===generation)Object.assign(h.state,{selectedEmail:{...header,html:'restored body'},loadingEmail:false});
     resolve(request===generation);
   }));
 });
 return {...h,finishes};
}

it('cancels the pending restore before mail navigation and clears its loader',async()=>{
 const h=delayedReader();h.scope.enter();const leaving=h.scope.exit();
 expect(h.state.loadingEmail).toBe(true);
 h.scope.cancelRestore?.();
 h.state.activeMailbox='Other';
 h.finishes[0]();await leaving;
 expect(h.state.selectedEmail).toBeNull();
 expect(h.state.loadingEmail).toBe(false);
});

it('leaves an unrelated ordinary read alone when no restore is pending',async()=>{
 const h=delayedReader();h.scope.enter();const leaving=h.scope.exit();h.finishes[0]();await leaving;
 const ordinary={uid:9,html:'ordinary message'};
 Object.assign(h.state,{selectedEmail:ordinary,selectedEmailId:9,loadingEmail:true});
 const calls=h.cancel.mock.calls.length;
 h.scope.cancelRestore?.();
 expect(h.cancel).toHaveBeenCalledTimes(calls);
 expect(h.state.selectedEmail).toBe(ordinary);expect(h.state.loadingEmail).toBe(true);
});

it('invalidates a pending restore on the next Insights entry',async()=>{
 const h=delayedReader();h.scope.enter();const leaving=h.scope.exit();
 h.scope.enter();h.finishes[0]();await leaving;
 expect(h.state.selectedEmail).toBeNull();expect(h.state.loadingEmail).toBe(false);
});

it('an older restore finishing cannot detach cancellation from a newer restore',async()=>{
 const h=delayedReader();h.scope.enter();const first=h.scope.exit();
 h.scope.enter();await h.scope.exit({restoreSelection:false});
 h.state.selectedEmail=h.row;h.state.selectedEmailId=h.row.uid;
 h.scope.enter();const second=h.scope.exit();
 h.finishes[0]();await first;
 h.scope.cancelRestore?.();h.finishes[1]();await second;
 expect(h.state.selectedEmail).toBeNull();expect(h.state.loadingEmail).toBe(false);
});

it('drops restore ownership after a restore failure',async()=>{
 const h=setup();h.state.selectEmail.mockRejectedValueOnce(new Error('Body unavailable'));
 h.scope.enter();await expect(h.scope.exit()).rejects.toThrow('Body unavailable');
 const calls=h.cancel.mock.calls.length;h.scope.cancelRestore?.();
 expect(h.cancel).toHaveBeenCalledTimes(calls);
});


it('leaves a newer ordinary selection alive while an older restore is still unresolved',async()=>{
 const h=delayedReader();h.scope.enter();const leaving=h.scope.exit();
 const ordinary={...h.row,uid:9,messageId:'<nine>',subject:'New ordinary selection'};
 const current=h.state.selectEmail(9,'server','Archive',{header:ordinary});
 const calls=h.cancel.mock.calls.length;
 h.scope.cancelRestore?.();
 expect(h.cancel).toHaveBeenCalledTimes(calls);
 expect(h.state.selectedEmailId).toBe(9);expect(h.state.loadingEmail).toBe(true);
 h.finishes[0]();await leaving;
 h.finishes[1]();await current;
 expect(h.state.selectedEmail).toMatchObject({uid:9,subject:'New ordinary selection'});
 expect(h.state.loadingEmail).toBe(false);
});
