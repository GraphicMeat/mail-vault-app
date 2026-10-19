import { useEffect, useRef, useState } from 'react';
import { usePrivacyStore } from '../../stores/privacyStore';
import { useMailStore } from '../../stores/mailStore';
import { useAccountStore } from '../../stores/accountStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildNameDictionary } from '../../utils/privacy/piiDetector';
import { collectPrivacyNames, setPrivacyDictionary } from '../../utils/privacy/privacyDictionary';
import { daemonCall } from '../../services/daemonClient';

/** Keeps the privacy dictionary current while privacy mode, a capture or a redacted export needs it. Renders nothing. */
export function PrivacyDictionaryHost() {
  const needed = usePrivacyStore(s => s.enabled || s.captureMask || s.dictWanted);
  const emails = useMailStore(s => s.emails);
  const sentEmails = useMailStore(s => s.sentEmails);
  const selectedEmail = useMailStore(s => s.selectedEmail);
  const accounts = useAccountStore(s => s.accounts);
  // Account display names live in settings, not the mail store.
  const displayNames = useSettingsStore(s => s.displayNames);
  // Every name in the daemon's contacts index, for the account set in `key`.
  const [index, setIndex] = useState({ key: '', names: [] });
  const lastKey = useRef('');
  // Every name seen this session. The set only grows: a folder switch that
  // drops a header must not unmask the message still on screen.
  const seen = useRef(new Set());
  const accountKey = (accounts || []).map(a => a.id).sort().join(',');

  // Fetched on every wake, so a long session picks up new correspondents. Not
  // ready until the daemon answers: a failed call leaves an export to its timeout.
  useEffect(() => {
    if (!needed || !accountKey) return undefined;
    let current = true;
    daemonCall('people.contacts.names', { accountIds: accountKey.split(',') }).then(
      names => { if (current) setIndex({ key: accountKey, names: Array.isArray(names) ? names : [] }); },
      () => {},
    );
    return () => { current = false; };
  }, [needed, accountKey]);

  useEffect(() => {
    // Idle, the dictionary goes stale; the next wake must publish a build (a
    // waiting export counts on it) even when the names are the same.
    if (!needed) { lastKey.current = ''; return; }
    for (const n of collectPrivacyNames({
      contacts: index.names.map(name => ({ name })),
      emails: [...(emails || []), ...(sentEmails || []), ...(selectedEmail ? [selectedEmail] : [])],
      accounts: accounts || [],
      displayNames,
    })) seen.current.add(n);
    const names = [...seen.current];
    const ready = !!accountKey && index.key === accountKey;
    // Every list change reruns this, but the names rarely change: only a new name set pays for a rebuild and wakes the readers.
    // ponytail: collecting is O(headers x 5) per change (cheap, unmeasured); revisit if profiling shows list loads stalling.
    const key = `${ready ? 1 : 0}\u0000${names.sort().join('\u0000')}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setPrivacyDictionary(buildNameDictionary({ names }), { ready });
  }, [needed, emails, sentEmails, selectedEmail, accounts, displayNames, index, accountKey]);

  return null;
}
