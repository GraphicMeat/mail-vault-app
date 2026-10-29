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
use std::hash::Hash;
use std::sync::Mutex;

/// How many of each the ledger keeps; the oldest go first.
const CAPACITY: usize = 4096;

type Key = (String, String, u32);

#[derive(Clone, Hash, PartialEq, Eq)]
enum AnnouncementKey {
    Legacy(Key),
    Native { source_ref: String, account: String, folder: String, uid: u32 },
    Wake(String),
}

#[derive(Clone, Default)]
struct Announcement {
    banner: bool,
    code_attempted: bool,
    wake: Option<WakeProof>,
}

/// A successful timed local wake's original source and Message-ID. This lives
/// in the same bounded volatile ring as native announcement claims.
#[derive(Clone)]
pub(crate) struct WakeProof {
    pub source: crate::sync_observation::SourceKey,
    pub message_id: String,
    pub generation: u64,
    pub consumed: bool,
}

struct Bounded<K, V> {
    order: VecDeque<K>,
    map: HashMap<K, V>,
}

impl<K, V> Default for Bounded<K, V> {
    fn default() -> Self { Self { order: VecDeque::new(), map: HashMap::new() } }
}

impl<K: Clone + Eq + Hash, V> Bounded<K, V> {
    fn put(&mut self, key: K, value: V) {
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
    purged: Mutex<Bounded<Key, Purged>>,
    announced: Mutex<Bounded<AnnouncementKey, Announcement>>,
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
            let key = AnnouncementKey::Legacy((account.to_string(), folder.to_string(), uid));
            if !announced.map.contains_key(&key) {
                fresh = true;
                announced.put(key, Announcement { banner: true, ..Announcement::default() });
            }
        }
        fresh
    }

    /// Claim one source-qualified group in the existing bounded announcement
    /// state. A muted banner leaves its banner bit clear, while its newest code
    /// child is still attempted once. Public notify.decide keeps Legacy keys.
    pub fn claim_native(&self, source_ref: &str, account: &str, folder: &str,
        uids: &[u32], code_uid: Option<u32>, banner_allowed: bool) -> (bool, bool) {
        let mut announced = lock(&self.announced);
        let mut seen = HashSet::new();
        let (mut banner, mut code) = (false, false);
        for uid in uids.iter().copied().filter(|uid| *uid > 0 && seen.insert(*uid)) {
            let key = AnnouncementKey::Native {
                source_ref: source_ref.to_owned(), account: account.to_owned(),
                folder: folder.to_owned(), uid,
            };
            let mut status = announced.map.get(&key).cloned().unwrap_or_default();
            let before = (status.banner, status.code_attempted);
            if banner_allowed && !status.banner { status.banner = true; banner = true; }
            if code_uid == Some(uid) && !status.code_attempted {
                status.code_attempted = true; code = true;
            }
            if before != (status.banner, status.code_attempted) { announced.put(key, status); }
        }
        (banner, code)
    }

    /// Retain only a real timed local wake in the existing bounded ring.
    pub(crate) fn note_wake(&self, id: &str, proof: WakeProof) {
        lock(&self.announced).put(AnnouncementKey::Wake(id.to_owned()),
            Announcement { wake: Some(proof), ..Announcement::default() });
    }

    pub(crate) fn wake_generation(&self, id: &str) -> Option<u64> {
        lock(&self.announced).map.get(&AnnouncementKey::Wake(id.to_owned()))
            .and_then(|slot| slot.wake.as_ref()).filter(|proof| !proof.consumed)
            .map(|proof| proof.generation)
    }

    /// Consume before asynchronous preparation. The second RPC or event for
    /// one wake cannot claim the same proof, even when the first reply is lost.
    pub(crate) fn consume_wake(&self, id: &str, generation: u64) -> Option<WakeProof> {
        let mut announced = lock(&self.announced);
        let proof = announced.map.get_mut(&AnnouncementKey::Wake(id.to_owned()))?
            .wake.as_mut()?;
        if proof.consumed || proof.generation != generation { return None; }
        proof.consumed = true;
        Some(proof.clone())
    }

    pub(crate) fn wake_refusal(&self, id: &str, generation: u64) -> &'static str {
        let announced = lock(&self.announced);
        let Some(proof) = announced.map.get(&AnnouncementKey::Wake(id.to_owned()))
            .and_then(|slot| slot.wake.as_ref()) else { return "missing-proof" };
        if proof.generation != generation { "expired-proof" }
        else if proof.consumed { "consumed-proof" }
        else { "missing-proof" }
    }

    /// Records a banner that is always shown: a wake brings a message back that
    /// was announced when it first arrived, so its earlier banner must not
    /// hold this one back. It still counts, so a refresh that reports the same
    /// message right after cannot raise a second.
    pub fn reannounce(&self, account: &str, folder: &str, uids: &[u32]) {
        let mut announced = lock(&self.announced);
        for uid in uids {
            announced.put(AnnouncementKey::Legacy((account.to_string(), folder.to_string(), *uid)),
                Announcement { banner: true, ..Announcement::default() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_notice_and_code_claim_share_the_bounded_state_but_not_legacy_identity() {
        let recent = RecentActions::default();
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[7], Some(7), false), (false, true));
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[7], Some(7), true), (true, false),
            "a muted code offer does not spend the banner");
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[7], Some(7), true), (false, false));
        assert_eq!(recent.claim_native("owner-two", "a", "INBOX", &[7], Some(7), true), (true, true),
            "reused UID under a changed source is a distinct message");
        assert!(recent.announce("a", "INBOX", &[7]), "the legacy route stays independent");
        assert!(!recent.announce("a", "INBOX", &[7]));
    }

    #[test]
    fn native_overlaps_rollover_and_lost_reply_spend_only_original_claims() {
        let recent = RecentActions::default();
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[7, 7, 8], Some(8), true),
            (true, true));
        // Dropping a prepared reply cannot allow a second banner. This is the
        // adopted at-most-once cost when the first OS submission is uncertain.
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[8, 7], Some(8), true),
            (false, false));
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[8, 9], Some(9), true),
            (true, true), "only fresh UID 9 makes the overlapping group new");
        assert_eq!(recent.claim_native("owner-two", "a", "INBOX", &[7], Some(7), true),
            (true, true), "a UIDVALIDITY/source change may reuse numeric UID 7");
        assert_eq!(recent.claim_native("owner-one", "b", "INBOX", &[7], Some(7), true),
            (true, true), "independent B cannot spend A's claim");
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[10], Some(10), false),
            (false, true), "muted banner still offers its code once");
        assert_eq!(recent.claim_native("owner-one", "a", "INBOX", &[10], Some(10), true),
            (true, false), "the earlier muted decision did not spend the banner");
    }

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
