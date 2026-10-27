//! What the daemon already did or announced, for the next request that would do
//! it twice. In memory and bounded: the cases it settles (a delete clicked again
//! on a row that outlived the first, a banner raised again by a refresh) come
//! within minutes, and a restart forgetting them costs one repeat, not a wrong
//! answer.
//!
//! - purges: a message whose server copy a delete everywhere already removed.
//!   The next delete of it finds nothing to prove and nothing to delete, which is
//!   done, not "needs resync".
//! - announcements: the (account, folder, uid)s a banner was already allowed for;
//!   one is shown once, whoever asks again.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

/// How many of each the ledger keeps; the oldest go first.
const CAPACITY: usize = 4096;

type Key = (String, String, u32);

#[derive(Default)]
struct Bounded<V> {
    order: VecDeque<Key>,
    map: HashMap<Key, V>,
}

impl<V> Bounded<V> {
    fn put(&mut self, key: Key, value: V) {
        if self.map.insert(key.clone(), value).is_none() {
            self.order.push_back(key);
            if self.order.len() > CAPACITY {
                if let Some(oldest) = self.order.pop_front() {
                    self.map.remove(&oldest);
                }
            }
        }
    }
}

/// What a delete everywhere knew of the message whose server copy it removed.
#[derive(Default)]
struct Purged {
    message_id: Option<String>,
    /// The mailbox generation and the account's endpoint the delete proved the uid in.
    uid_validity: Option<u32>,
    origin: Option<String>,
}

#[derive(Default)]
pub struct RecentActions {
    purged: Mutex<Bounded<Purged>>,
    announced: Mutex<Bounded<()>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// A Message-ID as two sides compare it: no angle brackets or spaces at the ends.
fn id_key(id: &str) -> Option<String> {
    let key = id.trim_matches(['<', '>', ' ']);
    (!key.is_empty()).then(|| key.to_string())
}

impl RecentActions {
    /// A delete everywhere removed this message's server copy, proven in this
    /// mailbox generation (`uid_validity`) of this endpoint (`origin`).
    pub fn note_purged(&self, account: &str, mailbox: &str, uid: u32, message_id: Option<&str>, uid_validity: Option<u32>, origin: Option<&str>) {
        let noted = Purged { message_id: message_id.and_then(id_key), uid_validity, origin: origin.map(str::to_owned) };
        lock(&self.purged).put((account.to_string(), mailbox.to_string(), uid), noted);
    }

    /// Whether this message's server copy was removed by a delete everywhere
    /// since the daemon started (within the ledger's bound). A uid names one
    /// message for the life of its mailbox's UIDVALIDITY only, so "the same uid"
    /// is never enough, and nothing counts as a match by lacking evidence:
    /// - an ask that carries the identity it was selected under (`native`: the
    ///   generation and the endpoint) must be the same generation of the same
    ///   endpoint the delete proved, and neither Message-ID may contradict;
    /// - an ask without one must have a Message-ID, equal to the noted one.
    pub fn was_purged(&self, account: &str, mailbox: &str, uid: u32, message_id: Option<&str>, native: Option<(Option<u32>, &str)>) -> bool {
        let purged = lock(&self.purged);
        let Some(noted) = purged.map.get(&(account.to_string(), mailbox.to_string(), uid)) else { return false };
        let asked = message_id.and_then(id_key);
        let ids_agree = match (&noted.message_id, &asked) {
            (Some(noted), Some(asked)) => noted == asked,
            _ => true,
        };
        match native {
            Some((validity, origin)) => ids_agree && noted.uid_validity == validity && noted.origin.as_deref() == Some(origin),
            None => matches!((&noted.message_id, &asked), (Some(noted), Some(asked)) if noted == asked),
        }
    }

    /// Records a banner for `uids` and says whether it should be shown: true
    /// when any of them was not announced before, false when all were. An empty
    /// list is never recorded and always shown (the caller could not say which
    /// messages the banner is for).
    pub fn announce(&self, account: &str, folder: &str, uids: &[u32]) -> bool {
        if uids.is_empty() {
            return true;
        }
        let mut announced = lock(&self.announced);
        let mut fresh = false;
        let mut seen = HashSet::new();
        for uid in uids.iter().copied().filter(|uid| seen.insert(*uid)) {
            let key = (account.to_string(), folder.to_string(), uid);
            if !announced.map.contains_key(&key) {
                fresh = true;
                announced.put(key, ());
            }
        }
        fresh
    }

