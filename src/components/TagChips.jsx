import React, { useEffect } from 'react';
import { useMailStore } from '../stores/mailStore';
import { useTagStore, tagRowKey, requestRowTags } from '../stores/tagStore';
import { resolveEmailLocation } from '../stores/slices/unifiedHelpers';
import { useT } from '../i18n/index.js';
import { TagChipsView } from './tags/TagViews';
import { SettingsViewProvider } from './settings/views/viewContext';

const EMPTY = [];

/// The tags on a row, or on every member of a thread row. Nothing here knows
/// the key an assignment is stored under: the daemon owns that, and this only
/// reads the render cache it fills. The chips themselves are the view both apps render
/// (tags/TagViews.jsx).
export function TagChips({ email, className = '' }) {
  const t = useT();
  const tags = useTagStore(state => state.tags);
  const byRow = useTagStore(state => state.byRow);
  const removeTag = useTagStore(state => state.removeTag);
  const rows = tags.length ? (Array.isArray(email) ? email : email ? [email] : []) : EMPTY;
  const state = useMailStore.getState();
  const located = rows
    .map(row => ({ row, location: resolveEmailLocation(row, state) }))
    .filter(item => item.location && item.row?.uid != null);

  useEffect(() => {
    for (const item of located) requestRowTags(item.row, item.location);
  });

  if (!tags.length || !located.length) return null;
  const idsOf = item => byRow[tagRowKey(item.location.accountId, item.location.mailbox, item.row.uid)] || [];
  const assigned = tags.filter(tag => located.some(item => idsOf(item).includes(tag.id)));
  if (!assigned.length) return null;

  return <SettingsViewProvider t={t}>
    <TagChipsView tags={assigned} className={className}
      onRemove={tag => {
        for (const item of located) if (idsOf(item).includes(tag.id)) removeTag(item.row, item.location, tag.id);
      }} />
  </SettingsViewProvider>;
}
