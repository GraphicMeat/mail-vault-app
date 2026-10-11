//! A safety copy of the contacts: `<vault>/Contacts/contacts.vcf`, written a
//! while after the last change and read back once on a vault that has none of
//! its people. Custody stays the truth; this file is what the vault backup
//! mirror and a vault move carry, so a restore does not lose every contact.
//!
//! Runs on its own background-QoS thread, a page of people (at most 200) per
//! custody call, waiting for a quiet UI between pages.
use crate::server::DaemonState;
use mailvault_core::custody::db::{meta_get, meta_set};
use mailvault_core::people::{model::new_id, store, vcard};
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const PAGE: usize = 200;
/// A write goes out this long after the last change, so an edit burst or an
/// import costs one snapshot, not one per edit.
const SETTLE_MS: u64 = 30_000;
const POLL: Duration = Duration::from_secs(5);
const HASH_KEY: &str = "contacts_snapshot_hash";
/// `1` once this vault has restored from, or written, a snapshot: the file is
/// never read again. `pending:N:<hash>` while a restore is running (or was cut
/// short), N cards of the file with that hash already in: the next start resumes
/// at card N of the same file (a changed file starts over) and nothing is written
/// meanwhile. `pending:N` and a bare `pending` (older builds) resume at N and 0.
const RESTORED_KEY: &str = "people_restored";
const PENDING: &str = "pending";

/// How many cards a pending restore has already imported, and the hash of the
/// file text they came from (`pending:N:<hash>`; older flags carry none);
/// `None` when the flag is not pending.
fn pending_at(flag: Option<&str>) -> Option<(usize, Option<&str>)> {
    let f = flag?;
    if f == PENDING {
        return Some((0, None));
    }
    let rest = f.strip_prefix("pending:")?;
    let (n, hash) = match rest.split_once(':') {
        Some((n, h)) => (n, Some(h)),
        None => (rest, None),
    };
    Some((n.parse().unwrap_or(0), hash))
}

fn text_hash(text: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// When the last unsnapshotted change happened (0 = nothing waiting).
static LAST_CHANGE_MS: AtomicU64 = AtomicU64::new(0);

/// Called after every successful `people.*` write and contacts import.
pub(crate) fn note_change() {
    LAST_CHANGE_MS.store(mailvault_core::vault_layout::now_millis(), Ordering::Relaxed);
}

fn due(last: u64, now: u64) -> bool {
    last != 0 && now.saturating_sub(last) >= SETTLE_MS
}

fn file_in(root: &Path) -> std::path::PathBuf {
    root.join("Contacts").join("contacts.vcf")
}

/// Every person as one vCard text, a page per custody call.
fn render(state: &DaemonState, yield_fn: &mut impl FnMut()) -> Result<String, String> {
    let ids = crate::custody::with_conn(state, store::all_ids)?;
    let mut text = String::new();
    for page in ids.chunks(PAGE) {
        yield_fn();
        text.push_str(&crate::custody::with_conn(state, |c| vcard::export(c, Some(page)))?);
    }
    Ok(text)
}

/// Put `text` at `<root>/Contacts/contacts.vcf` (a `.part` file, then a
/// rename) unless it is what the last write already put there. Never replaces
/// the copy with nothing: an empty book leaves the file alone, and so does a
/// restore that has not finished (its half book must not replace the full copy).
/// A vault that has written a snapshot never restores from it again, so an undo
/// that removes people is not undone by the next start.
fn store_text(state: &DaemonState, root: &Path, text: &str) -> Result<bool, String> {
    if text.is_empty() {
        return Ok(false);
    }
    let hash = text_hash(text);
    if pending_at(crate::custody::with_conn(state, |c| Ok(meta_get(c, RESTORED_KEY)))?.as_deref()).is_some() {
        return Ok(false);
    }
    let file = file_in(root);
    if file.is_file() && crate::custody::with_conn(state, |c| Ok(meta_get(c, HASH_KEY)))?.as_deref() == Some(hash.as_str()) {
        return Ok(false);
    }
    let part = file.with_extension("vcf.part");
    std::fs::create_dir_all(root.join("Contacts")).map_err(|e| e.to_string())?;
    let written = std::fs::write(&part, text).and_then(|_| std::fs::rename(&part, &file));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&part);
        return Err(e.to_string());
    }
    crate::custody::with_conn(state, |c| {
        meta_set(c, HASH_KEY, &hash)?;
        meta_set(c, RESTORED_KEY, "1")
    })?;
    Ok(true)
}

