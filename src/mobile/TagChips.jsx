// A message's tags on the phone: desktop's chips (components/tags/TagViews.jsx) over the phone's
// tag cache (tags.js). In a list row (`removable` off: the row is a button, and a button in it
// would be a second control in one) they only show; in the viewer each has its remove button.
import React from 'react';
import { TagChipsView } from '../components/tags/TagViews';
import { SettingsViewProvider } from '../components/settings/views/viewContext';
import { useT } from './i18n.js';
import { useRowTags, useTagStore } from './tags.js';
import '../styles/labels-fields.css';

export default function TagChips({ accountId, folder, uid, removable = false, className = '' }) {
  const t = useT();
  const tags = useRowTags(accountId, folder, uid);
  if (!tags.length) return null;
  const remove = removable ? (tag) => useTagStore.getState().setOnRows([{ accountId, folder, uid }], tag.id, false) : null;
  return (
    <SettingsViewProvider t={t}>
      <TagChipsView tags={tags} className={className} onRemove={remove} />
    </SettingsViewProvider>
  );
}