    /// Records a banner that is always shown: a wake brings a message back that
    /// was announced when it first arrived, so its earlier banner must not
    /// hold this one back. It still counts, so a refresh that reports the same
    /// message right after cannot raise a second.
    pub fn reannounce(&self, account: &str, folder: &str, uids: &[u32]) {
        let mut announced = lock(&self.announced);
        for uid in uids {
            announced.put((account.to_string(), folder.to_string(), *uid), ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_purged_message_is_remembered_only_against_proof_it_is_the_same_message() {
        let recent = RecentActions::default();
        recent.note_purged("a", "INBOX", 7, Some("<one@x.test>"), Some(1), Some("origin-a"));
        let native = |validity, origin| Some((validity, origin));
        // The same message, asked with the identity it was selected under or by Message-ID alone.
        assert!(recent.was_purged("a", "INBOX", 7, Some(" one@x.test "), native(Some(1), "origin-a")), "brackets and spaces do not matter");
        assert!(recent.was_purged("a", "INBOX", 7, Some("<one@x.test>"), None), "no native identity: the Message-ID is the proof");
        assert!(recent.was_purged("a", "INBOX", 7, None, native(Some(1), "origin-a")), "identity alone proves it when no Message-ID contradicts");
        // Not the same message: another Message-ID, a new mailbox generation, another endpoint.
        assert!(!recent.was_purged("a", "INBOX", 7, Some("<two@x.test>"), native(Some(1), "origin-a")));
        assert!(!recent.was_purged("a", "INBOX", 7, Some("<two@x.test>"), None));
        assert!(!recent.was_purged("a", "INBOX", 7, Some("<one@x.test>"), native(Some(2), "origin-a")), "UIDVALIDITY changed: the number is reused");
        assert!(!recent.was_purged("a", "INBOX", 7, Some("<one@x.test>"), native(Some(1), "origin-b")), "Change Server kept the account id");
        // No evidence at all is not a match.
        assert!(!recent.was_purged("a", "INBOX", 7, None, None));
        assert!(!recent.was_purged("a", "INBOX", 8, Some("<one@x.test>"), None));
        assert!(!recent.was_purged("a", "Archive", 7, Some("<one@x.test>"), None));
        assert!(!recent.was_purged("b", "INBOX", 7, Some("<one@x.test>"), None));
    }

    /// A message with no Message-ID has nothing but its generation and endpoint to
    /// be told apart by: without them it is never "already deleted".
    #[test]
    fn a_purged_message_with_no_message_id_is_matched_by_generation_and_endpoint_only() {
        let recent = RecentActions::default();
        recent.note_purged("a", "INBOX", 7, None, Some(1), Some("origin-a"));
        assert!(recent.was_purged("a", "INBOX", 7, None, Some((Some(1), "origin-a"))));
        assert!(!recent.was_purged("a", "INBOX", 7, None, Some((Some(2), "origin-a"))), "the mailbox was recreated and uid 7 is a new message");
        assert!(!recent.was_purged("a", "INBOX", 7, Some("<new@x.test>"), None), "nothing proves it without a native identity");
    }

    #[test]
    fn a_banner_is_allowed_once_per_message_and_again_for_any_new_one() {
        let recent = RecentActions::default();
        assert!(recent.announce("a", "INBOX", &[5]), "first time");
        assert!(!recent.announce("a", "INBOX", &[5]), "the same message again");
        assert!(recent.announce("a", "INBOX", &[5, 6]), "uid 6 is new, so the banner for both is shown");
        assert!(!recent.announce("a", "INBOX", &[6, 5, 5]), "both were announced");
        assert!(recent.announce("a", "Archive", &[5]), "another folder");
        assert!(recent.announce("b", "INBOX", &[5]), "another account");
        assert!(recent.announce("a", "INBOX", &[]), "a banner that names no message is never held back");
        assert!(recent.announce("a", "INBOX", &[]));
    }

    #[test]
    fn a_wake_is_shown_again_and_holds_back_the_refresh_that_follows() {
        let recent = RecentActions::default();
        assert!(recent.announce("a", "INBOX", &[5]), "the arrival");
        recent.reannounce("a", "INBOX", &[5]);
        assert!(!recent.announce("a", "INBOX", &[5]), "a refresh seeing the woken message is no second banner");
        recent.reannounce("a", "INBOX", &[]);
        for uid in 1..=CAPACITY as u32 {
            recent.announce("a", "INBOX", &[100 + uid]);
        }
        assert!(recent.announce("a", "INBOX", &[5]), "a re-announce does not live past the bound either");
    }

    #[test]
    fn the_ledger_forgets_its_oldest_entry_past_its_bound() {
        let recent = RecentActions::default();
        for uid in 1..=(CAPACITY as u32 + 1) {
            assert!(recent.announce("a", "INBOX", &[uid]));
        }
        assert!(recent.announce("a", "INBOX", &[1]), "the oldest was dropped");
        assert!(!recent.announce("a", "INBOX", &[CAPACITY as u32 + 1]), "the newest is kept");
    }
}