/// Render and store in one go. `true` when the file was (re)written.
pub(crate) fn write(state: &DaemonState, root: &Path, mut yield_fn: impl FnMut()) -> Result<bool, String> {
    let text = render(state, &mut yield_fn)?;
    store_text(state, root, &text)
}

/// A vault with no people at all but a `contacts.vcf` (a restore, a moved or
/// copied vault) gets them back, once: `people_restored` is `pending:N:<hash>` while it
/// runs (N cards done, saved with each chunk, with a hash of the file) and `1`
/// after the last, and the file is never read again. A restore cut short resumes
/// at card N, so a card with no email, which has no address to be found by, is not
/// created twice; if the file changed since, it starts over from card 0 (the
/// import skips cards already in). Returns how many people it brought back.
pub(crate) fn restore_if_empty(state: &DaemonState, root: &Path, mut yield_fn: impl FnMut()) -> Result<usize, String> {
    let (empty, resume) = crate::custody::with_conn(state, |c| {
        let rows: i64 = c.query_row("SELECT count(*) FROM person", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        let flag = meta_get(c, RESTORED_KEY);
        let resume = pending_at(flag.as_deref()).map(|(n, h)| (n, h.map(str::to_string)));
        Ok((resume.is_some() || (rows == 0 && flag.is_none()), resume))
    })?;
    if !empty {
        return Ok(0);
    }
    let Ok(text) = std::fs::read_to_string(file_in(root)) else {
        // a pending restore with no file to resume from is over, or the safety copy would never be written again
        crate::custody::with_conn(state, |c| if pending_at(meta_get(c, RESTORED_KEY).as_deref()).is_some() { meta_set(c, RESTORED_KEY, "1") } else { Ok(()) })?;
        return Ok(0);
    };
    let (cards, grp, hash) = (vcard::VCard::parse_all(&text), new_id(), text_hash(&text));
    // progress counts cards of one particular file: a file replaced since the cut is read from its start
    let mut done = match resume {
        Some((_, Some(h))) if h != hash => 0,
        Some((n, _)) => n.min(cards.len()),
        None => 0,
    };
    crate::custody::with_conn(state, |c| meta_set(c, RESTORED_KEY, &format!("{PENDING}:{done}:{hash}")))?;
    let mut restored = 0;
    for chunk in cards[done..].chunks(vcard::IMPORT_CHUNK) {
        yield_fn();
        // the progress is saved in the same custody call as the chunk, so a kill leaves at most that one chunk to repeat
        let r = crate::custody::with_conn(state, |c| {
            let r = vcard::import_cards(c, chunk, &grp)?;
            meta_set(c, RESTORED_KEY, &format!("{PENDING}:{}:{hash}", done + chunk.len()))?;
            Ok(r)
        })?;
        done += chunk.len();
        restored += r.created + r.linked;
    }
    crate::custody::with_conn(state, |c| meta_set(c, RESTORED_KEY, "1"))?;
    Ok(restored)
}

/// Restore once, then keep the copy fresh for as long as the daemon runs.
pub fn spawn(state: Arc<DaemonState>) {
    let _ = std::thread::Builder::new().name("people-snapshot".into()).spawn(move || {
        crate::mbox_upload_job::background_qos();
        let search = Arc::clone(&state.search_index);
        let mut yield_fn = || crate::search_index::yield_to_foreground(&search);
        match crate::handlers::common::vault_root(&state) {
            Ok(root) => match restore_if_empty(&state, &root, &mut yield_fn) {
                Ok(n) if n > 0 => note_change(),
                Ok(_) if !file_in(&root).is_file() => note_change(),
                Ok(_) => {}
                Err(e) => tracing::warn!("[people_snapshot] restore failed: {e}"),
            },
            Err(e) => tracing::warn!("[people_snapshot] restore skipped: {e}"),
        }
        loop {
            std::thread::sleep(POLL);
            let last = LAST_CHANGE_MS.load(Ordering::Relaxed);
            if !due(last, mailvault_core::vault_layout::now_millis()) {
                continue;
            }
            let wrote = render(&state, &mut yield_fn).and_then(|text| {
                crate::handlers::common::with_vault_write(&state, |root| store_text(&state, root, &text))
            });
            match wrote {
                // a change that landed while writing keeps the flag set
                Ok(_) => {
                    let _ = LAST_CHANGE_MS.compare_exchange(last, 0, Ordering::Relaxed, Ordering::Relaxed);
                }
                Err(e) => {
                    tracing::warn!("[people_snapshot] write failed: {e}");
                    note_change();
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::people::store::{create_person, update_person, NewPerson, Patch};

    fn state() -> (tempfile::TempDir, Arc<DaemonState>) {
        let d = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(d.path().to_path_buf(), d.path().to_path_buf(), true);
        (d, s)
    }

    fn two_contacts(s: &DaemonState) {
        crate::custody::with_conn(s, |c| {
            let al = create_person(c, &NewPerson { display_name: "Al".into(), emails: vec!["a@x.io".into()], notes: "met at the fair".into(), ..Default::default() })?;
            update_person(c, &al, &Patch { vip: Some(true), ..Default::default() })?;
            create_person(c, &NewPerson { display_name: "Bo".into(), emails: vec!["b@x.io".into()], ..Default::default() })?;
            Ok(())
        })
        .unwrap();
    }

    fn people(s: &DaemonState) -> i64 {
        crate::custody::with_conn(s, |c| c.query_row("SELECT count(*) FROM person", [], |r| r.get(0)).map_err(|e| e.to_string())).unwrap()
    }

    #[test]
    fn write_puts_both_contacts_in_the_vault_and_a_second_write_rewrites_nothing() {
        let (d, s) = state();
        two_contacts(&s);

        assert!(write(&s, d.path(), || {}).unwrap());
        let file = d.path().join("Contacts").join("contacts.vcf");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("FN:Al") && text.contains("FN:Bo"), "{text}");
        assert!(text.contains("NOTE:met at the fair") && text.contains("X-MAILVAULT-VIP"), "{text}");
        assert!(!d.path().join("Contacts").join("contacts.vcf.part").exists(), "renamed into place");

        let stamp = std::fs::metadata(&file).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        assert!(!write(&s, d.path(), || {}).unwrap(), "nothing changed, nothing written");
        assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), stamp);
    }

    #[test]
    fn an_empty_book_never_replaces_the_copy() {
        let (d, s) = state();
        let file = d.path().join("Contacts").join("contacts.vcf");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "BEGIN:VCARD\nFN:Kept\nEND:VCARD\n").unwrap();
        assert!(!write(&s, d.path(), || {}).unwrap());
        assert!(std::fs::read_to_string(&file).unwrap().contains("FN:Kept"));
    }

    #[test]
    fn restore_brings_the_people_back_once_into_an_empty_vault() {
        let (src_dir, src) = state();
        two_contacts(&src);
        write(&src, src_dir.path(), || {}).unwrap();

        let (dst_dir, dst) = state();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        std::fs::copy(file_in(src_dir.path()), file_in(dst_dir.path())).unwrap();

        assert_eq!(restore_if_empty(&dst, dst_dir.path(), || {}).unwrap(), 2);
        assert_eq!(people(&dst), 2);
        let flag = crate::custody::with_conn(&dst, |c| Ok(meta_get(c, RESTORED_KEY))).unwrap();
        assert_eq!(flag.as_deref(), Some("1"));

    }

    fn flag(s: &DaemonState) -> Option<String> {
        crate::custody::with_conn(s, |c| Ok(meta_get(c, RESTORED_KEY))).unwrap()
    }

    #[test]
    fn a_vault_that_wrote_a_snapshot_never_restores_from_it_even_after_every_person_is_gone() {
        let (d, s) = state();
        two_contacts(&s);
        write(&s, d.path(), || {}).unwrap();
        assert_eq!(flag(&s).as_deref(), Some("1"));
        crate::custody::with_conn(&s, |c| {
            for id in store::all_ids(c)? {
                store::delete_person(c, &id)?;
            }
            Ok(())
        })
        .unwrap();
        assert_eq!(restore_if_empty(&s, d.path(), || {}).unwrap(), 0);
        // delete_person is a soft delete: count live people only
        let live = crate::custody::with_conn(&s, |c| store::all_ids(c).map(|v| v.len())).unwrap();
        assert_eq!(live, 0);
    }

    #[test]
    fn the_restore_is_pending_before_the_first_chunk_and_nothing_is_written_while_it_is() {
        let (src_dir, src) = state();
        two_contacts(&src);
        write(&src, src_dir.path(), || {}).unwrap();
        let (dst_dir, dst) = state();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        std::fs::copy(file_in(src_dir.path()), file_in(dst_dir.path())).unwrap();
        let full = std::fs::read_to_string(file_in(dst_dir.path())).unwrap();

        let mut seen = Vec::new();
        restore_if_empty(&dst, dst_dir.path(), || seen.push(flag(&dst))).unwrap();
        assert!(seen.first().unwrap().as_deref().unwrap().starts_with("pending:0:"), "{seen:?}");
        assert_eq!(flag(&dst).as_deref(), Some("1"));

        crate::custody::with_conn(&dst, |c| meta_set(c, RESTORED_KEY, PENDING)).unwrap();
        assert!(!write(&dst, dst_dir.path(), || {}).unwrap(), "a pending restore writes no snapshot");
        assert_eq!(std::fs::read_to_string(file_in(dst_dir.path())).unwrap(), full);
    }

    #[test]
    fn a_pending_restore_whose_file_is_gone_ends_so_the_safety_copy_can_be_written_again() {
        let (d, s) = state();
        two_contacts(&s);
        crate::custody::with_conn(&s, |c| meta_set(c, RESTORED_KEY, PENDING)).unwrap();
        assert_eq!(restore_if_empty(&s, d.path(), || {}).unwrap(), 0);
        assert_eq!(flag(&s).as_deref(), Some("1"));
        assert!(write(&s, d.path(), || {}).unwrap(), "the snapshot is written again");
    }

    #[test]
    fn a_restore_cut_short_resumes_without_duplicating_what_is_already_in() {
        let (src_dir, src) = state();
        two_contacts(&src);
        write(&src, src_dir.path(), || {}).unwrap();
        let text = std::fs::read_to_string(file_in(src_dir.path())).unwrap();
        let (dst_dir, dst) = state();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        std::fs::write(file_in(dst_dir.path()), &text).unwrap();
        // killed after the first chunk: one person in, flag still pending
        crate::custody::with_conn(&dst, |c| {
            vcard::import_cards(c, &vcard::VCard::parse_all(&text)[..1], "g")?;
            meta_set(c, RESTORED_KEY, "pending:1")
        })
        .unwrap();
        assert_eq!(people(&dst), 1);

        assert_eq!(restore_if_empty(&dst, dst_dir.path(), || {}).unwrap(), 1, "only the missing card is added");
        assert_eq!(people(&dst), 2);
        assert_eq!(flag(&dst).as_deref(), Some("1"));
    }

    #[test]
    fn a_restore_cut_short_resumes_at_its_chunk_and_never_duplicates_cards_without_an_email() {
        // email, phone-only and name-only cards: only the first kind has an address to find its person by
        let book: String = (0..450)
            .map(|i| match i % 3 {
                0 => format!("BEGIN:VCARD\nFN:P{i}\nEMAIL:p{i}@x.io\nEND:VCARD\n"),
                1 => format!("BEGIN:VCARD\nFN:Phone{i}\nTEL:+1 555 {i:07}\nEND:VCARD\n"),
                _ => format!("BEGIN:VCARD\nFN:Name{i}\nEND:VCARD\n"),
            })
            .collect();
        let (dst_dir, dst) = state();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        std::fs::write(file_in(dst_dir.path()), &book).unwrap();
        let cards = vcard::VCard::parse_all(&book);
        // killed after the first chunk of 200: those cards are in, the flag says how many
        crate::custody::with_conn(&dst, |c| {
            vcard::import_cards(c, &cards[..vcard::IMPORT_CHUNK], "g")?;
            meta_set(c, RESTORED_KEY, &format!("pending:200:{}", text_hash(&book)))
        })
        .unwrap();
        assert_eq!(people(&dst), 200);
        assert!(!write(&dst, dst_dir.path(), || {}).unwrap(), "a pending restore writes no snapshot");

        let mut seen = Vec::new();
        assert_eq!(restore_if_empty(&dst, dst_dir.path(), || seen.push(flag(&dst))).unwrap(), 250);
        assert_eq!(people(&dst), 450, "resumed at card 200, nobody twice");
        let h = text_hash(&book);
        assert_eq!(seen, [Some(format!("pending:200:{h}")), Some(format!("pending:400:{h}"))]);
        assert_eq!(flag(&dst).as_deref(), Some("1"));
    }

    #[test]
    fn a_restore_cut_short_over_a_file_that_was_replaced_starts_over_with_the_new_file() {
        let old: String = (0..450).map(|i| format!("BEGIN:VCARD\nFN:Old{i}\nEMAIL:o{i}@x.io\nEND:VCARD\n")).collect();
        let new: String = (0..250).map(|i| format!("BEGIN:VCARD\nFN:New{i}\nEMAIL:n{i}@y.io\nEND:VCARD\n")).collect();
        let (dst_dir, dst) = state();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        // killed after 200 cards of the old file ...
        crate::custody::with_conn(&dst, |c| {
            vcard::import_cards(c, &vcard::VCard::parse_all(&old)[..vcard::IMPORT_CHUNK], "g")?;
            meta_set(c, RESTORED_KEY, &format!("pending:200:{}", text_hash(&old)))
        })
        .unwrap();
        // ... and the file was replaced (a shorter one) before the next start
        std::fs::write(file_in(dst_dir.path()), &new).unwrap();

        assert_eq!(restore_if_empty(&dst, dst_dir.path(), || {}).unwrap(), 250, "every card of the new file");
        assert_eq!(people(&dst), 450);
        assert_eq!(flag(&dst).as_deref(), Some("1"));
    }

    #[test]
    fn restore_does_not_run_again_once_the_flag_is_set() {
        let (src_dir, src) = state();
        two_contacts(&src);
        write(&src, src_dir.path(), || {}).unwrap();

        let (dst_dir, dst) = state();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        std::fs::copy(file_in(src_dir.path()), file_in(dst_dir.path())).unwrap();
        crate::custody::with_conn(&dst, |c| meta_set(c, RESTORED_KEY, "1")).unwrap();

        assert_eq!(restore_if_empty(&dst, dst_dir.path(), || {}).unwrap(), 0);
        assert_eq!(people(&dst), 0);
    }

    #[test]
    fn restore_leaves_a_vault_that_already_has_people_alone() {
        let (src_dir, src) = state();
        two_contacts(&src);
        write(&src, src_dir.path(), || {}).unwrap();

        let (dst_dir, dst) = state();
        crate::custody::with_conn(&dst, |c| create_person(c, &NewPerson { display_name: "Cy".into(), emails: vec!["c@x.io".into()], ..Default::default() }).map(|_| ())).unwrap();
        std::fs::create_dir_all(dst_dir.path().join("Contacts")).unwrap();
        std::fs::copy(file_in(src_dir.path()), file_in(dst_dir.path())).unwrap();

        assert_eq!(restore_if_empty(&dst, dst_dir.path(), || {}).unwrap(), 0);
        assert_eq!(people(&dst), 1);
    }

    #[test]
    fn restore_with_no_file_does_nothing_and_does_not_set_the_flag() {
        let (d, s) = state();
        assert_eq!(restore_if_empty(&s, d.path(), || {}).unwrap(), 0);
        assert_eq!(crate::custody::with_conn(&s, |c| Ok(meta_get(c, RESTORED_KEY))).unwrap(), None);
    }

    #[test]
    fn a_write_waits_for_the_quiet_period_after_the_last_change() {
        assert!(!due(0, 100_000), "nothing waiting");
        assert!(!due(10_000, 10_000 + SETTLE_MS - 1));
        assert!(due(10_000, 10_000 + SETTLE_MS));
    }
}
