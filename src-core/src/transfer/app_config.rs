//! The app.db configuration an account transfer carries: tags, custom fields,
//! saved views and auto-tag rules. `snapshot` reads it on the source machine;
//! `merge` folds it into the target's app.db, which may already hold its own.
//!
//! Rows match by natural key (name, or a starter's `builtin` id), the target's
//! row always wins, and every id the file's rows point at is remapped to the
//! target's id for the same thing.

use crate::app_db::{auto_tags, db::in_txn, fields, tags, views};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDef {
    pub id: String,
    pub name: String,
    pub color: String,
    pub position: i64,
}

/// `default` so a bundle missing one of the four lists still reads.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub tags: Vec<TagDef>,
    pub fields: Vec<fields::Field>,
    pub views: Vec<views::View>,
    pub auto_tag_rules: Vec<auto_tags::Rule>,
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    pub tags_added: usize,
    pub fields_added: usize,
    pub views_added: usize,
    pub rules_added: usize,
}

/// Everything the transfer carries, read in one transaction so the four lists
/// agree with each other.
pub fn snapshot(conn: &Connection) -> Result<AppConfig, String> {
    in_txn(conn, || {
        Ok(AppConfig {
            tags: tags::list(conn)?
                .into_iter()
                .map(|t| TagDef { id: t.id, name: t.name, color: t.color, position: t.position })
                .collect(),
            fields: fields::list_all(conn)?,
            views: views::list(conn)?,
            auto_tag_rules: auto_tags::list(conn)?,
        })
    })
}

/// Fold `cfg` into this app.db. `account_map` maps a file account id to the
/// target's id for the same account; an id absent from it is not on this
/// machine, and whatever is scoped to it only is left out.
pub fn merge(conn: &Connection, cfg: &AppConfig, account_map: &HashMap<String, String>) -> Result<MergeReport, String> {
    in_txn(conn, || {
        let mut report = MergeReport::default();

        // Tags: `ensure` matches case-insensitively and keeps an existing row
        // (and its color) untouched.
        let mut known: HashSet<String> = tags::list(conn)?.into_iter().map(|t| t.id).collect();
        let mut tag_map = HashMap::new();
        for tag in &cfg.tags {
            let got = tags::ensure(conn, &tag.name, &tag.color)?;
            if known.insert(got.id.clone()) {
                report.tags_added += 1;
            }
            tag_map.insert(tag.id.clone(), got.id);
        }

        // Fields. The match list grows as fields land: two file accounts can
        // map to one target account, and a second insert of the same name
        // would trip `fields::save`'s clash check and roll everything back.
        let mut target_fields = fields::list_all(conn)?;
        let mut field_map = HashMap::new();
        for field in &cfg.fields {
            let scope = if field.scope == fields::GLOBAL {
                fields::GLOBAL.to_string()
            } else {
                match account_map.get(&field.scope) {
                    Some(scope) => scope.clone(),
                    None => continue,
                }
            };
            if let Some(existing) = target_fields.iter().find(|f| f.scope == scope && same_name(&f.name, &field.name)) {
                field_map.insert(field.id.clone(), existing.id.clone());
                continue;
            }
            let saved =
                fields::save(conn, &fields::Field { id: uuid::Uuid::new_v4().to_string(), scope, ..field.clone() })?;
            field_map.insert(field.id.clone(), saved.id.clone());
            target_fields.push(saved);
            report.fields_added += 1;
        }

        // Views. The starters are seeded first, as `views.list` would: on a
        // target that never listed its views, a file starter would otherwise
        // land under a fresh id and the later seeding would add a second set.
        views::ensure_starters(conn)?;
        let mut target_views = views::list(conn)?;
        for view in &cfg.views {
            let taken = target_views.iter().any(|t| match &view.builtin {
                Some(b) => t.builtin.as_deref() == Some(b.as_str()),
                None => t.builtin.is_none() && same_name(&t.name, &view.name),
            });
            if taken {
                continue;
            }
            let Some(def) = remap_def(&view.def, account_map, &tag_map, &field_map) else { continue };
            // `views::save` puts a new id after every view already there.
            let saved = views::save(conn, &views::View { id: uuid::Uuid::new_v4().to_string(), def, ..view.clone() })?;
            target_views.push(saved);
            report.views_added += 1;
        }

        // Auto-tag rules: a rule whose tag did not come across is left out.
        let mut rule_names: Vec<String> = auto_tags::list(conn)?.into_iter().map(|r| r.name).collect();
        for rule in &cfg.auto_tag_rules {
            if rule_names.iter().any(|n| same_name(n, &rule.name)) {
                continue;
            }
            let Some(tag_id) = tag_map.get(&rule.tag_id) else { continue };
            let created = auto_tags::create(
                conn,
                auto_tags::RuleDraft {
                    name: rule.name.clone(),
                    instruction: rule.instruction.clone(),
                    constraints: rule.constraints.clone(),
                    tag_id: tag_id.clone(),
                    inbox_action: rule.inbox_action,
                    min_confidence: rule.min_confidence,
                    allow_remote: rule.allow_remote,
                    provider: rule.provider.clone(),
                    enabled: rule.enabled,
                },
            )?;
            rule_names.push(created.name);
            report.rules_added += 1;
        }

        Ok(report)
    })
}

