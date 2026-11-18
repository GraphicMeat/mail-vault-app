//! The desktop's custom fields in a phone bundle: every field definition of the accounts the code
//! carries (and every shared one), and as many of their values as the code has room for.
//!
//! A field travels with its desktop id (a saved view's field condition names it) and, for an
//! account's own field, the account's address instead of its id: the phone's account ids are its
//! own, and the address is how an import matches accounts. A value travels as `(msg_key, value)`
//! under the account's address, like a tag assignment (`tags.rs`; a desktop uid key matches only
//! on an IMAP account).
//!
//! Wire shape (`fields` beside `tags`):
//! `{"list": [{"id", "email"?, "name", "kind", "options": [{"id", "label", "color"}]}],
//!   "values": [{"email", "field": <index in list>, "values": [[msg_key, value]]}]}`.
//! `email` absent is a field every account shares. Read leniently like the tags: a block of
//! another shape loses the fields, never the import; an older phone ignores it; an older desktop
//! sends none.
//!
//! Room: [`fit`] runs after the tags are fit and gives the fields at most [`FIELDS_BUDGET_BYTES`]
//! deflated (and [`FIELDS_PLAIN_BYTES`] inflated): the definitions always (unless even they do not
//! fit), then as many values as fit, the newest of each field and account in turn.
use super::PhoneBundle;
use crate::app_db::fields::{self, FieldOption, GLOBAL};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Deflated bytes the fields may add to the code: about ten frames.
pub const FIELDS_BUDGET_BYTES: usize = 10 * super::frames::CHUNK_BYTES;
/// Plain JSON bytes the fields may add.
pub const FIELDS_PLAIN_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneField {
    pub id: String,
    /// The account's address; absent for a field every account shares.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub options: Vec<FieldOption>,
}

/// The values one account gave one field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneFieldValues {
    pub email: String,
    /// The field's index in [`PhoneFields::list`].
    pub field: u32,
    pub values: Vec<(String, Value)>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PhoneFields {
    #[serde(default)]
    pub list: Vec<PhoneField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<PhoneFieldValues>,
}

impl PhoneFields {
    /// How many values the block carries.
    pub fn value_count(&self) -> usize {
        self.values.iter().map(|v| v.values.len()).sum()
    }

    /// Keeps only what an account of `carried` (lowercased addresses) can use: the shared fields,
    /// those accounts' own, and their values.
    pub fn retain_accounts(&mut self, carried: &std::collections::HashSet<String>) {
        let ours = |email: &str| carried.contains(&email.trim().to_lowercase());
        let mut moved: HashMap<u32, u32> = HashMap::new();
        let mut list = Vec::with_capacity(self.list.len());
        for (i, f) in std::mem::take(&mut self.list).into_iter().enumerate() {
            if f.email.as_deref().is_none_or(ours) {
                moved.insert(i as u32, list.len() as u32);
                list.push(f);
            }
        }
        self.list = list;
        self.values.retain_mut(|v| match moved.get(&v.field) {
            Some(&to) if ours(&v.email) => {
                v.field = to;
                true
            }
            _ => false,
        });
    }
}

/// The desktop account id -> address map of `accounts` (the desktop's account objects).
pub(super) fn emails_of(accounts: &Value) -> HashMap<&str, &str> {
    accounts
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|a| Some((a.get("id")?.as_str()?, a.get("email")?.as_str()?.trim())))
        .filter(|(_, e)| !e.is_empty())
        .collect()
}

