//! Maildir filename and repair helpers: uid parsing (`vault_filename_uid`,
//! `find_by_uid`, `uid_file_map`), the external-mirror uid rule, copy
//! verification, generation repair and orphan handling. The vault file
//! writer and readers (`store`, `read`, `list`, `delete`, `set_flags`, …)
//! live in `vault_files`, not here.
//! Layout: {root}/Maildir/{account_id}/{mailbox}/cur/{uid}:2,{flags}.eml
//! (the app's own format).

use std::fs;
use std::path::{Path, PathBuf};
use tracing::{info, warn};

/// Find a file by UID in a Maildir/cur directory.
pub fn find_by_uid(cur_dir: &Path, uid: u32) -> Option<PathBuf> {
    let prefix = format!("{}:", uid);
    if let Ok(entries) = fs::read_dir(cur_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) {
                return Some(entry.path());
            }
        }
    }
    None
}

/// The uid a vault filename carries, by `find_by_uid`'s exact rule: the name
/// starts with the canonical decimal uid and a `:`. `u32::parse` alone would
/// also take `07:` and `+7:`, which `find_by_uid(7)` never matches.
pub fn vault_filename_uid(name: &str) -> Option<u32> {
    let (digits, _) = name.split_once(':')?;
    let canonical = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    if canonical { digits.parse().ok() } else { None }
}

/// Every `<uid>:…` file in a Maildir `cur/` directory, keyed by uid, in ONE
/// directory pass. `find_by_uid` rescans the directory per call, which is
/// quadratic when a caller resolves a whole folder. Same matching rule as
/// `find_by_uid` (`vault_filename_uid`): legacy `12.eml` / `12_S.eml` names
/// are not vault rows. If two files carry the same uid the first one
/// `read_dir` yields wins, exactly as `find_by_uid` behaves.
pub fn uid_file_map(cur_dir: &Path) -> std::collections::HashMap<u32, PathBuf> {
    let mut map = std::collections::HashMap::new();
    let Ok(entries) = fs::read_dir(cur_dir) else { return map };
    for entry in entries.flatten() {
        let Some(uid) = vault_filename_uid(&entry.file_name().to_string_lossy()) else { continue };
        map.entry(uid).or_insert_with(|| entry.path());
    }
    map
}

/// The path an earlier `uid_file_map` listed for `uid`, if it is still there.
/// A flag change renames the file after the listing is taken, so a listed
/// path that is gone gets one `find_by_uid` rescan before the uid counts as
/// absent. A caller never looks up uids the listing did not have: that is
/// what keeps a whole selection linear.
pub fn find_listed_by_uid(cur_dir: &Path, uid: u32, listed: &Path) -> Option<PathBuf> {
    if listed.exists() {
        Some(listed.to_path_buf())
    } else {
        find_by_uid(cur_dir, uid)
    }
}

/// The uid a message filename carries by the external mirror's rule: the text
/// before the first `:`, `.` or `_`. The mirror has held
/// `<uid>:2,<flags>[.eml]`, legacy `<uid>.eml` and `<uid>_<flags>.eml`. Looser
/// than `vault_filename_uid` (it also takes `07.eml` and `+7.eml`), which is
/// what every mirror check has always matched.
pub fn mirror_filename_uid(name: &str) -> Option<u32> {
    name.split(|c: char| c == ':' || c == '.' || c == '_').next()?.parse().ok()
}

/// Every file in `dir` keyed by `mirror_filename_uid`, in ONE directory pass,
/// first entry per uid wins. The per-uid mirror lookup rescans the directory
/// on every call, and on the external drive that is the slowest disk the app
/// touches.
pub fn mirror_file_map(dir: &Path) -> HashMap<u32, PathBuf> {
    let mut map = HashMap::new();
    let Ok(entries) = fs::read_dir(dir) else { return map };
    for entry in entries.flatten() {
        let Some(uid) = mirror_filename_uid(&entry.file_name().to_string_lossy()) else { continue };
        map.entry(uid).or_insert_with(|| entry.path());
    }
    map
}

/// Which copies of a fetched message a backup still has to write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopiesToWrite {
    /// The vault holds the uid: neither side is written, and the message does
    /// not count as backed up.
    Nothing,
    /// The vault copy only: no mirror is configured, or it holds the uid.
    Vault,
    VaultAndMirror,
}

/// A backup's per-message decision, from uid sets instead of a directory
/// rescan of each side per message. `vault` holds the keys of a
/// `uid_file_map` listing of `cur/`, `mirror` those of a `mirror_file_map`
/// listing of the mirror folder (`None` when no mirror is configured), each
/// plus every uid the run has written there since. The vault gates both
/// sides, as the rescans did.
pub fn copies_to_write(uid: u32, vault: &HashSet<u32>, mirror: Option<&HashSet<u32>>) -> CopiesToWrite {
    if vault.contains(&uid) {
        CopiesToWrite::Nothing
    } else if matches!(mirror, Some(mirrored) if !mirrored.contains(&uid)) {
        CopiesToWrite::VaultAndMirror
    } else {
        CopiesToWrite::Vault
    }
}


#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct EmlMigrationStats {
    pub renamed: u64,
    pub already_ok: u64,
    pub skipped_non_message: u64,
    pub errors: u64,
}

const MAILDIR_VERSION_FILE: &str = ".maildir_version";
const MAILDIR_CURRENT_VERSION: u32 = 3;

/// One-time migration: append `.eml` to every Maildir message file that lacks
/// the extension. Idempotent — guarded by `{data_dir}/Maildir/.maildir_version`.
///
/// Walks `{data_dir}/Maildir/*/*/{cur,new,tmp}/` and renames files whose name
/// looks like a Maildir message (`{uid}:...`) but does not already end in
/// `.eml`. Files that don't match the pattern (a stray JSON file, say) are
/// left alone.
pub fn migrate_add_eml_extension(data_dir: &Path) -> EmlMigrationStats {
    let mut stats = EmlMigrationStats::default();
    let maildir_root = data_dir.join("Maildir");
    if !maildir_root.exists() {
        return stats;
    }

    let version_path = maildir_root.join(MAILDIR_VERSION_FILE);
    if let Ok(s) = fs::read_to_string(&version_path) {
        if s.trim().parse::<u32>().unwrap_or(0) >= MAILDIR_CURRENT_VERSION {
            return stats;
        }
    }

    let account_dirs = match fs::read_dir(&maildir_root) {
        Ok(d) => d,
        Err(e) => {
            warn!("migrate_add_eml_extension: read Maildir root failed: {}", e);
            return stats;
        }
    };

    for account_entry in account_dirs.flatten() {
        if !account_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mailbox_dirs = match fs::read_dir(account_entry.path()) {
            Ok(d) => d,
            Err(_) => continue,
        };
        for mailbox_entry in mailbox_dirs.flatten() {
            if !mailbox_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            for sub in ["cur", "new", "tmp"] {
                let dir = mailbox_entry.path().join(sub);
                if !dir.exists() {
                    continue;
                }
                rename_dir_add_eml(&dir, &mut stats);
            }
        }
    }

    if let Err(e) = fs::write(&version_path, MAILDIR_CURRENT_VERSION.to_string()) {
        warn!("migrate_add_eml_extension: write version file failed: {}", e);
    }

    info!(
        "migrate_add_eml_extension: renamed={} already_ok={} skipped={} errors={}",
        stats.renamed, stats.already_ok, stats.skipped_non_message, stats.errors
    );
    stats
}

