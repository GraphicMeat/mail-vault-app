//! The desktop's tags in a phone bundle: every tag (name and color) and as many of its assignments
//! as the code has room for.
//!
//! An assignment travels as its `msg_key` (`app_db::identity`) under the account's address: the
//! phone's account ids are its own, and the address is how an import matches accounts. A key is
//! a Message-ID, or the desktop's mailbox-plus-uid fallback, which the phone can match only on an
//! IMAP account (the import drops it on the others).
//!
//! Wire shape (`tags` beside `accounts` and `settings`):
//! `{"list": [{"name", "color"}], "assigned": [{"email", "tag": <index in list>, "keys": [msg_key]}]}`.
//! Read leniently like the settings: a newer desktop that changes the shape loses the tags, never
//! the import. An older phone ignores the block (the bundle has no `deny_unknown_fields`); an older
//! desktop sends none.
//!
//! Room: the code is at most [`super::MAX_FRAMES`] frames. [`fit`] runs after the settings are fit
//! and gives the tags at most [`TAGS_BUDGET_BYTES`] deflated (and [`TAGS_PLAIN_BYTES`] inflated)
//! on top of the rest: the tags
//! themselves always (unless even they do not fit), then as many assignments as fit, the newest
//! of each tag and account in turn.
use super::{PhoneBundle, PhoneKind};
use crate::app_db::tags;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Deflated bytes the tags may add to the code: about twenty frames.
pub const TAGS_BUDGET_BYTES: usize = 20 * super::frames::CHUNK_BYTES;
/// Plain JSON bytes the tags may add: well under what the phone inflates
/// ([`super::MAX_PLAIN_BYTES`]), however well they deflate.
pub const TAGS_PLAIN_BYTES: usize = 256 * 1024;
/// Longest tag name carried (desktop's input takes 80).
const MAX_NAME_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneTag {
    pub name: String,
    /// `#rrggbb`, or empty for the neutral chip.
    #[serde(default)]
    pub color: String,
}

/// The messages of one account that carry one tag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneTagged {
    pub email: String,
    /// The tag's index in [`PhoneTags::list`].
    pub tag: u32,
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PhoneTags {
    #[serde(default)]
    pub list: Vec<PhoneTag>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assigned: Vec<PhoneTagged>,
}

impl PhoneTags {
    /// How many assignments the block carries.
    pub fn assignment_count(&self) -> usize {
        self.assigned.iter().map(|a| a.keys.len()).sum()
    }
}

/// One assignment before grouping, newest first.
struct Flat {
    email: String,
    tag: u32,
    key: String,
}

/// The desktop's tags as the phone takes them, for `accounts` (the desktop's account objects the
/// bundle is built from: `id` and `email`). Assignments of an account not in `accounts` are left
/// out. `None` when the desktop has no tags.
pub fn snapshot(conn: &Connection, accounts: &Value) -> Result<Option<PhoneTags>, String> {
    let all = tags::list(conn)?;
    if all.is_empty() {
        return Ok(None);
    }
    let email_of: HashMap<&str, &str> = accounts
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|a| Some((a.get("id")?.as_str()?, a.get("email")?.as_str()?.trim())))
        .filter(|(_, e)| !e.is_empty())
        .collect();
    let mut index: HashMap<String, u32> = HashMap::new();
    let mut list = Vec::with_capacity(all.len());
    for t in all {
        let name: String = t.name.trim().chars().take(MAX_NAME_CHARS).collect();
        if name.is_empty() {
            continue;
        }
        index.insert(t.id, list.len() as u32);
        list.push(PhoneTag { name, color: super::hex_color(&t.color).unwrap_or_default() });
    }
    let flat: Vec<Flat> = tags::assignments(conn)?
        .into_iter()
        .filter_map(|(tag_id, account_id, key)| {
            Some(Flat { email: email_of.get(account_id.as_str())?.to_string(), tag: *index.get(&tag_id)?, key })
        })
        .collect();
    Ok(Some(PhoneTags { list, assigned: group(&flat) }))
}

