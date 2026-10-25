import { useEffect, useRef, useState } from 'react';
import { fetchSearchSuggestions } from '../services/searchSuggestions';
import { slashQuery } from '../utils/searchTags';

/// How long typing must pause before the index is asked.
export const SUGGEST_DEBOUNCE_MS = 120;
const MIN_CHARS = 2;

/// Suggestions for the text being typed into the search bar, in `accounts`
/// (none is every account) and `mailboxes` (none is every folder). Asked once typing pauses; an answer a later
/// keystroke has overtaken is dropped, and what was shown clears at once when
/// the text stops qualifying (too short, or an operator list is open).
export function useSearchSuggestions(text, accounts, mailboxes) {
  const [suggestions, setSuggestions] = useState([]);
  const asked = useRef(0);
  const prefix = (text || '').trim();
  const wanted = prefix.length >= MIN_CHARS && !slashQuery(text || '');
  const accountKey = (accounts || []).join('\n');
  const mailboxKey = (mailboxes || []).join('\n');

  useEffect(() => {
    const ticket = ++asked.current;
    if (!wanted) {
      setSuggestions(current => (current.length ? [] : current));
      return undefined;
    }
    const timer = setTimeout(() => {
      void fetchSearchSuggestions({ prefix, accounts: accountKey ? accountKey.split('\n') : [], mailboxes: mailboxKey ? mailboxKey.split('\n') : [] }).then(found => {
        if (ticket === asked.current) setSuggestions(found);
      });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [prefix, wanted, accountKey, mailboxKey]);

  return wanted ? suggestions : [];
}