/// The desktop's fields as the phone takes them, for `accounts` (`id` and `email`): the shared
/// ones and those of an account in `accounts`, with their values from those accounts. `None` when
/// there is no such field.
pub fn snapshot(conn: &Connection, accounts: &Value) -> Result<Option<PhoneFields>, String> {
    let email_of = emails_of(accounts);
    let mut index: HashMap<String, u32> = HashMap::new();
    let mut list = Vec::new();
    for f in fields::list_all(conn)? {
        let email = if f.scope == GLOBAL {
            None
        } else {
            match email_of.get(f.scope.as_str()) {
                Some(e) => Some(e.to_string()),
                None => continue,
            }
        };
        index.insert(f.id.clone(), list.len() as u32);
        list.push(PhoneField { id: f.id, email, name: f.name, kind: f.kind, options: f.options });
    }
    if list.is_empty() {
        return Ok(None);
    }
    let mut values: Vec<PhoneFieldValues> = Vec::new();
    let mut at: HashMap<(String, u32), usize> = HashMap::new();
    for (field_id, account_id, key, value) in fields::all_values(conn)? {
        let (Some(email), Some(&field)) = (email_of.get(account_id.as_str()), index.get(&field_id)) else { continue };
        let slot = *at.entry((email.to_string(), field)).or_insert_with(|| {
            values.push(PhoneFieldValues { email: email.to_string(), field, values: Vec::new() });
            values.len() - 1
        });
        values[slot].values.push((key, value));
    }
    Ok(Some(PhoneFields { list, values }))
}

/// The most of `total` items `set` can put into `bundle` while the block stays within `budget`
/// deflated and `plain` inflated over the bundle without it, and the whole code within
/// [`super::MAX_FRAMES`]; `set(bundle, None)` takes the block out, `set(bundle, Some(n))` puts it
/// in with `n` items. Leaves the bundle with that many, or without the block (`None`) when not
/// even none fit.
pub(super) fn most_that_fit(bundle: &mut PhoneBundle, total: usize, budget: usize, plain: usize, set: &dyn Fn(&mut PhoneBundle, Option<usize>)) -> Option<usize> {
    set(bundle, None);
    let (bare, bare_plain) = super::settings::deflated_len(bundle)?;
    let fits = |b: &PhoneBundle| {
        super::settings::deflated_len(b).is_some_and(|(d, p)| {
            let frames = (d + super::SEALED_OVERHEAD).div_ceil(super::frames::CHUNK_BYTES);
            d.saturating_sub(bare) <= budget && p.saturating_sub(bare_plain) <= plain && frames <= super::MAX_FRAMES
        })
    };
    set(bundle, Some(total));
    if fits(bundle) {
        return Some(total);
    }
    set(bundle, Some(0));
    if !fits(bundle) {
        set(bundle, None);
        return None;
    }
    // Bisection: each probe deflates the bundle once.
    let (mut lo, mut hi) = (0usize, total);
    while lo < hi {
        let mid = lo + (hi - lo).div_ceil(2);
        set(bundle, Some(mid));
        if fits(bundle) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    set(bundle, Some(lo));
    Some(lo)
}

/// Cuts `bundle.fields` to fit (see the module doc). Run after the tags were fit. Returns how
/// many values were left out.
pub fn fit(bundle: &mut PhoneBundle) -> usize {
    let Some(block) = bundle.fields.take() else { return 0 };
    let total = block.value_count();
    // Each group's values are newest first; the groups are taken in turn.
    let mut order: Vec<(usize, usize)> = Vec::with_capacity(total);
    let mut next = vec![0usize; block.values.len()];
    while order.len() < total {
        for (g, group) in block.values.iter().enumerate() {
            if next[g] < group.values.len() {
                order.push((g, next[g]));
                next[g] += 1;
            }
        }
    }
    let with = |keep: usize| {
        let mut kept: Vec<PhoneFieldValues> = Vec::new();
        let mut at: HashMap<usize, usize> = HashMap::new();
        for &(g, i) in &order[..keep] {
            let slot = *at.entry(g).or_insert_with(|| {
                kept.push(PhoneFieldValues { email: block.values[g].email.clone(), field: block.values[g].field, values: Vec::new() });
                kept.len() - 1
            });
            kept[slot].values.push(block.values[g].values[i].clone());
        }
        PhoneFields { list: block.list.clone(), values: kept }
    };
    let kept = most_that_fit(bundle, total, FIELDS_BUDGET_BYTES, FIELDS_PLAIN_BYTES, &|b, n| b.fields = n.map(&with));
    total - kept.unwrap_or(0)
}
