import React from 'react';
import { BookmarkCheck, BookmarkPlus } from 'lucide-react';
import { Button } from '../ui/Button';
import { useKeepStore } from '../../stores/keepStore';
import { useMailStore } from '../../stores/mailStore';
import { rowIdentity } from '../../stores/slices/unifiedHelpers';
import { keepId } from '../../shared/keep';
import { useT } from '../../i18n/index.js';

const identityKey = (email, state) => {
  const identity = rowIdentity(email, state);
  return identity ? keepId(identity) : null;
};

/// The reader's "Keep in bubble" toggle. A kept email sits in the dock until
/// it is closed there or un-kept here. Keyed by the message's own account and
/// folder (a unified-inbox row names its own), never by the view's.
export function KeepButton({ email }) {
  const t = useT();
  const id = useMailStore(state => identityKey(email, state));
  const kept = useKeepStore(s => id !== null && s.items.some(item => keepId(item) === id));
  const label = t(kept ? 'keep.remove' : 'keep.add');
  const Icon = kept ? BookmarkCheck : BookmarkPlus;
  const toggle = () => useKeepStore.getState().toggle({
    ...rowIdentity(email, useMailStore.getState()),
    subject: email.subject || '',
    sender: { name: email.from?.name || '', address: email.from?.address || '' },
  });
  return (
    <Button variant="ghost" icon size="sm" data-testid="keep-toggle" aria-pressed={kept} aria-label={label} title={label}
      disabled={id === null} onClick={toggle}>
      <Icon size={16} />
    </Button>
  );
}
