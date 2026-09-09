import {buildThreads} from '../utils/emailParser';
import {resolveEmailLocation} from '../stores/slices/unifiedHelpers';

/** Capture identity, never a stale body/flag object, when leaving the mail workspace. */
export function createInsightsReaderScope(mailStore,{cancelSelection=()=>{},getSelectionGeneration=()=>null}={}) {
  let prior=null, pendingRestore=null;
  const cancelRestore=()=>{
    if(!pendingRestore)return false;
    const restore=pendingRestore;pendingRestore=null;
    if(restore.generation!==getSelectionGeneration())return false;
    cancelSelection();mailStore.getState().closeEmail();
    return true;
  };
  return {
    cancelRestore,
    enter() {
      if(prior)return;
      if(!cancelRestore())cancelSelection();
      const state=mailStore.getState(), email=state.selectedEmail || state.selectedThread?.lastEmail;
      const location=email ? resolveEmailLocation(email,state) : null;
      prior={accountId:state.activeAccountId,mailbox:state.activeMailbox,unified:state.unifiedInbox,
        location:location?{...location,uid:email.uid}:null, messageId:email?.messageId || null,source:state.selectedEmailSource || 'server',threadId:state.selectedThread?.threadId || null};
    },
    async exit({restoreSelection=true}={}) {
      if(!cancelRestore())cancelSelection();
      const saved=prior;prior=null;
      const state=mailStore.getState();state.closeEmail();
      if(!restoreSelection || !saved?.location || saved.accountId!==state.activeAccountId || saved.mailbox!==state.activeMailbox || saved.unified!==state.unifiedInbox)return;
      const {accountId,mailbox,uid}=saved.location;
      if(!state.accounts.some(a=>a.id===accountId))return;
      const pool=[...(state.emails || []),...(state.sortedEmails || []),...(state.localEmails || []),...(state.sentEmails || [])];
      const header=pool.find(row=>{const loc=resolveEmailLocation(row,state);return loc?.accountId===accountId && loc.mailbox===mailbox && row.uid===uid && (!saved.messageId || row.messageId===saved.messageId);});
      if(!header)return;
      if(saved.threadId) {
        const thread=buildThreads(state.getChatEmails?.() || pool).get(saved.threadId);
        if(thread) {state.selectThread(thread);return;}
      }
      const restore={};pendingRestore=restore;
      try {
        const selection=state.selectEmail(uid,saved.source,mailbox,{accountId,mailbox,uid,header:{...header,_accountId:accountId,_mailbox:mailbox}});
        restore.generation=getSelectionGeneration();
        await selection;
      } finally {
        if(pendingRestore===restore)pendingRestore=null;
      }
    },
  };
}
