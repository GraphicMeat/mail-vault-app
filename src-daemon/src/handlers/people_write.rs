//! `people.*` write-side RPCs. Same shape as `people.rs`.
use super::common::done;
use super::people::{blocking_db as db_blocking, db, opt_str, str_param, strings};
use crate::ipc::RpcResponse;
use crate::server::DaemonState;
use mailvault_core::people::{journal, merge, review, store, vcard};
use serde_json::{json, Value};
use std::sync::Arc;

const EXPORT_PAGE: usize = 200;

pub(crate) async fn import_chunked(state: &Arc<DaemonState>, text: String) -> Result<Value, String> {
    let cards = tokio::task::spawn_blocking(move || vcard::VCard::parse_all(&text))
        .await
        .map_err(|e| format!("task join error: {e}"))?;
    let grp = mailvault_core::people::model::new_id();
    let mut total = vcard::ImportReport::default();
    for chunk in cards.chunks(vcard::IMPORT_CHUNK) {
        let (chunk, grp) = (chunk.to_vec(), grp.clone());
        let r = db_blocking(state, move |c| vcard::import_cards(c, &chunk, &grp)).await?;
        total.created += r.created;
        total.linked += r.linked;
        total.skipped += r.skipped;
        crate::search_index::wait_foreground_quiet(&state.search_index).await;
    }
    serde_json::to_value(total).map_err(|e| e.to_string())
}

