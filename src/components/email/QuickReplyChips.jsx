import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useT } from '../../i18n/index.js';
import { useSettingsStore } from '../../stores/settingsStore';
import { isAutomatedThread, quickReplyThreadKey, tier1Starters, tier2Starters } from '../../utils/quickReplies';
import { openCompose } from '../../utils/composeOpener';

// See aiClient.js's FALLBACK_AI_SETTINGS — some EmailViewer specs stub the
// whole settingsStore module with an object that predates aiSettings.
const FALLBACK_AI_SETTINGS = { enabled: false, provider: 'localGguf', endpointUrl: '', endpointModel: '', endpointConsented: false };

/**
 * Chips under the newest message — EmailViewer's single-message view, and
 * (via `isNewest` in ThreadEmailItem) the newest row of a real thread. One
 * click opens Compose prefilled and editable — the same `templateBody` seam
 * the reply-template feature already uses (RowQuickActions.jsx), nothing
 * new to wire up. Nothing here ever sends anything.
 *
 * `contextMessages` (a real thread's recent messages, oldest→newest, from
 * already-cached bodies — no new fetch) does double duty: it feeds Tier 2's
 * prompt so it can read the back-and-forth instead of just this message in
 * isolation (see quickReplies.js's `boundedThreadText`), and — when there is
 * more than one — it is forwarded onto the reply as `_threadContext`, the
 * same field ThreadEmailItem's own Reply button sets, so a chip's reply
 * shows the same collapsible thread context.
 */
export function QuickReplyChips({ email, suppressed = false, contextMessages }) {
  const t = useT();
  // Defensive default: some EmailViewer specs stub settingsStore partially.
  const aiSettings = useSettingsStore(s => s.aiSettings) || FALLBACK_AI_SETTINGS;
  const dismissed = useSettingsStore(s => s.dismissedQuickReplyThreads) || {};
  const dismissQuickReplyThread = useSettingsStore(s => s.dismissQuickReplyThread) || (() => {});

  const threadKey = quickReplyThreadKey(email);
  const hidden = suppressed || !email || isAutomatedThread(email) || (threadKey && dismissed[threadKey]);

  const [starters, setStarters] = useState(() => (email ? tier1Starters(email) : []));

  useEffect(() => {
    if (!email) { setStarters([]); return; }
    setStarters(tier1Starters(email));
    if (hidden) return;
    let cancelled = false;
    tier2Starters(email, { contextMessages }).then(list => {
      if (!cancelled && list) setStarters(list);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email?.uid, email?._mailbox, email?._accountId, aiSettings.enabled, aiSettings.provider]);

  if (hidden || !starters.length) return null;

  const openWith = (starterText) => openCompose({
    mode: 'reply',
    replyTo: contextMessages?.length > 1 ? { ...email, _threadContext: contextMessages } : { ...email },
    templateBody: starterText,
  });

  return (
    <div data-testid="quick-reply-chips" className="flex flex-wrap items-center gap-2 px-3 pb-3">
      {starters.map((starterText, index) => (
        <button
          key={index}
          type="button"
          data-testid="quick-reply-chip"
          onClick={() => openWith(starterText)}
          className="px-3 py-1.5 text-xs rounded-full border border-mail-border bg-mail-surface text-mail-text hover:bg-mail-surface-hover transition-colors"
        >
          {starterText}
        </button>
      ))}
      <button
        type="button"
        aria-label={t('ai.quickReply.dismiss')}
        title={t('ai.quickReply.dismiss')}
        onClick={() => dismissQuickReplyThread(threadKey)}
        className="p-1 rounded-full text-mail-text-muted hover:text-mail-text hover:bg-mail-surface-hover"
      >
        <X size={13} />
      </button>
    </div>
  );
}
