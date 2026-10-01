import { useEffect, useRef, useState } from 'react';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildNameDictionary } from '../../utils/privacy/piiDetector';
import { collectPrivacyNames, setPrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { hydrateContactsIndex, getHydratedAccountSources, buildContactsIndex, subscribeContactsIndex, isContactsIndexHydrated } from '../../utils/contactsIndex';

/** Keeps the privacy dictionary current while privacy mode (or a capture) needs it. Renders nothing. */
export function PrivacyDictionaryHost() {
  const needed = usePrivacyStore(s => s.enabled || s.captureMask);
  const emails = useMailStore(s => s.emails);
  const sentEmails = useMailStore(s => s.sentEmails);
  const selectedEmail = useMailStore(s => s.selectedEmail);
  const accounts = useAccountStore(s => s.accounts);
  // Account display names live in settings, not the mail store.
  const displayNames = useSettingsStore(s => s.displayNames);
  const [indexTick, setIndexTick] = useState(0);
  const lastKey = useRef('');
  // Every name seen this session. The set only grows: a folder switch that
  // drops a header must not unmask the message still on screen.
  const seen = useRef(new Set());

  useEffect(() => subscribeContactsIndex(() => setIndexTick(n => n + 1)), []);
  useEffect(() => { if (needed && accounts?.length) hydrateContactsIndex(accounts); }, [needed, accounts]);

  useEffect(() => {
    if (!needed) return;
    const index = buildContactsIndex(getHydratedAccountSources(), accounts || []);
    for (const n of collectPrivacyNames({
      contacts: index.all,
      emails: [...(emails || []), ...(sentEmails || []), ...(selectedEmail ? [selectedEmail] : [])],
      accounts: accounts || [],
      displayNames,
    })) seen.current.add(n);
    const names = [...seen.current];
    const ready = isContactsIndexHydrated();
    // Every list change reruns this, but the names rarely change: only a new name set pays for a rebuild and wakes the readers.
    // ponytail: collecting is O(headers x 5) per change (cheap, unmeasured); revisit if profiling shows list loads stalling.
    const key = `${ready ? 1 : 0}\u0000${names.sort().join('\u0000')}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setPrivacyDictionary(buildNameDictionary({ names }), { ready });
  }, [needed, emails, sentEmails, selectedEmail, accounts, displayNames, indexTick]);

  return null;
}
