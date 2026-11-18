//! The desktop's saved views in a phone bundle: every view whose references the phone can follow.
//!
//! A view's definition names desktop account ids, tag ids and field ids. On the way it names its
//! accounts by address and its tags by name instead (the phone's ids are its own; an import maps
//! them back); its field conditions keep the desktop's field ids, which the fields block carries
//! (`fields.rs`). A view naming an account, a tag or a field the code does not carry is left out
//! whole: dropping the condition instead would widen the view into something it never was.
//!
//! Wire shape (`views` beside `fields`): `{"list": [{"id", "name", "icon", "builtin", "def"}],
//! "seeded": bool}`, `def` desktop's `ViewDef` with `accounts` as addresses and `tags` as names.
//! `seeded`: the desktop's starters were seeded, so its list is the whole truth (a starter it
//! deleted stays deleted on the phone too). Read leniently like the tags.
//!
//! Room: [`fit`] runs last and gives the views at most [`VIEWS_BUDGET_BYTES`] deflated: as many
//! views as fit, in the desktop's order.
use super::PhoneBundle;
use crate::app_db::views::{self, ViewDef};
use crate::app_db::{fields, tags};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// Deflated bytes the views may add to the code: about four frames.
pub const VIEWS_BUDGET_BYTES: usize = 4 * super::frames::CHUNK_BYTES;
/// Plain JSON bytes the views may add.
pub const VIEWS_PLAIN_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PhoneView {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub builtin: Option<String>,
    /// `accounts` are addresses, `tags` are names.
    #[serde(default)]
    pub def: ViewDef,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PhoneViews {
    #[serde(default)]
    pub list: Vec<PhoneView>,
    #[serde(default)]
    pub seeded: bool,
}

/// The desktop's views as the phone takes them, for `accounts` (`id` and `email`): those whose
/// accounts are all in `accounts` and whose tags and fields exist. `None` when the desktop never
/// listed its views (no starters seeded, none made).
pub fn snapshot(conn: &Connection, accounts: &Value) -> Result<Option<PhoneViews>, String> {
    let all = views::list(conn)?;
    let seeded = views::seeded(conn);
    if all.is_empty() && !seeded {
        return Ok(None);
    }
    let email_of = super::fields::emails_of(accounts);
    let tag_name: HashMap<String, String> = tags::list(conn)?.into_iter().map(|t| (t.id, t.name.trim().to_string())).collect();
    let field_ids: HashSet<String> = fields::list_all(conn)?.into_iter().map(|f| f.id).collect();
    let mut list = Vec::with_capacity(all.len());
    'views: for v in all {
        let mut def = v.def;
        let mut emails = Vec::with_capacity(def.accounts.len());
        for id in &def.accounts {
            match email_of.get(id.as_str()) {
                Some(e) => emails.push(e.to_string()),
                None => continue 'views,
            }
        }
        let mut names = Vec::with_capacity(def.tags.len());
        for id in &def.tags {
            match tag_name.get(id).filter(|n| !n.is_empty()) {
                Some(n) => names.push(n.clone()),
                None => continue 'views,
            }
        }
        if def.fields.iter().any(|f| !field_ids.contains(&f.field_id)) {
            continue;
        }
        def.accounts = emails;
        def.tags = names;
        list.push(PhoneView { id: v.id, name: v.name, icon: v.icon, builtin: v.builtin, def });
    }
    Ok(Some(PhoneViews { list, seeded }))
}

/// Keeps only the views every account of which `carried` (lowercased addresses) holds.
pub fn retain_accounts(block: &mut PhoneViews, carried: &HashSet<String>) {
    block.list.retain(|v| v.def.accounts.iter().all(|e| carried.contains(&e.trim().to_lowercase())));
}

/// Cuts `bundle.views` to fit (see the module doc). Run after the fields were fit. Returns how
/// many views were left out.
pub fn fit(bundle: &mut PhoneBundle) -> usize {
    let Some(block) = bundle.views.take() else { return 0 };
    let total = block.list.len();
    let with = |keep: usize| PhoneViews { list: block.list[..keep].to_vec(), seeded: block.seeded };
    let kept = super::fields::most_that_fit(bundle, total, VIEWS_BUDGET_BYTES, VIEWS_PLAIN_BYTES, &|b, n| b.views = n.map(&with));
    total - kept.unwrap_or(0)
}
