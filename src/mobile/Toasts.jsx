// The toasts over the bottom of the app: the undo toast of a deferred move or delete (store `undo`,
// which the store clears once the action is sent) and a one-line notice (store `notice`: a dropped
// action's translated reason, or a failed apply), which goes by itself after NOTICE_MS.
import React, { useEffect } from 'react';
import { useMobileStore } from './store.js';
import { folderLabel } from './folders.js';
import { useT } from './i18n.js';

export const NOTICE_MS = 6000;

export default function Toasts() {
  const t = useT();
  const undo = useMobileStore((s) => s.undo);
  const notice = useMobileStore((s) => s.notice);
  const folders = useMobileStore((s) => s.folders);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => useMobileStore.getState().dismissNotice(notice.id), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  if (!undo && !notice) return null;
  let undoText = null;
  if (undo) {
    if (undo.kind === 'move') {
      const target = folders.find((f) => f.path === undo.target) || { path: undo.target || '', name: undo.target || '' };
      undoText = t('mobile.actions.moved', { count: undo.count, folder: folderLabel(target) });
    } else {
      undoText = t('mobile.actions.deleted', { count: undo.count });
    }
  }
  return (
    <div className="mv-toasts">
      {notice && (
        <div className="mv-toast" role="alert">
          <span className="mv-toast__text">{t(notice.key)}</span>
          <button type="button" className="mv-toast__btn" onClick={() => useMobileStore.getState().dismissNotice(notice.id)}>
            {t('mobile.actions.dismiss')}
          </button>
        </div>
      )}
      {undo && (
        <div className="mv-toast" role="status" aria-live="polite">
          <span className="mv-toast__text" dir="auto">{undoText}</span>
          <button type="button" className="mv-toast__btn" data-mv-undo onClick={() => useMobileStore.getState().undoDeferred(undo.id)}>
            {t('mobile.actions.undo')}
          </button>
        </div>
      )}
    </div>
  );
}