fn rename_dir_add_eml(dir: &Path, stats: &mut EmlMigrationStats) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();

        // Heuristic: Maildir message filenames start with `{uid}:`.
        // Anything else (a stray JSON file, hidden files, etc.) is left alone.
        let looks_like_message = name
            .split(':')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .is_some();
        if !looks_like_message {
            stats.skipped_non_message += 1;
            continue;
        }

        if name.ends_with(".eml") {
            stats.already_ok += 1;
            continue;
        }

        let src = entry.path();
        let dst = dir.join(format!("{}.eml", name));
        if dst.exists() {
            // Collision: a sibling already has the `.eml` variant. Leave the
            // extension-less file in place — readers match by `{uid}:` prefix,
            // so the first hit still resolves. Don't silently overwrite.
            warn!("migrate_add_eml_extension: collision, skipping: {:?}", src);
            stats.errors += 1;
            continue;
        }
        match fs::rename(&src, &dst) {
            Ok(()) => stats.renamed += 1,
            Err(e) => {
                warn!("migrate_add_eml_extension: rename {:?} failed: {}", src, e);
                stats.errors += 1;
            }
        }
    }
}

// ── Vault generation (UIDVALIDITY) ──────────────────────────────────────────
//
// The vault is keyed (account_id, mailbox, uid) and, until this file existed,
// recorded nothing about *which* UID space that uid came from. A mailbox's UID
// space is only meaningful within one UIDVALIDITY generation: when the server
// reissues it — a change-server migration, or a reissue the server does on its
// own — every uid the vault holds names a different message, or no message at
// all. The read still lands on a real file, so nothing errors: `find_by_uid`
// hands back a message that was archived under that number by the *previous*
// server, and every caller that asks "is uid N archived?" gets a yes about
// some other message.
//
// `.uidvalidity` (a sibling of `cur/`) records
// the generation the files in `cur/` are keyed under. When it names a
// generation the server has replaced, `repair_generation` re-binds what it can
// by Message-ID and moves the rest out of the uid namespace into `orphaned/`.
//
// A *missing* stamp is a different question, and answering it the same way was
// a bug: a vault dir written by `archive_emails` or by the scheduled backup has
// no stamp until the first repair writes one, so the first open treated every
// copy of a message the server no longer has - deleted by a cleanup rule, by
// the user, by another client - as a reissue casualty. There the mailbox is
// adopted instead: files still bind by Message-ID, and one that binds to
// nothing keeps its place unless its uid is one the current generation has
// handed to some other message. Only that collision is set aside.
//
// Nothing here deletes mail. A message that isn't on the new server is exactly
// the message the vault is *for*; it moves to `orphaned/` (still on disk,
// still exportable) rather than being destroyed to reclaim space. But
// `orphaned/` is not listed, searched or exported by the app, so a file put
// there is a file the user cannot see - which is why it takes a real collision,
// not merely an absence, to put one there on a first open.

use std::collections::{HashMap, HashSet};
use std::io::Read;

pub const GENERATION_FILE: &str = ".uidvalidity";
pub const ORPHAN_DIR: &str = "orphaned";

/// Two-phase rename marker. A rebind can target a uid that an as-yet-unvisited
/// file still occupies, so every rebind lands on `{final}.regen` first and the
/// whole set is un-suffixed once `cur/` holds no old-generation names.
const REGEN_SUFFIX: &str = ".regen";

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationRepair {
    /// False when the stamp already matched — the hot path, one small file read.
    pub ran: bool,
    /// Files re-keyed to the uid the current generation gives their Message-ID.
    pub rebound: Vec<(u32, u32)>,
    /// Old uids moved to `orphaned/` — no Message-ID, or none the server has.
    pub orphaned: Vec<u32>,
    /// Files an earlier repair set aside that this one could bind after all.
    pub recovered: Vec<u32>,
    /// Files whose Message-ID still resolves to the uid they already had, plus
    /// the locally-created ones that were never the server's to renumber.
    pub kept: u32,
    pub errors: u32,
    /// The generation now recorded for this mailbox.
    pub generation: u32,
}

/// Strip the angle brackets and surrounding space so both sides of the join
/// agree. `read_message_id` keeps `<...>` from the header value; a sidecar
/// written by the frontend may not, and neither side is worth rewriting for
/// this.
pub fn normalize_message_id(raw: &str) -> String {
    raw.trim().trim_start_matches('<').trim_end_matches('>').trim().to_string()
}

/// Which of `uids` the vault holds, split three ways: verified, missing,
/// mismatched.
///
/// A file under the uid's name is the weakest of proofs: uids are per-mailbox
/// and a recreated mailbox reissues them, so the file sitting at uid 12 may be
/// a different message than the one the caller is about to delete from the
/// server. Where the caller knows what Message-ID it expects, that is checked
/// and a disagreement lands in `mismatched` - never in `verified`.
///
/// The absence of proof is not proof of a swap: a uid with no expected id, or
/// a file whose header carries none, verifies on presence alone.
pub fn verify_copies(
    cur_dir: &Path,
    uids: &[u32],
    expected_ids: Option<&HashMap<u32, String>>,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    verify_listed(cur_dir, &uid_file_map(cur_dir), uids, expected_ids)
}

/// `verify_copies` against a listing taken earlier. A uid the listing lacks
/// is missing: a copy written since is only unproven, and the caller keeps
/// the server's.
fn verify_listed(
    cur_dir: &Path,
    listing: &HashMap<u32, PathBuf>,
    uids: &[u32],
    expected_ids: Option<&HashMap<u32, String>>,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let mut verified: Vec<u32> = Vec::new();
    let mut missing: Vec<u32> = Vec::new();
    let mut mismatched: Vec<u32> = Vec::new();

    for uid in uids {
        let Some(path) = listing.get(uid).and_then(|listed| find_listed_by_uid(cur_dir, *uid, listed)) else {
            missing.push(*uid);
            continue;
        };
        let expected = expected_ids
            .and_then(|m| m.get(uid))
            .map(|id| normalize_message_id(id))
            .filter(|id| !id.is_empty());
        // read_message_id already returns the id normalized the same way.
        match (expected, read_message_id(&path)) {
            (Some(want), Some(got)) if want != got => mismatched.push(*uid),
            _ => verified.push(*uid),
        }
    }

    (verified, missing, mismatched)
}

/// The header section of an RFC 5322 message — everything before the first
/// blank line, or the whole slice when there isn't one.
fn header_section(bytes: &[u8]) -> &[u8] {
    let end = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 2)
        .or_else(|| bytes.windows(2).position(|w| w == b"\n\n").map(|i| i + 1))
        .unwrap_or(bytes.len());
    &bytes[..end]
}

/// Read just the Message-ID of an `.eml`, without parsing the message.
///
/// Reads at most 128 KiB: this runs once per vault file during a repair, and a
/// full `vault_eml::parse_eml_bytes` (addresses, snippet extraction, MIME
/// walk) over a 14k-message mailbox is minutes of work to answer one
/// question.
pub fn read_message_id(path: &Path) -> Option<String> {
    let mut buf = Vec::new();
    fs::File::open(path).ok()?.take(128 * 1024).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(header_section(&buf));

    let mut value: Option<String> = None;
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if value.is_some() {
            // Folded continuation — a header line that starts with WSP.
            if line.starts_with(' ') || line.starts_with('\t') {
                value.as_mut().unwrap().push_str(line.trim());
                continue;
            }
            break;
        }
        const KEY: &str = "message-id:";
        // `get`, not a slice: a header line can start mid-way through a
        // multi-byte character once the bytes go through `from_utf8_lossy`, and
        // slicing off a non-boundary panics.
        if matches!(line.get(..KEY.len()), Some(head) if head.eq_ignore_ascii_case(KEY)) {
            value = Some(line[KEY.len()..].trim().to_string());
        }
    }

    let v = value?;
    let inner = match (v.find('<'), v.rfind('>')) {
        (Some(a), Some(b)) if b > a => &v[a + 1..b],
        _ => v.trim(),
    };
    let id = normalize_message_id(inner);
    if id.is_empty() { None } else { Some(id) }
}

