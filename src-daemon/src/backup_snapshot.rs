//! Automatic manifests are a retained part of a backup outcome, not a new job system.
use super::*;

pub(super) fn settled(value: &Value) -> bool {
    matches!(
        value["status"].as_str(),
        Some("not_due" | "applied" | "failed" | "uncertain")
    )
}
pub(super) fn recover(ledger: &mut Ledger) -> bool {
    let mut changed = false;
    for out in &mut ledger.outcomes {
        if out.snapshot.is_null() && out.applied {
            out.snapshot = json!({"status":"not_due","reason":"legacy_skipped"});
            changed = true;
        } else if out.snapshot["status"] == "dispatched" {
            out.snapshot = json!({"status":"uncertain","reason":"process_lost_after_dispatch"});
            changed = true;
        }
    }
    changed
}
pub(super) async fn completed(
    state: &Arc<DaemonState>,
    ledger: &mut Ledger,
    run: &str,
    execution: &str,
    result: &Result<Value, String>,
    at: i64,
) -> Result<(), String> {
    let mut next = ledger.clone();
    let Some(out) = next.outcomes.iter_mut().find(|out| {
        out.intent.run_id == run
            && out.intent.execution_id == execution
            && out.snapshot["status"] == "dispatched"
    }) else {
        return Ok(());
    };
    out.snapshot = match result {
        Ok(receipt) => json!({"status":"created","receipt":receipt,"createdAt":at}),
        Err(_) => json!({"status":"failed"}),
    };
    publish(state, &mut next).await?;
    *ledger = next;
    Ok(())
}
fn apply_time(
    path: &Path,
    account: &str,
    at: i64,
) -> Result<Option<mailvault_core::settings_doc::Change>, String> {
    let doc = SettingsDoc::shared(path);
    for _ in 0..3 {
        let snapshot = doc.get(None).map_err(|e| e.catalog_key().to_string())?;
        if snapshot.recovered.is_some() || !snapshot.values[STORE]["state"].is_object() {
            return Err("errors.settingsNotLoaded".into());
        }
        if snapshot.values[STORE]["state"]["snapshotLastTimes"][account]
            .as_i64()
            .unwrap_or(0)
            >= at
        {
            return Ok(None);
        }
        match doc.patch(
            &json!({STORE:{"state":{"snapshotLastTimes":{account:at}}}}),
            Some(snapshot.version),
        ) {
            Ok(change) => return Ok(Some(change)),
            Err(SettingsError::Conflict { .. }) => continue,
            Err(e) => return Err(e.catalog_key().into()),
        }
    }
    Err("errors.settingsConflict".into())
}
pub(super) async fn drive(state: &Arc<DaemonState>, ledger: &mut Ledger) -> Result<(), String> {
    // Created receipts repair settings only. An old receipt can never move time backwards.
    while let Some(index) = ledger
        .outcomes
        .iter()
        .position(|o| o.snapshot["status"] == "created")
    {
        let out = &ledger.outcomes[index];
        let account = out.intent.account_id.clone();
        let at = out.snapshot["createdAt"]
            .as_i64()
            .ok_or("errors.settingsInvalid")?;
        let path = state.app_dir.clone();
        if let Some(change) = common::blocking(move || apply_time(&path, &account, at)).await?? {
            if !change.changed.is_empty() {
                state.events.emit(
                    crate::handlers::settings::CHANGED_EVENT,
                    json!({"keys":change.changed,"version":change.version}),
                );
            }
        }
        let mut next = ledger.clone();
        next.outcomes[index].snapshot["status"] = json!("applied");
        publish(state, &mut next).await?;
        *ledger = next;
    }
    // Policy decisions are small settings/account reads, never the manifest scan.
    for index in 0..ledger.outcomes.len() {
        if !ledger.outcomes[index].applied || !ledger.outcomes[index].snapshot.is_null() {
            continue;
        }
        let out = &ledger.outcomes[index];
        let due = if out.status != "success"
            || out.intent.epoch != state.backup_worker.epoch.load(SeqCst)
        {
            false
        } else {
            let path = state.app_dir.clone();
            let account = out.intent.account_id.clone();
            let now = state.clock.now_ms();
            common::blocking(move || {
                loaded_settings(&path)
                    .map(|settings| policy::snapshot_due(&settings, &account, now, true))
            })
            .await??
        };
        let mut next = ledger.clone();
        next.outcomes[index].snapshot = json!({"status":if due {"queued"} else {"not_due"}});
        publish(state, &mut next).await?;
        *ledger = next;
    }
    if ledger
        .outcomes
        .iter()
        .any(|o| o.snapshot["status"] == "dispatched")
    {
        return Ok(());
    }
    let Some(index) = ledger
        .outcomes
        .iter()
        .position(|o| o.snapshot["status"] == "queued")
    else {
        return Ok(());
    };
    let out = &ledger.outcomes[index];
    let path = state.app_dir.clone();
    let account = out.intent.account_id.clone();
    let now = state.clock.now_ms();
    let due = common::blocking(move || {
        loaded_settings(&path).map(|settings| policy::snapshot_due(&settings, &account, now, true))
    })
    .await??;
    let mut next = ledger.clone();
    if !due || out.intent.epoch != state.backup_worker.epoch.load(SeqCst) {
        next.outcomes[index].snapshot =
            json!({"status":"not_due","reason":"stopped_or_policy_changed"});
        publish(state, &mut next).await?;
        *ledger = next;
        return Ok(());
    }
    next.outcomes[index].snapshot = json!({"status":"dispatched"});
    publish(state, &mut next).await?;
    *ledger = next;
    let intent = ledger.outcomes[index].intent.clone();
    let st = state.clone();
    tokio::spawn(async move {
        let job = st.clone();
        let account = intent.account_id.clone();
        let result = common::blocking(move || {
            #[cfg(test)]
            {
                let barrier = job.backup_worker.snapshot_barrier.lock().unwrap().take();
                if let Some((entered, release)) = barrier {
                    let _ = entered.send(());
                    let _ = release.recv();
                }
            }
            let root = common::vault_root(&job)?;
            let record = crate::ai_gate::listed_record(&job.app_dir, &account)
                .ok_or("errors.accountNotFound")?;
            let email = record["email"].as_str().ok_or("errors.accountNotFound")?;
            crate::snapshot::create_snapshot_from_maildir(&root, &account, email).and_then(|info| {
                serde_json::to_value(info).map_err(|_| "errors.settingsInvalid".into())
            })
        })
        .await
        .and_then(|value| value);
        let at = result
            .as_ref()
            .ok()
            .and_then(|v| v["timestamp"].as_str())
            .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or_else(|| st.clock.now_ms());
        let _ = st
            .backup_worker
            .tx
            .get()
            .unwrap()
            .send(Cmd::SnapshotFinished {
                run: intent.run_id,
                execution: intent.execution_id,
                result,
                at,
            });
    });
    Ok(())
}
