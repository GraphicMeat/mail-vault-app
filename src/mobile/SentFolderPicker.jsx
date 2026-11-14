// The folder an account's Sent copies go to (`sentFolder`), on its own page (AccountEditor.jsx), as
// desktop's "Sent folder": found automatically (the server's `\Sent`, '' here) or one of the
// account's folders (`mobile.folders.list`). Controlled: the editor's Save writes it. A choice that
// is no longer a folder stays listed, so it can be seen and cleared; the engine files the copy in
// the server's Sent while the picked one is gone. Only IMAP accounts: Graph and JMAP servers file
// the Sent copy themselves, where they keep it.
import React, { useEffect, useId, useState } from 'react';
import { daemonCall } from './transport.js';
import { useT } from './i18n.js';

/** Whether the phone files `account`'s Sent copy itself (over IMAP), so the folder can be picked. */
export function picksSentFolder(account) {
  return (account?.kind || 'imap') === 'imap';
}

export default function SentFolderPicker({ accountId, value, onChange }) {
  const t = useT();
  const id = useId();
  const [folders, setFolders] = useState([]);
  useEffect(() => {
    let live = true;
    daemonCall('mobile.folders.list', { accountId }).then(
      (r) => { if (live) setFolders((r?.folders || []).filter((f) => !f.noselect)); },
      () => {},
    );
    return () => { live = false; };
  }, [accountId]);
  const paths = folders.map((f) => f.path);
  if (value && !paths.includes(value)) paths.push(value);
  return (
    <label className="mv-setting mv-setting--choice" htmlFor={id}>
      <span className="mv-setting__text">
        <span className="mv-setting__label">{t('settings.accounts.sentFolder2')}</span>
      </span>
      <select id={id} className="mv-setting__select" data-mv-acct="sentFolder" value={value || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('mobile.accounts.sentFolderAuto')}</option>
        {paths.map((p) => <option key={p} value={p} dir="auto">{p}</option>)}
      </select>
    </label>
  );
}
