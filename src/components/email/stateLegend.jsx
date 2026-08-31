import React from 'react';
import { Cloud, CloudOff, HardDrive } from 'lucide-react';
import { t as tr } from '../../i18n/index.js';

/**
 * What the per-row state glyphs mean.
 *
 * Three glyphs and one modifier, not one row per state: the dot composes with
 * each glyph, and showing it as a modifier is what teaches the composition.
 * `MessageStateIcon` renders the same icons for a real message; these entries
 * are static because a legend has no message to describe.
 *
 * Lives here rather than inside `EmailList` because onboarding's free-features
 * step teaches the same glyphs. Two hand-copied legends would be two legends
 * that disagree the first time a colour or a caption changes.
 */
export const LEGEND_ENTRIES = () => ([
  {
    id: 'legend-server',
    glyph: <Cloud size={12} className="text-mail-server" />,
    text: tr('list.serverOnly'),
    label: tr('email.state.server'),
    detail: tr('list.savedVaultYetIfAccount'),
  },
  {
    id: 'legend-archived',
    glyph: <HardDrive size={12} className="text-mail-local" />,
    text: tr('list.vault'),
    label: tr('email.state.savedVault'),
    detail: tr('list.copyDiskAlsoShownWhen'),
  },
  {
    id: 'legend-local-only',
    glyph: <CloudOff size={12} className="text-mail-only-copy" />,
    text: tr('list.onlyCopy'),
    label: tr('email.state.onlyCopy'),
    detail: tr('list.confirmedGoneServerNothingElse'),
  },
  {
    id: 'legend-backed-up',
    glyph: <span className="w-[6px] h-[6px] rounded-full border bg-mail-text border-mail-text" />,
    text: tr('list.backupDrive'),
    label: tr('list.backupDrive2'),
    detail: tr('list.filledMeansBackupDriveToo'),
  },
]);