/// The generation the files in this mailbox's `cur/` are keyed under, if it was
/// ever recorded. `None` means a vault written before this stamp existed — the
/// caller must verify rather than assume, since that is exactly the vault a
/// reissue may already have silently invalidated.
pub fn read_generation(mailbox_dir: &Path) -> Option<u32> {
    fs::read_to_string(mailbox_dir.join(GENERATION_FILE))
        .ok()?
        .trim()
        .parse()
        .ok()
}

pub fn write_generation(mailbox_dir: &Path, uid_validity: u32) -> Result<(), String> {
    fs::create_dir_all(mailbox_dir).map_err(|e| format!("Failed to create mailbox dir: {}", e))?;
    fs::write(mailbox_dir.join(GENERATION_FILE), uid_validity.to_string())
        .map_err(|e| format!("Failed to write {}: {}", GENERATION_FILE, e))
}

/// Swap the uid on a Maildir filename, leaving the rest — flags, timestamp,
/// `.eml` — exactly as it was. Both shipped filename formats (`{uid}:2,{flags}`
/// and `{uid}:{flags}:{ts}`) put the uid first and a `:` right after it.
fn with_uid(name: &str, new_uid: u32) -> String {
    match name.find(':') {
        Some(i) => format!("{}{}", new_uid, &name[i..]),
        None => new_uid.to_string(),
    }
}

/// Undo `free_orphan_path`'s dedupe suffix, so a recovered file goes back with
/// the `.eml` extension the OS and the zip export need.
fn strip_orphan_suffix(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head.to_string(),
        _ => name.to_string(),
    }
}