/// Groups the newest-first assignments by account and tag; each group keeps that order.
fn group(flat: &[Flat]) -> Vec<PhoneTagged> {
    let mut out: Vec<PhoneTagged> = Vec::new();
    let mut at: HashMap<(&str, u32), usize> = HashMap::new();
    for f in flat {
        let slot = *at.entry((f.email.as_str(), f.tag)).or_insert_with(|| {
            out.push(PhoneTagged { email: f.email.clone(), tag: f.tag, keys: Vec::new() });
            out.len() - 1
        });
        out[slot].keys.push(f.key.clone());
    }
    out
}

/// The assignments at `order` (group, key index), flattened in that order.
fn ungroup(tags: &PhoneTags, order: &[(usize, usize)]) -> Vec<Flat> {
    order
        .iter()
        .map(|&(g, k)| Flat { email: tags.assigned[g].email.clone(), tag: tags.assigned[g].tag, key: tags.assigned[g].keys[k].clone() })
        .collect()
}

/// Cuts `bundle.tags` to fit: within [`TAGS_BUDGET_BYTES`] deflated over the bundle without
/// them, and the whole code within [`super::MAX_FRAMES`]. Keeps every tag and as many
/// assignments as fit, the newest of each tag and account in turn; drops the block when not even the tags fit. Run after the settings were
/// fit. Returns how many assignments were left out.
pub fn fit(bundle: &mut PhoneBundle) -> usize {
    let Some(mut block) = bundle.tags.take() else { return 0 };
    let total = block.assignment_count();
    let Some((bare, bare_plain)) = super::settings::deflated_len(bundle) else { return total };
    let fits = |b: &PhoneBundle| {
        super::settings::deflated_len(b).is_some_and(|(d, p)| {
            let frames = (d + super::SEALED_OVERHEAD).div_ceil(super::frames::CHUNK_BYTES);
            d.saturating_sub(bare) <= TAGS_BUDGET_BYTES && p.saturating_sub(bare_plain) <= TAGS_PLAIN_BYTES && frames <= super::MAX_FRAMES
        })
    };
    // Each group's keys are newest first; the groups are taken in turn, so one busy tag or
    // account cannot crowd out the rest.
    let mut order: Vec<(usize, usize)> = Vec::with_capacity(total);
    {
        let mut next = vec![0usize; block.assigned.len()];
        let mut left = total;
        while left > 0 {
            for (g, group) in block.assigned.iter().enumerate() {
                if next[g] < group.keys.len() {
                    order.push((g, next[g]));
                    next[g] += 1;
                    left -= 1;
                }
            }
        }
    }
    let with = |keep: usize, block: &PhoneTags| PhoneTags { list: block.list.clone(), assigned: group(&ungroup(block, &order[..keep])) };
    bundle.tags = Some(with(total, &block));
    if fits(bundle) {
        return 0;
    }
    // The most assignments that fit, by bisection (each probe deflates the bundle once).
    let (mut lo, mut hi) = (0usize, total);
    bundle.tags = Some(with(0, &block));
    if !fits(bundle) {
        bundle.tags = None;
        return total;
    }
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        bundle.tags = Some(with(mid, &block));
        if fits(bundle) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    block = with(lo, &block);
    bundle.tags = Some(block);
    total - lo
}

/// The keys of `tagged` an account of `kind` can match: a desktop uid fallback means nothing on a
/// Graph or JMAP account, whose uids are the phone's own.
pub fn keys_for(kind: PhoneKind, tagged: &PhoneTagged) -> Vec<String> {
    tagged
        .keys
        .iter()
        .map(|k| k.trim())
        .filter(|k| !k.is_empty())
        .filter(|k| kind == PhoneKind::Imap || !crate::app_db::identity::is_uid_fallback(k))
        .map(str::to_string)
        .collect()
}
