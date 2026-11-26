// Quick replies under an open message (desktop's QuickReplyChips): a tap opens a reply with the
// starter in its body, editable; nothing is ever sent from here. The engine decides
// (`mobile.ai.quickReplies`): none for the account's own mail, a list or automated message, or a
// conversation whose replies were dismissed (the X, `mobile.ai.dismissQuickReplies`). The
// deterministic starters of the message's shape show at once; with AI on, a second ask may answer
// three generated ones (only for an endpoint the user reviewed, never Gmail's mail on a network
// one), which replace them. Any failure keeps the deterministic ones.
import React, { useEffect, useState } from 'react';
import { daemonCall } from './transport.js';
import { useMobileStore } from './store.js';
import { useT } from './i18n.js';
import { QUICK_REPLY_KEYS } from './AiActions.jsx';
import { Button } from '../components/ui/Button.jsx';

export default function QuickReplies({ accountId, folder, uid, onReply }) {
  const t = useT();
  const aiEnabled = useMobileStore((s) => s.prefs.aiEnabled === true);
  const [state, setState] = useState(null); // null | { show, shape, starters }

  useEffect(() => {
    let live = true;
    setState(null);
    const ask = (generate) => daemonCall('mobile.ai.quickReplies', { accountId, folder, uid, generate });
    ask(false).then(
      (first) => {
        if (!live || !first) return;
        setState(first);
        if (!first.show || !aiEnabled) return;
        ask(true).then(
          (second) => { if (live && Array.isArray(second?.starters) && second.starters.length) setState((s) => (s ? { ...s, starters: second.starters } : s)); },
          () => {},
        );
      },
      () => {},
    );
    return () => { live = false; };
  }, [accountId, folder, uid, aiEnabled]);

  if (!state?.show) return null;
  const starters = Array.isArray(state.starters) && state.starters.length
    ? state.starters
    : (QUICK_REPLY_KEYS[state.shape] || QUICK_REPLY_KEYS.request).map((key) => t(key));
  const dismiss = () => {
    setState(null);
    daemonCall('mobile.ai.dismissQuickReplies', { accountId, folder, uid }).catch(() => {});
  };

  return (
    <div className="mv-qr" data-mv-quick-replies>
      {starters.map((text, i) => (
        // eslint-disable-next-line react/no-array-index-key -- a starter list never reorders
        <button key={i} type="button" className="mv-qr__chip" data-mv-quick-reply dir="auto" onClick={() => onReply(text)}>
          {text}
        </button>
      ))}
      <Button variant="ghost" size="touch" icon aria-label={t('ai.quickReply.dismiss')} onClick={dismiss}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </Button>
    </div>
  );
}
