import { daemonCall } from './daemonClient';
import { commitText, formatTag } from '../utils/searchTags';

/// The search bar's typeahead, from the daemon's index (`search.suggest`):
/// each entry is the tags picking it commits. A sender becomes a `from:` tag;
/// a word or phrase becomes one tag, as if typed. An index that cannot answer, or a
/// daemon that is not there, is no suggestions, never an error: the list is a
/// convenience and the search itself works without it. `mailboxes` limits the
/// senders to the folders the search reads; none is every folder.
export async function fetchSearchSuggestions({ prefix, accounts, mailboxes, limit = 10 }) {
  let found;
  try {
    found = await daemonCall('search.suggest', mailboxes?.length ? { prefix, accounts, mailboxes, limit } : { prefix, accounts, limit });
  } catch {
    return [];
  }
  if (!Array.isArray(found)) return [];
  return found.flatMap(entry => {
    if (entry?.kind === 'sender' && entry.address) {
      return [{
        key: `sender:${entry.address}`, kind: 'sender', tags: [formatTag('from', entry.address)],
        label: entry.name || entry.address, detail: entry.name ? entry.address : '', count: entry.count ?? 0,
      }];
    }
    if (entry?.kind === 'term' && entry.term) {
      return [{
        key: `term:${entry.term}`, kind: 'term', tags: commitText(entry.term),
        label: entry.term, detail: '', count: entry.count ?? 0,
      }];
    }
    return [];
  });
}
