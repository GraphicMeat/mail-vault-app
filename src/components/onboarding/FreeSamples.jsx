import React from 'react';
import { Search } from 'lucide-react';
import { SafetyAlertLegend } from '../SafetyAlertLegend.jsx';
import { LEGEND_ENTRIES } from '../email/stateLegend.jsx';
import { previewRows } from '../../data/previewMail.js';
import { SampleConversation } from '../ui/SampleConversation';

/**
 * The small drawings beside each free feature.
 *
 * A claim like "a vault on your disk" or "link and sender warnings" means
 * nothing until someone can see WHICH mark in the list is the one being
 * described. These samples show the real glyphs, from the real sources —
 * `LEGEND_ENTRIES` is the same array the mail list's own legend renders, and the
 * warning icons are the ones `LinkAlertIcon`, `SenderAlertIcon`,
 * `ReplyToAlertIcon` and the tracker badge draw — so the tour can never teach a
 * mark the app does not use.
 *
 * Drawings, not live components: the real list reads `mailStore`, and seeding
 * fake mail into the live store before the first sync lands is the state-bleed
 * class of bug this whole step avoids (same call as `AppearancePreview`).
 */

const Frame = ({ id, children }) => (
  <div data-testid={`free-sample-${id}`}
       className="onboarding-free-frame text-xs leading-relaxed select-none">
    {children}
  </div>
);

/**
 * Vault: each state glyph on a message row, captioned the way the list's
 * legend names it, so the mark is seen where it will be met.
 */
export function VaultSample() {
  const rows = previewRows();
  return (
    <Frame id="vault">
      <div className="onboarding-free-rows">
        {LEGEND_ENTRIES().map((entry, i) => (
          <div key={entry.id} data-testid={`free-legend-${entry.id}`} className="onboarding-free-row">
            <span className="flex-shrink-0 flex items-center justify-center w-3">{entry.glyph}</span>
            <span className="font-medium text-mail-text flex-shrink-0">{rows[i].sender}</span>
            <span className="truncate text-mail-text-muted flex-1 min-w-0">{rows[i].subject}</span>
            <span className="onboarding-free-tag" title={entry.detail}>{entry.text}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** Read by sender: the same correspondence as two bubbles instead of two rows. */
export function ChatSample() {
  return <Frame id="chat"><SampleConversation compact /></Frame>;
}

/**
 * Search: a query in the box and the rows it matched, with the hit marked.
 * The term is a literal, not a catalog string — it has to be a substring of the
 * sender it highlights, and a translated pair would stop matching.
 */
const SEARCH_TERM = 'MeatPad';

export function SearchSample() {
  const hits = previewRows().filter(r => r.sender.includes(SEARCH_TERM));

  return (
    <Frame id="search">
      <div className="onboarding-free-search">
        <Search size={14} className="text-mail-text-muted flex-shrink-0" />
        <span className="text-mail-text">{SEARCH_TERM}</span>
      </div>
      <div className="onboarding-free-rows">
        {hits.map(r => (
          <div key={r.id} className="onboarding-free-row">
            <mark className="bg-mail-accent-tint text-mail-accent-text rounded px-0.5 flex-shrink-0">{r.sender}</mark>
            <span className="truncate text-mail-text-muted flex-1 min-w-0">{r.subject}</span>
            <span className="text-mail-text-muted flex-shrink-0">{r.time}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/**
 * Link and sender warnings: every mark, with the title the alert itself uses.
 *
 * This used to invent four short labels ("Dangerous", "Suspicious", …) that
 * appear nowhere in the product. It now renders `SAFETY_ALERTS`, the same
 * catalog Settings → Security explains in full — so the tour and the settings
 * page cannot teach different words for the same glyph.
 */
export function LinkSafetySample() {
  return (
    <Frame id="link-safety">
      <SafetyAlertLegend compact />
    </Frame>
  );
}

export const FREE_SAMPLES = {
  vault: VaultSample,
  chat: ChatSample,
  search: SearchSample,
  'link-safety': LinkSafetySample,
};