/// A free name in `orphaned/` — repeated repairs can orphan the same uid twice.
fn free_orphan_path(orphan_dir: &Path, name: &str) -> PathBuf {
    let direct = orphan_dir.join(name);
    if !direct.exists() {
        return direct;
    }
    for n in 1..1000 {
        let candidate = orphan_dir.join(format!("{}.{}", name, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    orphan_dir.join(format!("{}.dup", name))
}

/// Re-key a mailbox's vault files onto the current UID generation.
///
/// `id_to_uid` maps normalized Message-ID → the uid the *current* generation
/// gives it. It must cover the whole mailbox: a hit is proof a file belongs at
/// that uid, but a miss is only proof of absence if the map was complete to
/// begin with. The caller owns that check — pass a partial map and every
/// unlisted message reads as gone from the server.
///
/// `protected` holds uids the server never issued: messages composed here that
/// live only in the vault. A UID reissue says nothing about them, so they keep
/// their uid and are never moved aside for missing from a server they were
/// never on.
///
/// What happens to a file the map cannot place depends on what the stamp says:
///
/// - stamp present and different - a reissue. Its uid means nothing now, so the
///   file goes to `orphaned/`.
/// - stamp absent - a mailbox nobody has stamped yet, adopted as it stands. The
///   file keeps its uid, unless the current generation has given that uid to
///   another message (or it is `protected`), which is the one case where
///   keeping it would answer "uid N is archived" about the wrong mail.
///
/// No-ops when the recorded generation already matches, so this is cheap to
/// call on every mailbox load.
pub fn repair_generation(
    mailbox_dir: &Path,
    current_uid_validity: u32,
    id_to_uid: &HashMap<String, u32>,
    protected: &HashSet<u32>,
) -> GenerationRepair {
    let mut report = GenerationRepair { generation: current_uid_validity, ..Default::default() };

    let recorded = read_generation(mailbox_dir);
    if recorded == Some(current_uid_validity) {
        return report;
    }
    // No stamp is not a reissue. The mailbox is adopted: unmatched files keep
    // their place unless their uid collides with one the server is using.
    let adopting = recorded.is_none();
    report.ran = true;

    let cur = mailbox_dir.join("cur");
    if !cur.exists() {
        if let Err(e) = write_generation(mailbox_dir, current_uid_validity) {
            warn!("repair_generation: {}", e);
            report.errors += 1;
        }
        return report;
    }

    // ── Plan ──
    // A uid is claimed by the first file that resolves to it. Two vault files
    // can carry the same Message-ID (a duplicate archive); only one of them can
    // hold the uid, and the loser is orphaned rather than silently overwriting.
    // Locally-created uids are reserved before anything else can claim them:
    // their files stay where they are, so a rebind must not be handed the same
    // number.
    let mut claimed: HashSet<u32> = protected.clone();
    let mut plan: Vec<(PathBuf, String, u32, Option<u32>)> = Vec::new();
    // Every uid the current generation hands out. When adopting, this is what
    // separates "the server gave this number to a different message" (a real
    // collision, set the file aside) from "nobody is using this number" (mail
    // the server no longer has, which is what the vault is for).
    let server_uids: HashSet<u32> = id_to_uid.values().copied().collect();

    let entries = match fs::read_dir(&cur) {
        Ok(e) => e,
        Err(e) => {
            warn!("repair_generation: read {:?} failed: {}", cur, e);
            report.errors += 1;
            return report;
        }
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // Item 9 (final fix wave): `vault_filename_uid` is the one uid parse
        // every other reader uses — it rejects a non-canonical name
        // (`07:`/`+7:`) that `split(':').next().parse()` would happily bind
        // to a real uid, letting a repair rebind or orphan a file no other
        // reader would ever recognise as that message.
        let old_uid: u32 = match vault_filename_uid(&name) {
            Some(u) => u,
            None => continue,
        };
        if protected.contains(&old_uid) {
            report.kept += 1;
            continue;
        }
        let new_uid = read_message_id(&entry.path())
            .and_then(|id| id_to_uid.get(&id).copied())
            .filter(|u| claimed.insert(*u));
        // Adopting a never-stamped mailbox: nothing binds this file, and no
        // one else wants its number, so it stays. `claimed.insert` both asks
        // whether the uid is free (protected uids and rebind targets are
        // already in there) and reserves it against a later rebind.
        if new_uid.is_none() && adopting && !server_uids.contains(&old_uid) && claimed.insert(old_uid) {
            report.kept += 1;
            continue;
        }
        plan.push((entry.path(), name, old_uid, new_uid));
    }

    // ── Plan: files an earlier repair set aside get another chance ──
    //
    // "The server does not have this" is only ever as good as the cache that
    // said so. A later generation, read against a fuller cache, can find the
    // message after all — so `orphaned/` is a holding area the repair reads
    // back, not a one-way door. Without this, one repair run against a cache
    // that was complete-looking but stale would set a message aside for good.
    let orphan_dir = mailbox_dir.join(ORPHAN_DIR);
    let mut recover: Vec<(PathBuf, String, u32)> = Vec::new();
    if let Ok(entries) = fs::read_dir(&orphan_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let name = strip_orphan_suffix(&entry.file_name().to_string_lossy());
            // Item 9 (final fix wave): same canonical-uid rule as above.
            if vault_filename_uid(&name).is_none() {
                continue;
            }
            if let Some(nu) = read_message_id(&entry.path())
                .and_then(|id| id_to_uid.get(&id).copied())
                .filter(|u| claimed.insert(*u))
            {
                recover.push((entry.path(), name, nu));
            }
        }
    }

    // ── Apply, phase 1: every file leaves its old-generation name ──
    let mut staged: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (path, name, new_uid) in recover {
        let final_name = with_uid(&name, new_uid);
        let tmp = cur.join(format!("{}{}", final_name, REGEN_SUFFIX));
        match fs::rename(&path, &tmp) {
            Ok(()) => {
                staged.push((tmp, cur.join(final_name)));
                report.recovered.push(new_uid);
            }
            Err(e) => {
                warn!("repair_generation: recover {:?} failed: {}", path, e);
                report.errors += 1;
            }
        }
    }
    for (path, name, old_uid, new_uid) in plan {
        match new_uid {
            Some(nu) => {
                let final_name = with_uid(&name, nu);
                let tmp = cur.join(format!("{}{}", final_name, REGEN_SUFFIX));
                match fs::rename(&path, &tmp) {
                    Ok(()) => {
                        staged.push((tmp, cur.join(final_name)));
                        if nu == old_uid {
                            report.kept += 1;
                        } else {
                            report.rebound.push((old_uid, nu));
                        }
                    }
                    Err(e) => {
                        warn!("repair_generation: rebind {:?} failed: {}", path, e);
                        report.errors += 1;
                    }
                }
            }
            None => {
                if let Err(e) = fs::create_dir_all(&orphan_dir) {
                    warn!("repair_generation: mkdir {:?} failed: {}", orphan_dir, e);
                    report.errors += 1;
                    continue;
                }
                let dst = free_orphan_path(&orphan_dir, &name);
                match fs::rename(&path, &dst) {
                    Ok(()) => report.orphaned.push(old_uid),
                    Err(e) => {
                        warn!("repair_generation: orphan {:?} failed: {}", path, e);
                        report.errors += 1;
                    }
                }
            }
        }
    }

    // ── Apply, phase 2: `cur/` holds no old-generation names, so the final
    // names are free ──
    for (tmp, final_path) in staged {
        if let Err(e) = fs::rename(&tmp, &final_path) {
            warn!("repair_generation: unstage {:?} failed: {}", tmp, e);
            report.errors += 1;
        }
    }

    if let Err(e) = write_generation(mailbox_dir, current_uid_validity) {
        warn!("repair_generation: {}", e);
        report.errors += 1;
    }

    info!(
        "repair_generation: {:?} → UIDVALIDITY {} — {} rebound, {} recovered, {} kept, {} orphaned, {} errors",
        mailbox_dir, current_uid_validity, report.rebound.len(), report.recovered.len(),
        report.kept, report.orphaned.len(), report.errors,
    );
    report
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanStats {
    pub count: u64,
    pub bytes: u64,
}

/// Count what a mailbox's repair moved out of the uid namespace.
pub fn orphan_stats(mailbox_dir: &Path) -> OrphanStats {
    let mut stats = OrphanStats::default();
    if let Ok(entries) = fs::read_dir(mailbox_dir.join(ORPHAN_DIR)) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                stats.count += 1;
                stats.bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    stats
}

/// Delete a mailbox's orphan folder. Only ever called for a user who asked —
/// these are messages the current server does not have, so this is the one
/// place in the vault where deleting can lose the last copy.
pub fn purge_orphans(mailbox_dir: &Path) -> Result<u64, String> {
    let dir = mailbox_dir.join(ORPHAN_DIR);
    if !dir.exists() {
        return Ok(0);
    }
    let removed = orphan_stats(mailbox_dir).count;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove {:?}: {}", dir, e))?;
    info!("purge_orphans: removed {} files from {:?}", removed, dir);
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_migrate_add_eml_extension_renames_and_is_idempotent() {
        let dir = std::env::temp_dir().join("mailvault-test-migrate-eml");
        let _ = fs::remove_dir_all(&dir);

        let cur = dir.join("Maildir").join("acc1").join("INBOX").join("cur");
        fs::create_dir_all(&cur).unwrap();
        // Pre-migration files (no `.eml`) in both filename formats we ship.
        fs::write(cur.join("101:2,S"), b"A").unwrap();
        fs::write(cur.join("102:seen:1700000000"), b"B").unwrap();
        // Already-migrated sibling — must be left alone.
        fs::write(cur.join("103:2,S.eml"), b"C").unwrap();
        // Non-message file — must be left alone.
        fs::write(cur.join("local-index.json"), b"{}").unwrap();

        let s1 = migrate_add_eml_extension(&dir);
        assert_eq!(s1.renamed, 2);
        assert_eq!(s1.already_ok, 1);
        assert_eq!(s1.skipped_non_message, 1);
        assert_eq!(s1.errors, 0);
        assert!(cur.join("101:2,S.eml").exists());
        assert!(cur.join("102:seen:1700000000.eml").exists());
        assert!(cur.join("103:2,S.eml").exists());
        assert!(cur.join("local-index.json").exists());

        // Second run — version marker must short-circuit it.
        let s2 = migrate_add_eml_extension(&dir);
        assert_eq!(s2.renamed, 0);
        assert_eq!(s2.already_ok, 0);

        // Readers still resolve by UID prefix after migration.
        assert!(find_by_uid(&cur, 101).is_some());
        assert!(find_by_uid(&cur, 102).is_some());

        let _ = fs::remove_dir_all(&dir);
    }

    /// v2.5.0 shipped the rename but not the writer, so every file stored
    /// between then and the fix landed without the extension in a vault the
    /// version marker already called migrated. The bump has to sweep them.
    #[test]
    fn test_migrate_sweeps_files_written_after_an_earlier_version_marker() {
        let dir = std::env::temp_dir().join("mailvault-test-migrate-eml-v2");
        let _ = fs::remove_dir_all(&dir);

        let cur = dir.join("Maildir").join("acc1").join("INBOX").join("cur");
        fs::create_dir_all(&cur).unwrap();
        fs::write(dir.join("Maildir").join(MAILDIR_VERSION_FILE), b"2").unwrap();
        fs::write(cur.join("201:2,S"), b"A").unwrap();

        let s = migrate_add_eml_extension(&dir);

        assert_eq!(s.renamed, 1);
        assert!(cur.join("201:2,S.eml").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    // ── Vault generation (UIDVALIDITY) ──────────────────────────────────────

    fn eml(message_id: &str, body: &str) -> Vec<u8> {
        format!(
            "From: a@b.test\r\nTo: c@d.test\r\nSubject: s\r\nMessage-ID: <{}>\r\nDate: Mon, 1 Apr 2026 10:00:00 +0000\r\n\r\n{}",
            message_id, body
        ).into_bytes()
    }

    #[test]
    fn test_read_message_id() {
        let dir = std::env::temp_dir().join("mailvault-test-read-msgid");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        fs::write(dir.join("plain.eml"), eml("m1@host.test", "body")).unwrap();
        assert_eq!(read_message_id(&dir.join("plain.eml")), Some("m1@host.test".into()));

        // Folded across two lines, and the header name in a casing no server uses.
        fs::write(
            dir.join("folded.eml"),
            b"Subject: s\r\nMESSAGE-id:\r\n <folded@host.test>\r\n\r\nbody".to_vec(),
        ).unwrap();
        assert_eq!(read_message_id(&dir.join("folded.eml")), Some("folded@host.test".into()));

        // LF-only line endings — plenty of .eml files on disk have them.
        fs::write(dir.join("lf.eml"), b"Message-ID: <lf@host.test>\n\nbody".to_vec()).unwrap();
        assert_eq!(read_message_id(&dir.join("lf.eml")), Some("lf@host.test".into()));

        // A Message-ID-less message is the case the read-time guard cannot
        // catch, so it must come back None and be treated as unbindable.
        fs::write(dir.join("none.eml"), b"Subject: s\r\n\r\nbody".to_vec()).unwrap();
        assert_eq!(read_message_id(&dir.join("none.eml")), None);

        // A header line whose first bytes are multi-byte UTF-8. Slicing the
        // prefix off this panics; `get` returns None and moves on.
        fs::write(
            dir.join("utf8.eml"),
            "Subject: \u{4f60}\u{597d}\u{4e16}\u{754c}\r\nMessage-ID: <utf8@host.test>\r\n\r\nbody".as_bytes().to_vec(),
        ).unwrap();
        assert_eq!(read_message_id(&dir.join("utf8.eml")), Some("utf8@host.test".into()));

        // The body must not be searched — a quoted reply carries the parent's
        // Message-ID and would bind the file to the wrong message.
        fs::write(
            dir.join("bodyid.eml"),
            b"Subject: s\r\n\r\nOn Mon someone wrote:\r\nMessage-ID: <quoted@host.test>\r\n".to_vec(),
        ).unwrap();
        assert_eq!(read_message_id(&dir.join("bodyid.eml")), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_rebinds_orphans_and_stamps() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-gen");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // uid 1 and uid 5 both need to move, and 1's new uid is 5 — the
        // collision the two-phase rename exists for.
        fs::write(cur.join("1:2,S.eml"), eml("moved@host.test", "one")).unwrap();
        fs::write(cur.join("5:seen:1700000000.eml"), eml("stays@host.test", "five")).unwrap();
        fs::write(cur.join("9:2,.eml"), eml("gone@host.test", "nine")).unwrap();
        fs::write(cur.join("12:2,.eml"), b"Subject: no id\r\n\r\nbody".to_vec()).unwrap();
        // Not a message — must be left exactly where it is.
        fs::write(cur.join("notes.txt"), b"keep me").unwrap();
        // A real reissue: the vault says which generation it is keyed under and
        // the server now reports another one. Unstamped is a different question
        // (see `..._adopts_an_unstamped_mailbox_...`).
        write_generation(&mailbox, 605297893).unwrap();

        let id_to_uid: HashMap<String, u32> = [
            ("moved@host.test".to_string(), 5u32),
            ("stays@host.test".to_string(), 7u32),
        ].into_iter().collect();

        let r = repair_generation(&mailbox, 605297894, &id_to_uid, &HashSet::new());
        assert!(r.ran);
        assert_eq!(r.errors, 0);
        assert_eq!(r.generation, 605297894);
        assert_eq!(r.rebound.len(), 2);
        assert!(r.rebound.contains(&(1, 5)));
        assert!(r.rebound.contains(&(5, 7)));
        // No Message-ID and no match both mean "cannot prove this is that uid".
        assert_eq!(r.orphaned.len(), 2);
        assert!(r.orphaned.contains(&9));
        assert!(r.orphaned.contains(&12));

        // Flags and timestamp survive the re-key; only the uid changes.
        assert!(cur.join("5:2,S.eml").exists());
        assert!(cur.join("7:seen:1700000000.eml").exists());
        assert!(!cur.join("1:2,S.eml").exists());
        assert!(cur.join("notes.txt").exists());
        // No half-renamed leftovers.
        assert!(fs::read_dir(&cur).unwrap().flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(REGEN_SUFFIX)));

        // The re-keyed file is the one that moved, not the one that was already there.
        assert_eq!(read_message_id(&cur.join("5:2,S.eml")), Some("moved@host.test".into()));

        assert_eq!(orphan_stats(&mailbox).count, 2);
        assert_eq!(read_generation(&mailbox), Some(605297894));

        // Second call with the same generation must not touch the mailbox again.
        let r2 = repair_generation(&mailbox, 605297894, &id_to_uid, &HashSet::new());
        assert!(!r2.ran);
        assert!(r2.rebound.is_empty());

        assert_eq!(purge_orphans(&mailbox).unwrap(), 2);
        assert_eq!(orphan_stats(&mailbox).count, 0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_ignores_non_canonical_uid_names() {
        // Item 9 (final fix wave): `07:`/`+7:` are not canonical vault uids —
        // `vault_filename_uid` rejects them, and `repair_generation` must
        // agree (it used to parse them via `split(':').next().parse()`,
        // which happily bound both to uid 7).
        let dir = std::env::temp_dir().join(format!("mailvault-test-repair-noncanon-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        fs::write(cur.join("07:2,S.eml"), eml("zero-pad@host.test", "a")).unwrap();
        fs::write(cur.join("+7:2,S.eml"), eml("plus@host.test", "b")).unwrap();
        write_generation(&mailbox, 1).unwrap();

        let id_to_uid: HashMap<String, u32> = [
            ("zero-pad@host.test".to_string(), 7u32),
            ("plus@host.test".to_string(), 7u32),
        ].into_iter().collect();

        let r = repair_generation(&mailbox, 2, &id_to_uid, &HashSet::new());
        assert!(r.ran);
        assert_eq!(r.errors, 0);
        assert!(r.rebound.is_empty(), "a non-canonical name must never be rebound: {:?}", r.rebound);
        assert!(r.orphaned.is_empty(), "a non-canonical name must never be orphaned either: {:?}", r.orphaned);
        assert!(cur.join("07:2,S.eml").exists());
        assert!(cur.join("+7:2,S.eml").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_duplicate_message_id_keeps_one() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-dupe");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        fs::write(cur.join("1:2,.eml"), eml("dupe@host.test", "first")).unwrap();
        fs::write(cur.join("2:2,.eml"), eml("dupe@host.test", "second")).unwrap();
        // A reissue, not a first open: the collision policy is what is on trial.
        write_generation(&mailbox, 1).unwrap();

        let id_to_uid: HashMap<String, u32> =
            [("dupe@host.test".to_string(), 4u32)].into_iter().collect();

        let r = repair_generation(&mailbox, 2, &id_to_uid, &HashSet::new());
        // One uid, one file. The loser is kept, not overwritten.
        assert_eq!(r.rebound.len(), 1);
        assert_eq!(r.orphaned.len(), 1);
        assert_eq!(r.errors, 0);
        assert!(cur.join("4:2,.eml").exists());
        assert_eq!(orphan_stats(&mailbox).count, 1);

        let _ = fs::remove_dir_all(&dir);
    }



    #[test]
    fn test_repair_generation_recovers_an_orphan_a_later_cache_can_place() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-recover");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        fs::write(cur.join("1:2,S.eml"), eml("later@host.test", "one")).unwrap();
        // Stamped under the generation the server has just replaced - the only
        // case that sets a file aside, and so the only way to get an orphan to
        // recover from.
        write_generation(&mailbox, 1).unwrap();

        // Generation 2, read against a cache that did not know this message.
        let r1 = repair_generation(&mailbox, 2, &HashMap::new(), &HashSet::new());
        assert_eq!(r1.orphaned, vec![1]);
        assert_eq!(orphan_stats(&mailbox).count, 1);

        // Generation 3, read against a cache that does. "Not on the server" was
        // only ever as good as the cache that said it, so `orphaned/` has to be
        // a holding area the repair reads back.
        let id_to_uid: HashMap<String, u32> =
            [("later@host.test".to_string(), 11u32)].into_iter().collect();
        let r2 = repair_generation(&mailbox, 3, &id_to_uid, &HashSet::new());
        assert_eq!(r2.recovered, vec![11]);
        assert_eq!(r2.errors, 0);
        assert!(cur.join("11:2,S.eml").exists(), "recovered file keeps its .eml name");
        assert_eq!(orphan_stats(&mailbox).count, 0);
        assert_eq!(read_message_id(&cur.join("11:2,S.eml")), Some("later@host.test".into()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_never_orphans_a_locally_created_message() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-protected");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("Sent");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // A message composed here and never accepted by a server. It is in no
        // sidecar and never will be, so the Message-ID join can only miss it.
        fs::write(cur.join("900:2,S.eml"), eml("composed-here@mailvault", "draft")).unwrap();
        fs::write(cur.join("3:2,.eml"), eml("fromserver@host.test", "archived")).unwrap();
        // A reissue: uid 3 losing its place to a protected uid is the point,
        // and only a stamped-then-changed generation moves anything aside.
        write_generation(&mailbox, 7).unwrap();

        let id_to_uid: HashMap<String, u32> =
            [("fromserver@host.test".to_string(), 900u32)].into_iter().collect();
        let protected: HashSet<u32> = [900u32].into_iter().collect();

        let r = repair_generation(&mailbox, 8, &id_to_uid, &protected);

        // The composed message keeps its uid and its place in the mailbox.
        assert!(cur.join("900:2,S.eml").exists());
        assert_eq!(read_message_id(&cur.join("900:2,S.eml")), Some("composed-here@mailvault".into()));
        assert!(!r.orphaned.contains(&900));

        // Its uid was reserved, so the server message that wanted 900 could not
        // take it — and rather than overwrite, that file is set aside intact.
        assert!(r.rebound.is_empty());
        assert_eq!(r.orphaned, vec![3]);
        assert_eq!(r.errors, 0);
        assert_eq!(orphan_stats(&mailbox).count, 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_adopts_an_unstamped_mailbox_and_keeps_its_deleted_mail() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-adopt");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // No `.uidvalidity`: a vault dir `archive_emails` or the scheduled
        // backup wrote, opened for the first time. uid 77 is the vault's whole
        // reason to exist - a message the server no longer has, because a
        // cleanup rule, the user, or another client deleted it.
        fs::write(cur.join("77:2,S.eml"), eml("deleted-from-server@host.test", "kept")).unwrap();
        fs::write(cur.join("3:2,.eml"), eml("still-there@host.test", "alive")).unwrap();

        let id_to_uid: HashMap<String, u32> =
            [("still-there@host.test".to_string(), 3u32)].into_iter().collect();

        let r = repair_generation(&mailbox, 5, &id_to_uid, &HashSet::new());
        assert!(r.ran);
        assert_eq!(r.errors, 0);
        assert!(r.orphaned.is_empty(), "adopted a mailbox but set mail aside: {:?}", r.orphaned);
        assert_eq!(r.kept, 2);
        assert!(r.rebound.is_empty());

        // Both files still where the app lists, searches and exports them.
        assert!(cur.join("77:2,S.eml").exists());
        assert!(cur.join("3:2,.eml").exists());
        assert!(!mailbox.join(ORPHAN_DIR).exists());
        assert_eq!(orphan_stats(&mailbox).count, 0);
        assert_eq!(read_generation(&mailbox), Some(5));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_adopting_still_orphans_a_uid_the_server_reissued() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-adopt-collide");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // Unstamped, and uid 4 names one message here and another one on the
        // server. That is a reissue a legacy vault never recorded, and keeping
        // the file would answer "uid 4 is archived" about the wrong message.
        fs::write(cur.join("4:2,S.eml"), eml("from-the-old-server@host.test", "old")).unwrap();

        let id_to_uid: HashMap<String, u32> =
            [("someone-else@host.test".to_string(), 4u32)].into_iter().collect();

        let r = repair_generation(&mailbox, 6, &id_to_uid, &HashSet::new());
        assert_eq!(r.orphaned, vec![4]);
        assert_eq!(r.kept, 0);
        assert_eq!(r.errors, 0);
        assert!(!cur.join("4:2,S.eml").exists());
        assert_eq!(orphan_stats(&mailbox).count, 1);
        assert_eq!(read_generation(&mailbox), Some(6));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_stamped_mailbox_still_orphans_what_it_cannot_bind() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-stamped-control");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        let cur = mailbox.join("cur");
        fs::create_dir_all(&cur).unwrap();

        // The control for the two above: same file, same map, and the one
        // difference is a stamp naming a generation the server has replaced.
        fs::write(cur.join("77:2,S.eml"), eml("deleted-from-server@host.test", "gone")).unwrap();
        write_generation(&mailbox, 4).unwrap();

        let r = repair_generation(&mailbox, 5, &HashMap::new(), &HashSet::new());
        assert_eq!(r.orphaned, vec![77]);
        assert_eq!(r.kept, 0);
        assert_eq!(r.errors, 0);
        assert!(!cur.join("77:2,S.eml").exists());
        assert_eq!(orphan_stats(&mailbox).count, 1);
        assert_eq!(read_generation(&mailbox), Some(5));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_repair_generation_stamps_an_empty_mailbox_without_scanning() {
        let dir = std::env::temp_dir().join("mailvault-test-repair-empty");
        let _ = fs::remove_dir_all(&dir);
        let mailbox = dir.join("Maildir").join("acc1").join("INBOX");
        fs::create_dir_all(&mailbox).unwrap();

        let r = repair_generation(&mailbox, 42, &HashMap::new(), &HashSet::new());
        assert!(r.ran);
        assert_eq!(r.errors, 0);
        assert_eq!(read_generation(&mailbox), Some(42));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uid_file_map_keys_colon_names_only() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        for name in ["7:2,S.eml", "12:2,.eml", "300:2,AF.eml", "12.eml", "13_S.eml", "not-a-uid:2,.eml", "_meta.json"] {
            fs::write(cur.join(name), b"x").unwrap();
        }
        let map = uid_file_map(cur);
        let mut keys: Vec<u32> = map.keys().copied().collect();
        keys.sort();
        assert_eq!(keys, vec![7, 12, 300]);
        assert_eq!(map[&12].file_name().unwrap().to_str().unwrap(), "12:2,.eml");
        assert_eq!(map[&300].file_name().unwrap().to_str().unwrap(), "300:2,AF.eml");
    }

    #[test]
    fn uid_file_map_agrees_with_find_by_uid() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        for name in ["1:2,S.eml", "10:2,.eml", "101:2,F.eml", "1010.eml", "07:2,S.eml", "+8:2,S.eml", "3:2,S.eml", "3:2,FS.eml"] {
            fs::write(cur.join(name), b"x").unwrap();
        }
        let map = uid_file_map(cur);
        for uid in [1u32, 10, 101, 1010, 5, 3, 7, 8] {
            assert_eq!(map.get(&uid).cloned(), find_by_uid(cur, uid), "uid {uid}");
        }
    }

    #[test]
    fn vault_filename_uid_is_find_by_uids_rule() {
        let cases = [
            ("7:2,S.eml", Some(7)),
            ("0:2,.eml", Some(0)),
            ("4294967295:2,.eml", Some(u32::MAX)),
            ("4294967296:2,.eml", None),
            ("07:2,.eml", None),
            ("+7:2,.eml", None),
            ("7.eml", None),
            (":2,.eml", None),
            ("7a:2,.eml", None),
            (".4711:2,S.eml.tmp-1", None),
        ];
        let wrong: Vec<_> = cases.iter()
            .filter(|(name, want)| vault_filename_uid(name) != *want)
            .map(|(name, want)| format!("{name}: got {:?}, want {want:?}", vault_filename_uid(name)))
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    #[test]
    fn uid_file_map_missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(uid_file_map(&tmp.path().join("nope")).is_empty());
    }

    /// Not a gate. `cargo test -p mailvault-core --release --lib bench_uid_lookup -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_uid_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        let n = 20_000u32;
        for uid in 1..=n { fs::write(cur.join(format!("{uid}:2,S.eml")), b"x").unwrap(); }
        let uids: Vec<u32> = (1..=n).collect();

        let t = std::time::Instant::now();
        let map = uid_file_map(cur);
        let hits = uids.iter().filter(|u| map.contains_key(u)).count();
        let single_pass = t.elapsed();

        let sample: Vec<u32> = uids.iter().step_by(100).copied().collect(); // 200 lookups
        let t = std::time::Instant::now();
        let slow_hits = sample.iter().filter(|u| find_by_uid(cur, **u).is_some()).count();
        let per_uid = t.elapsed() / sample.len() as u32;

        assert_eq!(hits, n as usize);
        assert_eq!(slow_hits, sample.len());
        println!("n={n} single_pass={single_pass:?} per_uid_rescan={per_uid:?} projected_old_total={:?}", per_uid * n);
    }

    #[test]
    fn mirror_filename_uid_takes_every_shape_the_mirror_has_carried() {
        let cases = [
            ("12:2,S.eml", Some(12)),
            ("12:2,S", Some(12)),
            ("12.eml", Some(12)),
            ("12_S.eml", Some(12)),
            ("12", Some(12)),
            // Looser than vault_filename_uid, and always has been.
            ("07.eml", Some(7)),
            ("+7.eml", Some(7)),
            ("4294967296.eml", None),
            ("12a.eml", None),
            ("_meta.json", None),
            (".4711:2,S.eml.tmp-1", None),
            ("", None),
        ];
        let wrong: Vec<_> = cases.iter()
            .filter(|(name, want)| mirror_filename_uid(name) != *want)
            .map(|(name, want)| format!("{name}: got {:?}, want {want:?}", mirror_filename_uid(name)))
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// src-tauri's `find_msg_file_by_uid` as every mirror check called it, one
    /// directory rescan per uid.
    fn per_uid_mirror_lookup(dir: &Path, uid: u32) -> Option<PathBuf> {
        let entries = fs::read_dir(dir).ok()?;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let head = name.split(|c: char| c == ':' || c == '.' || c == '_').next().unwrap_or("");
            if head.parse::<u32>().ok() == Some(uid) {
                return Some(entry.path());
            }
        }
        None
    }

    #[test]
    fn mirror_file_map_agrees_with_the_per_uid_mirror_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        for name in [
            "12:2,S.eml", "13:2,F", "14.eml", "15_S.eml", "07.eml", "+8.eml", "17",
            "16.eml", "16:2,F.eml", "4294967296.eml", "_meta.json", "not-a-uid.eml",
            ".4711:2,S.eml.tmp-1",
        ] {
            fs::write(dir.join(name), b"x").unwrap();
        }
        fs::create_dir(dir.join("18")).unwrap();

        let map = mirror_file_map(dir);
        for uid in [12u32, 13, 14, 15, 7, 8, 16, 17, 18, 4711, 0, 99] {
            assert_eq!(map.get(&uid).cloned(), per_uid_mirror_lookup(dir, uid), "uid {uid}");
        }
        let mut keys: Vec<u32> = map.keys().copied().collect();
        keys.sort();
        assert_eq!(keys, vec![7, 8, 12, 13, 14, 15, 16, 17, 18]);
        assert!(mirror_file_map(&dir.join("nope")).is_empty());
    }

    #[test]
    fn copies_to_write_lets_the_vault_gate_both_sides() {
        let empty = HashSet::new();
        let has7: HashSet<u32> = [7u32].into_iter().collect();
        let cases = [
            (7, &has7, Some(&empty), CopiesToWrite::Nothing),
            (7, &has7, Some(&has7), CopiesToWrite::Nothing),
            (7, &has7, None, CopiesToWrite::Nothing),
            (7, &empty, Some(&empty), CopiesToWrite::VaultAndMirror),
            (7, &empty, Some(&has7), CopiesToWrite::Vault),
            (7, &empty, None, CopiesToWrite::Vault),
            // Membership is per uid, not "the set is non-empty".
            (8, &has7, Some(&has7), CopiesToWrite::VaultAndMirror),
        ];
        let wrong: Vec<_> = cases.iter()
            .filter(|(uid, vault, mirror, want)| copies_to_write(*uid, vault, *mirror) != *want)
            .map(|(uid, vault, mirror, want)| {
                format!("uid {uid} vault {vault:?} mirror {mirror:?}: got {:?}, want {want:?}", copies_to_write(*uid, vault, *mirror))
            })
            .collect();
        assert!(wrong.is_empty(), "{wrong:#?}");
    }

    /// run_graph_backup's check before its listings: after each fetch, a
    /// rescan of `cur/` by `find_by_uid`, then of the mirror folder by
    /// `find_msg_file_by_uid`.
    fn copies_to_write_per_message(cur: &Path, mirror: Option<&Path>, uid: u32) -> CopiesToWrite {
        if find_by_uid(cur, uid).is_some() {
            return CopiesToWrite::Nothing;
        }
        match mirror {
            Some(dir) if per_uid_mirror_lookup(dir, uid).is_none() => CopiesToWrite::VaultAndMirror,
            _ => CopiesToWrite::Vault,
        }
    }

    #[test]
    fn copies_to_write_from_one_listing_per_side_agrees_with_the_per_message_rescans() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path().join("cur");
        let mirror = tmp.path().join("mirror");
        fs::create_dir_all(&cur).unwrap();
        fs::create_dir_all(&mirror).unwrap();
        // Where the vault's `<uid>:` rule and the mirror's split on ':', '.'
        // or '_' read a name differently, the sides disagree about the uid.
        for name in [
            "1:2,S.eml", "2:2,F.eml", "07:2,S.eml", "+8:2,.eml", "12.eml", "13_S.eml",
            "16:2,S.eml", "16:2,FS.eml", "18", ".4711:2,S.eml.tmp-1", "_meta.json",
        ] {
            fs::write(cur.join(name), b"x").unwrap();
        }
        fs::create_dir(cur.join("19:2,S.eml")).unwrap();
        for name in [
            "1.eml", "3:2,S.eml", "4.eml", "5_S.eml", "07.eml", "+8.eml", "13:2,S.eml",
            "16.eml", "4294967296.eml", "not-a-uid.eml", ".4711:2,S.eml.tmp-1", "_meta.json",
        ] {
            fs::write(mirror.join(name), b"x").unwrap();
        }
        fs::create_dir(mirror.join("20")).unwrap();

        // Listed the way run_graph_backup lists them, once per folder.
        let vault: HashSet<u32> = uid_file_map(&cur).into_keys().collect();
        let mirrored: HashSet<u32> = mirror_file_map(&mirror).into_keys().collect();

        for uid in (0..=21).chain([4711, u32::MAX]) {
            assert_eq!(
                copies_to_write(uid, &vault, Some(&mirrored)),
                copies_to_write_per_message(&cur, Some(&mirror), uid),
                "uid {uid}",
            );
            assert_eq!(
                copies_to_write(uid, &vault, None),
                copies_to_write_per_message(&cur, None, uid),
                "uid {uid} without a mirror",
            );
        }
    }

    #[test]
    fn a_listed_path_still_on_disk_is_used_as_is() {
        let tmp = tempfile::tempdir().unwrap();
        let listed = tmp.path().join("7:2,S.eml");
        fs::write(&listed, b"x").unwrap();
        assert_eq!(find_listed_by_uid(tmp.path(), 7, &listed), Some(listed));
    }

    #[test]
    fn a_file_renamed_after_the_listing_is_found_again() {
        // A flag change renames the file between the listing and the lookup.
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("70:2,S.eml"), b"other uid").unwrap();
        fs::write(tmp.path().join("7:2,FS.eml"), b"x").unwrap();
        assert_eq!(
            find_listed_by_uid(tmp.path(), 7, &tmp.path().join("7:2,S.eml")),
            Some(tmp.path().join("7:2,FS.eml")),
        );
    }

    #[test]
    fn a_file_deleted_after_the_listing_is_gone() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("70:2,S.eml"), b"other uid").unwrap();
        assert_eq!(find_listed_by_uid(tmp.path(), 7, &tmp.path().join("7:2,S.eml")), None);
    }

    /// A vault file, named the way build_maildir_filename names them.
    fn write_vault_msg(dir: &Path, name: &str, message_id: Option<&str>) {
        let head = match message_id {
            Some(id) => format!("Message-ID: {}\r\n", id),
            None => String::new(),
        };
        fs::write(dir.join(name), format!("{}Subject: {}\r\n\r\nbody\r\n", head, name)).unwrap();
    }

    #[test]
    fn a_file_whose_message_id_matches_is_verified() {
        let tmp = tempfile::tempdir().unwrap();
        write_vault_msg(tmp.path(), "12:2,S", Some("<a@host.test>"));

        let mut expected = HashMap::new();
        // The caller's angle brackets must not decide the answer.
        expected.insert(12u32, "a@host.test".to_string());

        let (verified, missing, mismatched) = verify_copies(tmp.path(), &[12], Some(&expected));
        assert_eq!(verified, vec![12]);
        assert!(missing.is_empty());
        assert!(mismatched.is_empty());
    }

    #[test]
    fn a_file_holding_another_message_is_never_verified() {
        // The uid is present, so the old presence-only check called this proof
        // and the caller deleted the server's only copy of a@host.test.
        let tmp = tempfile::tempdir().unwrap();
        write_vault_msg(tmp.path(), "12:2,S", Some("<somethingelse@host.test>"));

        let mut expected = HashMap::new();
        expected.insert(12u32, "<a@host.test>".to_string());

        let (verified, missing, mismatched) = verify_copies(tmp.path(), &[12], Some(&expected));
        assert!(verified.is_empty());
        assert!(missing.is_empty());
        assert_eq!(mismatched, vec![12]);
    }

    #[test]
    fn a_uid_with_no_file_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let (verified, missing, mismatched) = verify_copies(tmp.path(), &[12], None);
        assert!(verified.is_empty());
        assert_eq!(missing, vec![12]);
        assert!(mismatched.is_empty());
    }

    #[test]
    fn absence_of_proof_is_not_proof_of_a_swap() {
        // No expected id, and a file that carries none: presence alone verifies,
        // which is what every caller before this change relied on.
        let tmp = tempfile::tempdir().unwrap();
        write_vault_msg(tmp.path(), "12:2,S", Some("<a@host.test>"));
        write_vault_msg(tmp.path(), "13:2,S", None);

        let mut expected = HashMap::new();
        expected.insert(13u32, "<a@host.test>".to_string());

        let (verified, missing, mismatched) = verify_copies(tmp.path(), &[12, 13], Some(&expected));
        assert_eq!(verified, vec![12, 13]);
        assert!(missing.is_empty());
        assert!(mismatched.is_empty());
    }

    #[test]
    fn a_file_renamed_after_the_listing_is_still_checked_against_its_message_id() {
        let tmp = tempfile::tempdir().unwrap();
        write_vault_msg(tmp.path(), "12:2,FS", Some("<somethingelse@host.test>"));
        let listing = HashMap::from([(12u32, tmp.path().join("12:2,S"))]);
        let expected = HashMap::from([(12u32, "<a@host.test>".to_string())]);

        let (verified, missing, mismatched) = verify_listed(tmp.path(), &listing, &[12], Some(&expected));
        assert!(verified.is_empty(), "a stale listed path must not verify on presence alone");
        assert!(missing.is_empty());
        assert_eq!(mismatched, vec![12]);
    }

    #[test]
    fn a_file_deleted_after_the_listing_is_missing_not_verified() {
        let tmp = tempfile::tempdir().unwrap();
        let listing = HashMap::from([(12u32, tmp.path().join("12:2,S"))]);

        let (verified, missing, mismatched) = verify_listed(tmp.path(), &listing, &[12], None);
        assert!(verified.is_empty(), "the caller deletes the server copy of whatever verifies");
        assert_eq!(missing, vec![12]);
        assert!(mismatched.is_empty());
    }

    /// src-tauri's `verify_copies` before the one-pass listing: `find_by_uid`
    /// per uid.
    fn verify_copies_per_uid(
        cur_dir: &Path,
        uids: &[u32],
        expected_ids: Option<&HashMap<u32, String>>,
    ) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
        let (mut verified, mut missing, mut mismatched) = (Vec::new(), Vec::new(), Vec::new());
        for uid in uids {
            let Some(path) = find_by_uid(cur_dir, *uid) else {
                missing.push(*uid);
                continue;
            };
            let expected = expected_ids
                .and_then(|m| m.get(uid))
                .map(|id| normalize_message_id(id))
                .filter(|id| !id.is_empty());
            match (expected, read_message_id(&path)) {
                (Some(want), Some(got)) if want != got => mismatched.push(*uid),
                _ => verified.push(*uid),
            }
        }
        (verified, missing, mismatched)
    }

    #[test]
    fn verify_copies_agrees_with_the_per_uid_lookup() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        write_vault_msg(cur, "1:2,S.eml", Some("<one@host.test>"));
        write_vault_msg(cur, "10:2,.eml", Some("<ten@host.test>"));
        write_vault_msg(cur, "100:2,F.eml", Some("<swapped@host.test>"));
        write_vault_msg(cur, "11:2,S.eml", None);
        write_vault_msg(cur, "3:2,S.eml", Some("<three@host.test>"));
        write_vault_msg(cur, "3:2,FS.eml", Some("<three-dup@host.test>"));
        // Not vault rows for find_by_uid, so not for verify either.
        write_vault_msg(cur, "07:2,S.eml", Some("<seven@host.test>"));
        write_vault_msg(cur, "9.eml", Some("<nine@host.test>"));
        write_vault_msg(cur, "20_S.eml", Some("<twenty@host.test>"));

        let expected = HashMap::from([
            (1u32, "one@host.test".to_string()),
            (100, "<hundred@host.test>".to_string()),
            (11, "<eleven@host.test>".to_string()),
            (3, "<three@host.test>".to_string()),
            (7, "<seven@host.test>".to_string()),
            (10, "   ".to_string()),
        ]);
        let uids = [1u32, 10, 100, 11, 3, 7, 9, 20, 12, 1];

        for ids in [None, Some(&expected)] {
            assert_eq!(verify_copies(cur, &uids, ids), verify_copies_per_uid(cur, &uids, ids));
        }
    }

    /// Not a gate. `cargo test -p mailvault-core --release --lib bench_verify_copies -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn bench_verify_copies() {
        let tmp = tempfile::tempdir().unwrap();
        let cur = tmp.path();
        let n = 20_000u32;
        for uid in 1..=n {
            fs::write(cur.join(format!("{uid}:2,S.eml")), format!("Message-ID: <{uid}@host.test>\r\n\r\nx")).unwrap();
        }
        let uids: Vec<u32> = (1..=n).collect();
        let expected: HashMap<u32, String> = uids.iter().map(|u| (*u, format!("<{u}@host.test>"))).collect();

        let t = std::time::Instant::now();
        let (verified, _, _) = verify_copies(cur, &uids, Some(&expected));
        let one_pass = t.elapsed();

        let sample: Vec<u32> = uids.iter().step_by(100).copied().collect(); // 200 uids
        let t = std::time::Instant::now();
        let (slow_verified, _, _) = verify_copies_per_uid(cur, &sample, Some(&expected));
        let per_uid = t.elapsed() / sample.len() as u32;

        assert_eq!(verified.len(), n as usize);
        assert_eq!(slow_verified.len(), sample.len());
        println!("n={n} one_pass={one_pass:?} per_uid={per_uid:?} projected_old_total={:?}", per_uid * n);
    }
}