/// One vCard text for `ids` (every person when `None`), built a page of people
/// per custody call with a quiet-UI wait between pages, so a big book never
/// holds the lock for long. Calls `on_page(done, total)` after each page.
pub(crate) async fn export_text(state: &Arc<DaemonState>, ids: Option<Vec<String>>, mut on_page: impl FnMut(usize, usize)) -> Result<String, String> {
    let ids = match ids {
        Some(i) => i,
        None => db_blocking(state, store::all_ids).await?,
    };
    let (mut text, mut done) = (String::new(), 0usize);
    for page in ids.chunks(EXPORT_PAGE) {
        let page = page.to_vec();
        done += page.len();
        text.push_str(&db_blocking(state, move |c| vcard::export(c, Some(page.as_slice()))).await?);
        on_page(done, ids.len());
        if done < ids.len() {
            crate::search_index::wait_foreground_quiet(&state.search_index).await;
        }
    }
    Ok(text)
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, p: &Value, id: Value) -> Option<RpcResponse> {
    let res: Result<Value, String> = match method {
        "people.create" => {
            let np = store::NewPerson {
                display_name: opt_str(p, "displayName").unwrap_or_default(),
                emails: strings(p, "emails"),
                phones: strings(p, "phones"),
                org: opt_str(p, "org").unwrap_or_default(),
                notes: opt_str(p, "notes").unwrap_or_default(),
                ..Default::default()
            };
            db(state, move |c| {
                if np.display_name.trim().is_empty() && np.emails.is_empty() && np.phones.is_empty() {
                    return Err("E_INVALID: a contact needs a name, an email address or a phone number".to_string());
                }
                let id = store::create_person(c, &np)?;
                store::get_card(c, &id)?.ok_or_else(|| "E_NOT_FOUND: person".to_string())
            })
            .await
        }
        "people.update" => match (str_param(p, "id"), p.get("patch").and_then(|v| serde_json::from_value::<store::Patch>(v.clone()).ok())) {
            (Ok(pid), Some(patch)) => {
                db(state, move |c| {
                    store::update_person(c, &pid, &patch)?;
                    store::get_card(c, &pid)?.ok_or_else(|| "E_NOT_FOUND: person".to_string())
                })
                .await
            }
            (Err(e), _) => Err(e),
            (_, None) => Err("E_INVALID: missing patch".into()),
        },
        "people.delete" => match str_param(p, "id") {
            Ok(pid) => {
                db(state, move |c| {
                    store::delete_person(c, &pid)?;
                    Ok(json!({"ok": true}))
                })
                .await
            }
            Err(e) => Err(e),
        },
        "people.merge" => match str_param(p, "keepId") {
            Ok(keep) => {
                let ids = strings(p, "ids");
                db(state, move |c| merge::merge(c, &ids, &keep)).await
            }
            Err(e) => Err(e),
        },
        "people.split" => match str_param(p, "id") {
            Ok(pid) => {
                let recs = strings(p, "recordIds");
                db(state, move |c| Ok(json!({"newId": merge::split(c, &pid, &recs)?}))).await
            }
            Err(e) => Err(e),
        },
        "people.undo" => db(state, |c| journal::undo_last(c)).await,
        "people.review.accept" => {
            let items: Vec<(String, String)> = p
                .get("items")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|v| {
                            (
                                v.get("address").and_then(Value::as_str).unwrap_or("").to_string(),
                                v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            db(state, move |c| {
                let mut ids = Vec::new();
                for (a, n) in &items {
                    ids.push(review::accept(c, a, n)?);
                }
                Ok(json!({"ids": ids}))
            })
            .await
        }
        "people.review.dismiss" => {
            let a = strings(p, "addresses");
            db(state, move |c| {
                review::dismiss(c, &a)?;
                Ok(json!({"ok": true}))
            })
            .await
        }
        "people.import_vcf" => match str_param(p, "text") {
            // parse outside any lock, then one custody call per chunk of cards, all in one undo group
            Ok(text) => import_chunked(state, text).await,
            Err(e) => Err(e),
        },
        "people.export_vcf" => {
            let (job_id, dest) = match (str_param(p, "jobId"), str_param(p, "destDir")) {
                (Ok(j), Ok(d)) => (j, d),
                (Err(e), _) | (_, Err(e)) => return Some(done(id, Err(e))),
            };
            let ids = p.get("ids").map(|_| strings(p, "ids"));
            let mut job = super::vault_files::ExportJob::new(state, job_id.clone(), 1);
            let state = Arc::clone(state);
            tokio::spawn(async move {
                let text = match export_text(&state, ids, |done, total| job.step(done, total, None)).await {
                    Ok(t) => t,
                    Err(_) => return job.finish(Err("contacts.exportFailed".into())),
                };
                // the file is written off the custody lock, via a .part then a rename
                let result = tokio::task::spawn_blocking(move || {
                    let dir = std::path::Path::new(&dest);
                    let (part, target) = (dir.join("contacts.vcf.part"), dir.join("contacts.vcf"));
                    let count = text.lines().filter(|l| *l == "BEGIN:VCARD").count();
                    let written = std::fs::write(&part, text).and_then(|_| std::fs::rename(&part, &target));
                    if written.is_err() {
                        let _ = std::fs::remove_file(&part);
                    }
                    written.map_err(|_| "contacts.exportFailed".to_string())?;
                    Ok(json!({"file": "contacts.vcf", "count": count}))
                })
                .await
                .unwrap_or_else(|_| Err("contacts.exportFailed".to_string()));
                if result.is_ok() {
                    job.step(1, 1, Some("contacts.vcf"));
                }
                job.finish(result);
            });
            return Some(done(id, Ok(json!({"jobId": job_id}))));
        }
        _ => return None,
    };
    if res.is_ok() {
        crate::people_snapshot::note_change();
    }
    Some(done(id, res))
}

#[cfg(test)]
mod tests {
    use crate::server::{handle_request_for_test, DaemonState};
    use serde_json::{json, Value};
    use std::sync::Arc;

    async fn call(s: &Arc<DaemonState>, m: &str, p: Value) -> Value {
        serde_json::to_value(handle_request_for_test(s, m, p).await).unwrap()
    }
    fn state() -> (tempfile::TempDir, Arc<DaemonState>) {
        let d = tempfile::tempdir().unwrap();
        let s = DaemonState::for_test(d.path().to_path_buf(), d.path().to_path_buf(), true);
        (d, s)
    }

    #[tokio::test]
    async fn create_edit_merge_undo_round_trip_over_rpc() {
        let (_d, s) = state();
        let a = call(&s, "people.create", json!({"displayName": "Al", "emails": ["a@x.io"]})).await["result"]["id"].as_str().unwrap().to_string();
        let b = call(&s, "people.create", json!({"displayName": "Bo", "emails": ["b@x.io"]})).await["result"]["id"].as_str().unwrap().to_string();
        let upd = call(&s, "people.update", json!({"id": a, "patch": {"vip": true}})).await;
        assert_eq!(upd["result"]["vip"], true);
        let m = call(&s, "people.merge", json!({"ids": [a, b], "keepId": a})).await;
        assert_eq!(m["result"]["emails"].as_array().unwrap().len(), 2);
        let u = call(&s, "people.undo", json!({})).await;
        assert_eq!(u["result"]["op"], "merge");
        let list = call(&s, "people.list", json!({})).await;
        assert_eq!(list["result"]["total"], 2);
    }

    #[tokio::test]
    async fn bad_input_is_an_error_not_a_panic() {
        let (_d, s) = state();
        for (m, p) in [
            ("people.update", json!({})),
            ("people.merge", json!({"ids": ["x"], "keepId": "x"})),
            ("people.delete", json!({"id": "nope"})),
            ("people.review.accept", json!({"items": [{"address": "not an address"}]})),
        ] {
            let v = call(&s, m, p).await;
            assert!(v.get("error").is_some(), "{m}: {v}");
        }
    }

    #[tokio::test]
    async fn import_reports_what_it_did_and_one_undo_reverses_the_whole_import() {
        let (_d, s) = state();
        let mut text = String::new();
        for i in 0..450 {
            text.push_str(&format!("BEGIN:VCARD\nFN:P{i}\nEMAIL:p{i}@x.io\nEND:VCARD\n"));
        }
        let r = call(&s, "people.import_vcf", json!({"text": text})).await;
        assert_eq!(r["result"]["created"], 450);
        assert_eq!(call(&s, "people.list", json!({})).await["result"]["total"], 450);
        let u = call(&s, "people.undo", json!({})).await;
        assert_eq!(u["result"]["op"], "import");
        assert_eq!(call(&s, "people.list", json!({})).await["result"]["total"], 0);
        assert!(call(&s, "people.undo", json!({})).await["result"].is_null(), "nothing left to undo");
    }

    #[tokio::test]
    async fn export_vcf_writes_the_folder_and_ends_with_a_final_frame() {
        let (_d, s) = state();
        for (n, e) in [("Al", "a@x.io"), ("Bo", "b@x.io")] {
            call(&s, "people.create", json!({"displayName": n, "emails": [e], "notes": "n"})).await;
        }
        let dest = tempfile::tempdir().unwrap();
        let mut rx = s.events.subscribe();
        let r = call(&s, "people.export_vcf", json!({"jobId": "j1", "destDir": dest.path().to_string_lossy()})).await;
        assert_eq!(r["result"]["jobId"], "j1");
        let (_, frame) = crate::handlers::vault_files::finished_export(&mut rx, "j1").await;
        assert!(frame.get("error").is_none(), "{frame}");
        assert_eq!(frame["result"]["count"], 2);
        let text = std::fs::read_to_string(dest.path().join("contacts.vcf")).unwrap();
        assert!(text.contains("FN:Al") && text.contains("FN:Bo") && text.contains("NOTE:n"));
        assert!(!dest.path().join("contacts.vcf.part").exists());
    }

    #[tokio::test]
    async fn export_vcf_into_a_missing_folder_fails_with_a_catalog_key_and_still_sends_the_final_frame() {
        let (_d, s) = state();
        let mut rx = s.events.subscribe();
        call(&s, "people.export_vcf", json!({"jobId": "j2", "destDir": "/nonexistent/definitely/not/here"})).await;
        let (_, frame) = crate::handlers::vault_files::finished_export(&mut rx, "j2").await;
        assert_eq!(frame["error"], "contacts.exportFailed");
    }

    #[tokio::test]
    async fn export_vcf_pages_a_big_book_and_loses_nobody() {
        let (_d, s) = state();
        let mut text = String::new();
        for i in 0..450 {
            text.push_str(&format!("BEGIN:VCARD\nFN:P{i}\nEMAIL:p{i}@x.io\nEND:VCARD\n"));
        }
        call(&s, "people.import_vcf", json!({"text": text})).await;
        let dest = tempfile::tempdir().unwrap();
        let mut rx = s.events.subscribe();
        call(&s, "people.export_vcf", json!({"jobId": "j3", "destDir": dest.path().to_string_lossy()})).await;
        let (_, frame) = crate::handlers::vault_files::finished_export(&mut rx, "j3").await;
        assert!(frame.get("error").is_none(), "{frame}");
        assert_eq!(frame["result"]["count"], 450);
        let out = std::fs::read_to_string(dest.path().join("contacts.vcf")).unwrap();
        assert_eq!(out.matches("BEGIN:VCARD").count(), 450);
    }
}
