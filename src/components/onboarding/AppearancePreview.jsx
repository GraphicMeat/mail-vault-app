import React from 'react';
import { Inbox } from 'lucide-react';
import { PREVIEW_ACCOUNTS, previewRows } from '../../data/previewMail.js';
import { useT } from '../../i18n/index.js';

/**
 * A drawing of the app, not the app.
 *
 * Mounting the real Sidebar and EmailList would mean seeding demo mail into
 * `mailStore` — the live store — before the user's first sync lands, and fake
 * rows bleeding into real state is a class of bug that costs a day to unpick.
 * The trade is that this can drift from the real UI; the layout assertion in
 * the spec is what keeps the load-bearing part honest.
 */
const DENSITY = { compact: 'py-1', default: 'py-2', comfortable: 'py-3' };

export function AppearancePreview({ layoutMode, sidebarStyle, viewStyle, emailListStyle }) {
  const t = useT();
  const rows = previewRows();
  const threeColumn = layoutMode === 'three-column';

  return (
    <div className="rounded-xl border border-mail-border bg-mail-bg overflow-hidden select-none pointer-events-none"
         data-testid="appearance-preview">
      <div className="flex h-[300px] text-[10px]">

        <div data-testid="preview-pane-sidebar" data-style={sidebarStyle}
             className="w-32 flex-shrink-0 bg-mail-surface border-r border-mail-border p-2 space-y-1">
          {sidebarStyle === 'tagcloud'
            ? (
              <div className="flex flex-wrap gap-1">
                {PREVIEW_ACCOUNTS.map(a => (
                  <span key={a.id} className="px-1.5 py-0.5 rounded bg-mail-accent/10 text-mail-accent-text truncate max-w-full">
                    {a.name}
                  </span>
                ))}
              </div>
            )
            : PREVIEW_ACCOUNTS.map(a => (
              <div key={a.id} className="flex items-center gap-1.5 px-1.5 py-1 rounded text-mail-text truncate">
                <Inbox size={10} className="text-mail-accent-text flex-shrink-0" />
                <span className="truncate">{a.name}</span>
              </div>
            ))}
        </div>

      <div data-testid="preview-panes" data-layout={layoutMode}
           className={`flex-1 min-w-0 flex ${threeColumn ? 'flex-row' : 'flex-col'}`}>

        <div data-testid="preview-list" data-view={viewStyle} data-density={emailListStyle}
             className={`flex-shrink-0 overflow-hidden ${threeColumn
                          ? 'w-44 border-r border-mail-border'
                          : 'h-[55%] border-b border-mail-border'}`}>
          {rows.map(r => viewStyle === 'chat' ? (
            <div key={r.id} className={`px-2 ${DENSITY[emailListStyle] || DENSITY.default}`}>
              <div className="inline-block max-w-[85%] rounded-lg bg-mail-surface px-2 py-1 text-mail-text">
                {r.subject}
              </div>
            </div>
          ) : (
            <div key={r.id} className={`px-2 border-b border-mail-border ${DENSITY[emailListStyle] || DENSITY.default}`}>
              <div className="flex items-baseline gap-1">
                <span className={`truncate ${r.unread ? 'text-mail-text font-semibold' : 'text-mail-text'}`}>{r.sender}</span>
                <span className="ml-auto text-mail-text-muted flex-shrink-0">{r.time}</span>
              </div>
              <div className="truncate text-mail-text">{r.subject}</div>
              {emailListStyle !== 'compact' && (
                <div className="truncate text-mail-text-muted">{r.snippet}</div>
              )}
            </div>
          ))}
        </div>

        {/* The reader exists in BOTH layouts — two-column stacks it under the
            list instead of dropping it (`App.jsx` switches the same flex
            container between row and column). The preview used to omit it
            entirely, so choosing two-column looked like choosing to have
            nowhere to read. */}
        <div data-testid="preview-pane-viewer" className="flex-1 p-3 space-y-2 min-w-0 min-h-0 overflow-hidden">
          <div className="text-mail-text font-semibold truncate">{rows[0].subject}</div>
          <div className="text-mail-text-muted truncate">{rows[0].sender}</div>
          <div className="space-y-1 pt-1">
            <div className="h-1.5 bg-mail-border rounded-full w-full" />
            <div className="h-1.5 bg-mail-border rounded-full w-11/12" />
            <div className="h-1.5 bg-mail-border rounded-full w-4/5" />
            <div className="h-1.5 bg-mail-border rounded-full w-2/3" />
          </div>
        </div>
      </div>
    </div>
      <div className="px-2 py-1 border-t border-mail-border text-[9px] text-mail-text-muted">
        {t('onboarding.previewCaption')}
      </div>
    </div>
  );
}
