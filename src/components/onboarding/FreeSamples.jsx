import React from 'react';
import { Search } from 'lucide-react';
import { SafetyAlertLegend } from '../SafetyAlertLegend.jsx';
import { LEGEND_ENTRIES } from '../email/stateLegend.jsx';
import { previewRows } from '../../data/previewMail.js';
import { useT } from '../../i18n/index.js';

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
       className="rounded-lg border border-mail-border bg-mail-bg p-2 text-[10px] leading-tight select-none">
    {children}
  </div>
);

/** Vault: the three state glyphs and the backup dot, each with its caption. */
export function VaultSample() {
  return (
    <Frame id="vault">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {LEGEND_ENTRIES().map(entry => (
          <div key={entry.id} data-testid={`free-legend-${entry.id}`}
               className="flex items-center gap-1.5 text-mail-text-muted min-w-0">
            <span className="flex-shrink-0 flex items-center justify-center w-3">{entry.glyph}</span>
            <span className="truncate" title={entry.detail}>{entry.text}</span>
          </div>
        ))}
      </div>
    </Frame>
  );
}

/** Read by sender: the same correspondence as two bubbles instead of two rows. */
export function ChatSample() {
  const rows = previewRows();
  return (
    <Frame id="chat">
      <div className="space-y-1">
        <div className="flex">
          <span className="rounded-lg rounded-bl-sm bg-mail-surface text-mail-text px-2 py-1 max-w-[80%] truncate">
            {rows[1].subject}
          </span>
        </div>
        <div className="flex justify-end">
          <span className="rounded-lg rounded-br-sm bg-mail-accent/15 text-mail-accent-text px-2 py-1 max-w-[80%] truncate">
            {rows[5].subject}
          </span>
        </div>
      </div>
    </Frame>
  );
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
      <div className="flex items-center gap-1.5 rounded border border-mail-border bg-mail-surface px-1.5 py-1 mb-1.5">
        <Search size={10} className="text-mail-text-muted flex-shrink-0" />
        <span className="text-mail-text">{SEARCH_TERM}</span>
      </div>
      <div className="space-y-1">
        {hits.map(r => (
          <div key={r.id} className="flex items-baseline gap-1 min-w-0">
            <mark className="bg-mail-accent/25 text-mail-text rounded px-0.5 flex-shrink-0">{r.sender}</mark>
            <span className="truncate text-mail-text-muted">{r.subject}</span>
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