/// SQLite's `COLLATE NOCASE` folds ASCII only; matching the same way keeps a
/// "no match" here from becoming a clash inside `fields::save`.
fn same_name(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// The view's definition in the target's ids, or `None` when it would match
/// more on the target than on the source: an account list that empties out
/// (empty means every account), or a tag or field filter that cannot map.
fn remap_def(
    def: &views::ViewDef,
    account_map: &HashMap<String, String>,
    tag_map: &HashMap<String, String>,
    field_map: &HashMap<String, String>,
) -> Option<views::ViewDef> {
    let accounts: Vec<String> = def.accounts.iter().filter_map(|a| account_map.get(a).cloned()).collect();
    if !def.accounts.is_empty() && accounts.is_empty() {
        return None;
    }
    // Only a literal `field:<id>` names a field; any other value passes through.
    let field_ref = |value: &str| -> Option<String> {
        match value.strip_prefix("field:") {
            Some(id) => field_map.get(id).map(|mapped| format!("field:{mapped}")),
            None => Some(value.to_string()),
        }
    };
    // A tag or field filter that cannot map would drop out and let the view
    // match more than it did on the source, so the whole view is skipped
    // (`?` on the collected `Option`). Group and columns only change display.
    let tags = def.tags.iter().map(|t| tag_map.get(t).cloned()).collect::<Option<Vec<_>>>()?;
    let filters = def
        .fields
        .iter()
        .map(|f| field_map.get(&f.field_id).map(|id| fields::FieldFilter { field_id: id.clone(), ..f.clone() }))
        .collect::<Option<Vec<_>>>()?;
    Some(views::ViewDef {
        accounts,
        tags,
        fields: filters,
        group: def.group.as_deref().and_then(field_ref),
        columns: def.columns.iter().filter_map(|c| field_ref(c)).collect(),
        ..def.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_db::auto_tags::{Constraints, InboxAction, RuleDraft};
    use crate::app_db::db;
    use crate::app_db::fields::{Field, FieldFilter, FieldOption, GLOBAL};
    use crate::app_db::views::{View, ViewDef};

    // The same migrated temp app.db every app_db module's tests open.
    fn conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("mv-transfer-cfg-{}", uuid::Uuid::new_v4()));
        db::open(&dir).expect("open")
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    fn field(scope: &str, name: &str) -> Field {
        Field {
            id: uuid::Uuid::new_v4().to_string(),
            scope: scope.into(),
            name: name.into(),
            kind: "select".into(),
            options: vec![FieldOption { id: "open".into(), label: "Open".into(), color: "#0a0".into() }],
            position: 0,
        }
    }

    fn user_view(name: &str, def: ViewDef) -> View {
        View { id: uuid::Uuid::new_v4().to_string(), name: name.into(), icon: "tag".into(), position: 0, builtin: None, def }
    }

    fn rule(name: &str, tag_id: &str) -> RuleDraft {
        RuleDraft {
            name: name.into(),
            instruction: "mail from work".into(),
            constraints: Constraints { from_domain: Some("work.example".into()), ..Constraints::default() },
            tag_id: tag_id.into(),
            inbox_action: InboxAction::Hide,
            min_confidence: 0.8,
            allow_remote: false,
            provider: serde_json::Value::Null,
            enabled: true,
        }
    }

    fn view_named(c: &Connection, name: &str) -> Option<View> {
        views::list(c).unwrap().into_iter().find(|v| v.name == name)
    }

    #[test]
    fn snapshot_then_merge_into_empty_db_roundtrips_names() {
        let src = conn();
        let work = tags::ensure(&src, "Work", "#00f").unwrap();
        let status = fields::save(&src, &field(GLOBAL, "Status")).unwrap();
        views::save(
            &src,
            &user_view(
                "Work mail",
                ViewDef {
                    accounts: vec!["A".into()],
                    tags: vec![work.id.clone()],
                    fields: vec![FieldFilter { field_id: status.id.clone(), op: "is".into(), value: "open".into() }],
                    group: Some(format!("field:{}", status.id)),
                    columns: vec!["date".into(), format!("field:{}", status.id), "field:nope".into()],
                    ..ViewDef::default()
                },
            ),
        )
        .unwrap();
        auto_tags::create(&src, rule("Work rule", &work.id)).unwrap();

        let cfg = snapshot(&src).unwrap();
        let dst = conn();
        let report = merge(&dst, &cfg, &map(&[("A", "A")])).unwrap();

        let dst_tags = tags::list(&dst).unwrap();
        assert_eq!(dst_tags.len(), 1);
        let dst_work = &dst_tags[0];
        assert_eq!(dst_work.name, "Work");
        assert_eq!(dst_work.color, "#00f");

        let dst_fields = fields::list_all(&dst).unwrap();
        assert_eq!(dst_fields.len(), 1);
        let dst_status = &dst_fields[0];
        assert_eq!((dst_status.scope.as_str(), dst_status.name.as_str()), (GLOBAL, "Status"));
        assert_eq!(dst_status.options, status.options, "options carried unchanged");

        let v = view_named(&dst, "Work mail").expect("view merged");
        assert_eq!(v.def.tags, vec![dst_work.id.clone()]);
        assert_eq!(v.def.accounts, vec!["A".to_string()]);
        assert_eq!(v.def.fields.len(), 1);
        assert_eq!(v.def.fields[0].field_id, dst_status.id);
        assert_eq!(v.def.group, Some(format!("field:{}", dst_status.id)));
        assert_eq!(v.def.columns, vec!["date".to_string(), format!("field:{}", dst_status.id)], "unknown field column dropped");

        let rules = auto_tags::list(&dst).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].name, "Work rule");
        assert_eq!(rules[0].tag_id, dst_work.id);
        assert_eq!(rules[0].constraints.from_domain.as_deref(), Some("work.example"));
        assert_eq!(rules[0].inbox_action, InboxAction::Hide);

        assert_eq!(report, MergeReport { tags_added: 1, fields_added: 1, views_added: 1, rules_added: 1 });
    }

    #[test]
    fn existing_target_rows_win_and_ids_are_remapped() {
        let dst = conn();
        let t1 = tags::ensure(&dst, "work", "red").unwrap();

        let src = conn();
        let f1 = tags::ensure(&src, "Work", "blue").unwrap();
        views::save(&src, &user_view("Work mail", ViewDef { tags: vec![f1.id.clone()], ..ViewDef::default() })).unwrap();
        let cfg = snapshot(&src).unwrap();

        let report = merge(&dst, &cfg, &HashMap::new()).unwrap();

        let dst_tags = tags::list(&dst).unwrap();
        assert_eq!(dst_tags.len(), 1, "one tag, not two");
        assert_eq!(dst_tags[0].id, t1.id);
        assert_eq!(dst_tags[0].color, "red", "the target's color wins");
        assert_eq!(view_named(&dst, "Work mail").expect("view merged").def.tags, vec![t1.id]);
        assert_eq!(report.tags_added, 0);
    }

    #[test]
    fn duplicate_account_ids_remap_and_unknown_accounts_drop_the_view() {
        let src = conn();
        fields::save(&src, &field("X", "Priority")).unwrap();
        fields::save(&src, &field("GONE", "Chore")).unwrap();
        views::save(&src, &user_view("On X", ViewDef { accounts: vec!["X".into()], ..ViewDef::default() })).unwrap();
        views::save(&src, &user_view("On GONE", ViewDef { accounts: vec!["GONE".into()], ..ViewDef::default() })).unwrap();
        let cfg = snapshot(&src).unwrap();

        let dst = conn();
        let report = merge(&dst, &cfg, &map(&[("X", "Y")])).unwrap();

        assert_eq!(view_named(&dst, "On X").expect("view1 merged").def.accounts, vec!["Y".to_string()]);
        assert!(view_named(&dst, "On GONE").is_none(), "not widened to every account");
        let dst_fields = fields::list_all(&dst).unwrap();
        assert_eq!(dst_fields.len(), 1, "{dst_fields:?}");
        assert_eq!((dst_fields[0].scope.as_str(), dst_fields[0].name.as_str()), ("Y", "Priority"));
        assert_eq!((report.fields_added, report.views_added), (1, 1));
    }

    #[test]
    fn builtin_views_are_not_duplicated() {
        let src = conn();
        views::ensure_starters(&src).unwrap();
        let dst = conn();
        views::ensure_starters(&dst).unwrap();

        let report = merge(&dst, &snapshot(&src).unwrap(), &HashMap::new()).unwrap();

        assert_eq!(report.views_added, 0);
        assert_eq!(views::list(&dst).unwrap().len(), 3);
    }

    /// The daemon seeds starters lazily, on the first `views.list`. A target
    /// that never listed its views must not take the file's starters under
    /// fresh ids and then get a second set seeded on top.
    #[test]
    fn an_unseeded_target_gets_its_own_starters_not_copies() {
        let src = conn();
        views::ensure_starters(&src).unwrap();
        let dst = conn();

        let report = merge(&dst, &snapshot(&src).unwrap(), &HashMap::new()).unwrap();

        assert_eq!(report.views_added, 0);
        let all = views::list(&dst).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|v| v.id.starts_with("builtin-")), "{all:?}");
        assert_eq!(views::ensure_starters(&dst).unwrap(), 0, "a later list seeds nothing more");
    }

    #[test]
    fn a_view_whose_tag_or_field_filter_cannot_map_is_skipped_not_widened() {
        let src = conn();
        let cfg = AppConfig {
            views: vec![
                user_view("Unknown tag", ViewDef { tags: vec!["no-such-tag".into()], ..ViewDef::default() }),
                user_view(
                    "Unknown field",
                    ViewDef {
                        fields: vec![FieldFilter { field_id: "no-such-field".into(), op: "isSet".into(), value: serde_json::Value::Null }],
                        ..ViewDef::default()
                    },
                ),
                user_view("Display only", ViewDef { group: Some("field:gone".into()), columns: vec!["field:gone".into(), "date".into()], ..ViewDef::default() }),
            ],
            ..snapshot(&src).unwrap()
        };
        let dst = conn();
        let report = merge(&dst, &cfg, &HashMap::new()).unwrap();
        assert!(view_named(&dst, "Unknown tag").is_none(), "would match every message");
        assert!(view_named(&dst, "Unknown field").is_none(), "would match every message");
        let shown = view_named(&dst, "Display only").expect("display-only refs just drop");
        assert_eq!(shown.def.group, None);
        assert_eq!(shown.def.columns, vec!["date".to_string()]);
        assert_eq!(report.views_added, 1);
    }

    #[test]
    fn an_existing_target_field_wins_and_the_view_points_at_it() {
        let dst = conn();
        let target = fields::save(&dst, &field(GLOBAL, "status")).unwrap();

        let src = conn();
        let file = fields::save(&src, &field(GLOBAL, "Status")).unwrap();
        assert_ne!(file.id, target.id);
        views::save(
            &src,
            &user_view(
                "By status",
                ViewDef {
                    fields: vec![FieldFilter { field_id: file.id.clone(), op: "isSet".into(), value: serde_json::Value::Null }],
                    group: Some(format!("field:{}", file.id)),
                    columns: vec![format!("field:{}", file.id)],
                    ..ViewDef::default()
                },
            ),
        )
        .unwrap();

        let report = merge(&dst, &snapshot(&src).unwrap(), &HashMap::new()).unwrap();

        let v = view_named(&dst, "By status").expect("view merged");
        assert_eq!(v.def.fields[0].field_id, target.id);
        assert_eq!(v.def.group, Some(format!("field:{}", target.id)));
        assert_eq!(v.def.columns, vec![format!("field:{}", target.id)]);
        assert_eq!(report.fields_added, 0);
        assert_eq!(fields::list_all(&dst).unwrap().len(), 1);
    }

    #[test]
    fn two_file_accounts_collapsing_onto_one_target_account_add_one_field() {
        let src = conn();
        fields::save(&src, &field("X", "Priority")).unwrap();
        fields::save(&src, &field("Z", "Priority")).unwrap();
        let dst = conn();

        let report = merge(&dst, &snapshot(&src).unwrap(), &map(&[("X", "Y"), ("Z", "Y")])).expect("no clash rollback");

        assert_eq!(report.fields_added, 1);
        let all = fields::list_all(&dst).unwrap();
        assert_eq!((all.len(), all[0].scope.as_str()), (1, "Y"));
    }

    #[test]
    fn a_rule_already_on_the_target_or_without_its_tag_is_skipped() {
        let dst = conn();
        let dst_tag = tags::ensure(&dst, "Mine", "").unwrap();
        auto_tags::create(&dst, rule("work rule", &dst_tag.id)).unwrap();

        let src = conn();
        let work = tags::ensure(&src, "Work", "").unwrap();
        auto_tags::create(&src, rule("Work rule", &work.id)).unwrap();
        auto_tags::create(&src, rule("Orphan rule", &work.id)).unwrap();
        let mut cfg = snapshot(&src).unwrap();
        cfg.auto_tag_rules.iter_mut().find(|r| r.name == "Orphan rule").unwrap().tag_id = "no-such-tag".into();

        let report = merge(&dst, &cfg, &HashMap::new()).unwrap();

        assert_eq!(report.rules_added, 0);
        let names: Vec<String> = auto_tags::list(&dst).unwrap().into_iter().map(|r| r.name).collect();
        assert_eq!(names, vec!["work rule".to_string()], "the target's rule stays, nothing added");
    }

    #[test]
    fn a_bundle_missing_a_list_still_reads() {
        let cfg: AppConfig = serde_json::from_str(r#"{"tags":[]}"#).unwrap();
        assert!(cfg.fields.is_empty() && cfg.views.is_empty() && cfg.auto_tag_rules.is_empty());
    }
}
