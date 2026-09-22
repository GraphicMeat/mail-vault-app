//! Daemon RPC routes for interactive, one-shot IMAP reads (Task 5.4a) and
//! writes + lifecycle (Task 5.4b), plan
//! `docs/superpowers/plans/2026-09-17-daemon-shell-phase5-network.md`.
//!
//! Naming deviation from the plan text (ledgered in
//! `docs/superpowers/ledgers/2026-09-17-daemon-shell-phase5/progress.md`):
//! the plan calls this family `imap.*`, but every method below keeps the
//! flat, Tauri-command-identical name (`imap_get_mailboxes`, not
//! `imap.getMailboxes`). `sync.*`/`llm.*`/etc. are dotted because
//! `transport.js`'s `DAEMON_COMMANDS` maps a JS command name to a different
//! RPC method string AND keeps the Tauri command as a heartbeat-gated
//! fallback. These ten have their Tauri twin deleted in this same task, so
//! they belong in `DAEMON_OWNED` instead (no fallback, no heartbeat gate) —
//! and `DAEMON_OWNED` has no rename layer: `sendToDaemon` sends the JS
//! command name straight through as the RPC method. Every existing
//! `DAEMON_OWNED` family (`vault_files`, `cache`, `archive`, `migration`,
//! ...) is flat for the identical reason. Matching that precedent, not the
//! plan's shorthand, is what tasks 5.4b/5.5/5.6/5.7/5.8 should pattern-match.
//!
//! These commands take a full `ImapConfig` (with password/oauth2AccessToken)
//! as an RPC param, same as they did as Tauri commands — the scoping call in
//! the plan's header keeps that unchanged for interactive one-shot commands;
//! only sync.now/sync.watch (Task 5.2) resolve credentials in the daemon.
//!
//! `with_background`/`conn_lost_message` are ported verbatim from
//! `src-tauri/src/commands.rs` (same body, `state.imap_pool` instead of a
//! `tauri::State<ImapPool>`) rather than switched to `ImapPool::run_read`:
//! the plan calls these "no behavior change, just which process runs it",
//! and `run_read` adds a dead-socket retry `with_background` never had.
//! `imap_get_email`/`imap_get_email_light` already used `run_read` as Tauri
//! commands (`commands.rs`), so they keep doing so here, unchanged.
use crate::handlers::common::{blocking, opt_str_arg, opt_u32_arg, str_arg, u32_arg, u64_arg, vec_arg, with_mailbox_write};
use crate::imap::{self, pool::ImapPool, ImapConfig};
use crate::ipc::{self, RpcResponse};
use crate::server::DaemonState;
use mailvault_core::vault_files;
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::warn;

macro_rules! req {
    ($result:expr) => {
        match $result {
            Ok(v) => v,
            Err(resp) => return Some(resp),
        }
    };
}

/// Ceiling on a single body fetch, semaphore wait included — ported from
/// `commands.rs`'s `imap_get_email_light`, same value, same reasoning: only
/// the TCP connect has its own timeout, so a server that accepts the FETCH
/// and goes quiet must not spin the caller forever.
const BODY_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(45);

/// Same helper as `commands.rs`'s `with_background`, against the daemon's
/// pool instead of a `tauri::State`. On success the session goes back to the
/// pool with its last-selected mailbox; on error the guard is dropped (permit
/// released, pool creates fresh next time).
async fn with_background<F, Fut, T>(pool: &ImapPool, account: &ImapConfig, f: F) -> Result<T, String>
where
    F: FnOnce(imap::pool::ImapSession) -> Fut,
    Fut: std::future::Future<Output = Result<(T, imap::pool::ImapSession, Option<String>), String>>,
{
    let imap::pool::PooledSessionGuard { session, last_selected: _, _permit } = pool.get_background(account).await?;
    match f(session).await {
        Ok((result, session, selected_mailbox)) => {
            let return_guard = imap::pool::PooledSessionGuard { session, last_selected: selected_mailbox, _permit };
            pool.return_background(account, return_guard).await;
            Ok(result)
        }
        Err(e) => Err(e), // _permit dropped here — semaphore released
    }
}

/// Same helper as `commands.rs`'s `with_priority` (Task 5.4b) — priority pool
/// instead of background, otherwise identical to `with_background` above.
async fn with_priority<F, Fut, T>(pool: &ImapPool, account: &ImapConfig, f: F) -> Result<T, String>
where
    F: FnOnce(imap::pool::ImapSession) -> Fut,
    Fut: std::future::Future<Output = Result<(T, imap::pool::ImapSession, Option<String>), String>>,
{
    let imap::pool::PooledSessionGuard { session, last_selected: _, _permit } = pool.get_priority(account).await?;
    match f(session).await {
        Ok((result, session, selected_mailbox)) => {
            let return_guard = imap::pool::PooledSessionGuard { session, last_selected: selected_mailbox, _permit };
            pool.return_priority(account, return_guard).await;
            Ok(result)
        }
        Err(e) => Err(e), // _permit dropped here — semaphore released
    }
}

/// Ported from `commands.rs` verbatim: a pooled socket the peer closed while
/// it sat idle answers its first command with a connection-lost error, which
/// reads to the user as the server refusing a message that's sitting right
/// there. Translate that specific case; anything else is the server's own
/// answer and stays as-is.
fn conn_lost_message(err: &str, account: &ImapConfig, uid: u32) -> String {
    if imap::pool::is_connection_lost(err) {
        format!("E_CONN_LOST: The connection to {} dropped while loading message {}", account.host, uid)
    } else {
        err.to_string()
    }
}

fn account_arg(id: &Value, params: &Value) -> Result<ImapConfig, RpcResponse> {
    params
        .get("account")
        .and_then(|v| serde_json::from_value::<ImapConfig>(v.clone()).ok())
        .ok_or_else(|| RpcResponse::error(id.clone(), ipc::INVALID_PARAMS, "Missing or invalid account".to_string()))
}

/// Mirrors `commands.rs`'s local `SearchFilters` (`imap_search_emails`) —
/// small enough that a second copy here beats promoting it to core for one
/// caller on each side.
#[derive(Clone, Debug, Default, serde::Deserialize)]
pub(crate) struct SearchFilters {
    pub(crate) from: Option<String>,
    pub(crate) subject: Option<String>,
    pub(crate) since: Option<String>,
    pub(crate) before: Option<String>,
}

impl SearchFilters {
    pub(crate) fn for_mail_search(
        from: Option<String>,
        date_from: Option<i64>,
        date_to: Option<i64>,
    ) -> Self {
        let day = |timestamp| {
            chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0)
                .map(|value| value.date_naive())
        };
        let since = date_from
            .and_then(day)
            .map(|date| date.format("%Y-%m-%d").to_string());
        // IMAP BEFORE is exclusive; advance the user's inclusive end day.
        let before = date_to
            .and_then(day)
            .and_then(|date| date.succ_opt())
            .map(|date| date.format("%Y-%m-%d").to_string());

        Self {
            from,
            subject: None,
            since,
            before,
        }
    }
}

pub(crate) async fn route(state: &Arc<DaemonState>, method: &str, params: &Value, id: Value) -> Option<RpcResponse> {
    Some(match method {
        "imap_get_mailboxes" => {
            let account = req!(account_arg(&id, params));
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let result = imap::list_mailboxes(&mut session)
                    .await
                    .map_err(|e| format!("Failed to fetch mailboxes: {}", e))?;
                Ok((result, session, None))
            })
            .await;
            match result {
                Ok(mailboxes) => RpcResponse::success(id, json!({"success": true, "mailboxes": mailboxes})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_get_emails" => {
            let account = req!(account_arg(&id, params));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let page = opt_u32_arg(params, "page").unwrap_or(1);
            let limit = opt_u32_arg(params, "limit").unwrap_or(200);
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let result = imap::fetch_emails_page(&mut session, &mailbox, page, limit)
                    .await
                    .map_err(|e| format!("Failed to fetch emails: {}", e))?;
                Ok((result, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok((emails, total, has_more, skipped_uids)) => RpcResponse::success(
                    id,
                    json!({
                        "success": true, "emails": emails, "total": total, "page": page,
                        "limit": limit, "hasMore": has_more, "skippedUids": skipped_uids,
                    }),
                ),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_check_mailbox_status" => {
            let account = req!(account_arg(&id, params));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let acct = &account;
            // Capabilities are cached at session creation, so this must read
            // AFTER checkout (inside the closure) — before it, the first call
            // of a process always reads false. Same ordering as commands.rs.
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let has_condstore = state.imap_pool.has_capability(acct, "CONDSTORE").await;
                let result = imap::check_mailbox_status(&mut session, &mailbox, has_condstore).await?;
                Ok((result, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok((exists, uid_validity, uid_next, highest_modseq)) => RpcResponse::success(
                    id,
                    json!({"exists": exists, "uidValidity": uid_validity, "uidNext": uid_next, "highestModseq": highest_modseq}),
                ),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_folder_status" => {
            let account = req!(account_arg(&id, params));
            let mailboxes = req!(vec_arg::<String>(&id, params, "mailboxes"));
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let out = imap::mailbox_statuses(&mut session, &mailboxes).await?;
                Ok((out, session, None))
            })
            .await;
            match result {
                Ok(statuses) => match serde_json::to_value(&statuses) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e.to_string()),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_search_all_uids" => {
            let account = req!(account_arg(&id, params));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let acct = &account;
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let has_esearch = state.imap_pool.has_capability(acct, "ESEARCH").await;
                let result = imap::search_all_uids(&mut session, &mailbox, has_esearch).await?;
                Ok((result, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok(uids) => RpcResponse::success(id, json!({"uids": uids})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_fetch_headers_by_uids" => {
            let account = req!(account_arg(&id, params));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let result = imap::fetch_headers_by_uids(&mut session, &mailbox, &uids).await?;
                Ok((result, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok((emails, total)) => RpcResponse::success(id, json!({"emails": emails, "total": total})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_fetch_changed_flags" => {
            let account = req!(account_arg(&id, params));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let since_modseq = req!(u64_arg(&id, params, "sinceModseq"));
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let result = imap::fetch_changed_flags(&mut session, &mailbox, since_modseq).await?;
                Ok((result, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok(changed) => {
                    let changes: Vec<Value> =
                        changed.into_iter().map(|(uid, flags)| json!({"uid": uid, "flags": flags})).collect();
                    RpcResponse::success(id, json!({"changes": changes}))
                }
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_get_email" => {
            let account = req!(account_arg(&id, params));
            let uid = req!(u32_arg(&id, params, "uid"));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let mb_name = mailbox.clone();
            let result = state
                .imap_pool
                .run_read(&account, true, |mut session| {
                    let mailbox = mailbox.clone();
                    async move {
                        let result = imap::fetch_email_by_uid(&mut session, &mailbox, uid)
                            .await
                            .map_err(|e| format!("Failed to fetch email: {}", e))?;
                        Ok((result, session, Some(mailbox)))
                    }
                })
                .await;
            match result {
                Ok(Some(email)) => RpcResponse::success(id, json!({"success": true, "email": email})),
                // Not an error: the server proved the uid is gone (see
                // `uid_still_present` in mailvault_core::imap), so the
                // caller can prune the row instead of showing a failure.
                // Matches the app's E_UID_GONE convention verbatim.
                Ok(None) => RpcResponse::error(
                    id,
                    ipc::INTERNAL_ERROR,
                    format!("E_UID_GONE: Message UID {} is no longer in {}", uid, mb_name),
                ),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, conn_lost_message(&e, &account, uid)),
            }
        }

        "imap_get_email_light" => {
            let account = req!(account_arg(&id, params));
            let uid = req!(u32_arg(&id, params, "uid"));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let account_id = opt_str_arg(params, "accountId");
            // Prefetch of the next rows is background work — left on the
            // priority lane it would take one of that account's 3 permits,
            // queueing the click the user actually made behind up to three
            // whole message bodies. Same reasoning as commands.rs.
            let use_background = params.get("background").and_then(Value::as_bool).unwrap_or(false);
            let mb_clone = mailbox.clone();
            let started = std::time::Instant::now();

            let fetch = state.imap_pool.run_read(&account, !use_background, |mut session| {
                let mb = mailbox.clone();
                async move {
                    let result = imap::fetch_email_by_uid_light(&mut session, &mb, uid)
                        .await
                        .map_err(|e| format!("Failed to fetch email: {}", e))?;
                    Ok((result, session, Some(mb)))
                }
            });

            let email = match tokio::time::timeout(BODY_FETCH_TIMEOUT, fetch).await {
                Ok(Ok(email)) => email,
                Ok(Err(e)) => {
                    tracing::info!(
                        "[CMD] imap_get_email_light: FAILED uid={} mailbox={} background={} after {}ms: {}",
                        uid, mb_clone, use_background, started.elapsed().as_millis(), e
                    );
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, conn_lost_message(&e, &account, uid)));
                }
                Err(_) => {
                    let msg = format!(
                        "Timed out after {}s fetching message UID {} from {}",
                        BODY_FETCH_TIMEOUT.as_secs(),
                        uid,
                        mb_clone
                    );
                    tracing::info!("[CMD] imap_get_email_light: {}", msg);
                    return Some(RpcResponse::error(id, ipc::INTERNAL_ERROR, msg));
                }
            };

            tracing::info!(
                "[CMD] imap_get_email_light: uid={} mailbox={} background={} found={} in {}ms",
                uid, mb_clone, use_background, email.is_some(), started.elapsed().as_millis()
            );

            match email {
                Some(e) => {
                    // Auto-cache to Maildir so attachments/rawSource can be
                    // loaded on-demand later — moves unchanged from
                    // `main.rs`'s `maildir_store_raw`, minus its base64
                    // encode/decode round trip: the bytes are already here.
                    // `overwrite: false` (skip if a file for this uid already
                    // exists) is `maildir_store_raw`'s semantics, NOT
                    // `maildir_store`'s (which always overwrites) — the two
                    // must not be conflated.
                    //
                    // Non-fatal by design, matching the app: a cache failure
                    // (including "vault unavailable") must not fail the fetch
                    // the user is staring at, only warn.
                    // `e.uid` (the server's answer), not the request's `uid` —
                    // matches `maildir_store_raw`'s original call, which
                    // stored under the fetched email's own uid.
                    let store_uid = e.uid;
                    let aid = account_id.clone().unwrap_or_else(|| account.email.clone());
                    let mb = mb_clone.clone();
                    let raw = e.raw_source_bytes.clone();
                    let state2 = Arc::clone(state);
                    let aid2 = aid.clone();
                    let mb2 = mb.clone();
                    let cache_result = blocking(move || -> Result<bool, String> {
                        with_mailbox_write(&state2, &aid2, &mb2, |root| {
                            vault_files::store(&state2.vault_registry, root, &aid2, &mb2, store_uid, &raw, &[], false)
                        })
                    })
                    .await;
                    // `store` answered Ok: written now, or a file was already there.
                    let cached = matches!(cache_result, Ok(Ok(_)));
                    match cache_result {
                        // A write nudges the index through the registry's change hook.
                        Ok(Ok(true)) => {}
                        Ok(Ok(false)) => {} // already cached — no nudge, matching maildir_store_raw
                        Ok(Err(err)) => warn!("Failed to auto-cache .eml for UID {}: {}", store_uid, err),
                        Err(join_err) => warn!("Failed to auto-cache .eml for UID {}: task join error: {}", store_uid, join_err),
                    }
                    RpcResponse::success(id, json!({"success": true, "email": e, "cached": cached}))
                }
                // Proven absence (a tagged OK on the second probe), not an
                // error — `success:false, gone:true` is what api.js's
                // `fetchEmailLight` matches to throw `MessageGoneError`.
                None => RpcResponse::success(id, json!({"success": false, "gone": true, "uid": uid, "mailbox": mb_clone})),
            }
        }

        "imap_search_emails" => {
            let account = req!(account_arg(&id, params));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let query = opt_str_arg(params, "query");
            let filters: SearchFilters =
                params.get("filters").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let result = imap::search_emails(
                    &mut session,
                    &mailbox,
                    query.as_deref(),
                    filters.from.as_deref(),
                    filters.subject.as_deref(),
                    filters.since.as_deref(),
                    filters.before.as_deref(),
                )
                .await
                .map_err(|e| format!("Failed to search emails: {}", e))?;
                Ok((result, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok((emails, total)) => RpcResponse::success(id, json!({"success": true, "emails": emails, "total": total})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        // ── Task 5.4b: write-path + lifecycle ───────────────────────────

        "imap_test_connection" => {
            let account = req!(account_arg(&id, params));
            tracing::info!(
                "[test-connection] Testing {} → {}:{}",
                account.email, account.host, account.effective_port()
            );
            // Wrap the whole test in a 20s timeout — auth/TLS steps have no
            // individual timeout of their own. Verbatim from commands.rs; the
            // RPC layer's own ceiling is already ≥45s (imap_get_email_light's
            // BODY_FETCH_TIMEOUT), so this stays well inside it.
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), imap::test_connection(&account)).await;
            match outcome {
                Ok(Ok(())) => RpcResponse::success(id, json!({"success": true, "message": "Connection successful"})),
                Ok(Err(e)) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
                Err(_) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Connection test timed out for {}", account.email)),
            }
        }

        "imap_set_flags" => {
            let account = req!(account_arg(&id, params));
            let uid = req!(u32_arg(&id, params, "uid"));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let flags = req!(vec_arg::<String>(&id, params, "flags"));
            let action = opt_str_arg(params, "action").unwrap_or_else(|| "add".to_string());
            // `written` is what PERMANENTFLAGS let through — empty is a
            // success the caller has to see, not an error: the server simply
            // cannot keep the flag.
            let result = with_priority(&state.imap_pool, &account, |mut session| async move {
                let written = imap::set_flags(&mut session, &mailbox, uid, &flags, &action)
                    .await
                    .map_err(|e| format!("Failed to update flags: {}", e))?;
                Ok((written, session, Some(mailbox)))
            })
            .await;
            match result {
                Ok(written) => RpcResponse::success(id, json!({"success": true, "written": written})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_delete_email" => {
            let account = req!(account_arg(&id, params));
            let uid = req!(u32_arg(&id, params, "uid"));
            let mailbox = opt_str_arg(params, "mailbox").unwrap_or_else(|| "INBOX".to_string());
            let permanent = params.get("permanent").and_then(Value::as_bool).unwrap_or(false);
            // `run_uid_delete`, not `with_priority`: a pooled socket the peer
            // closed while it sat idle fails this before the SELECT lands,
            // and the frontend restores the row it had already taken out — a
            // delete that reads as a message coming back from the dead. See
            // the pool's own doc for why a uid-addressed delete is the one
            // mutation safe to re-send. Capabilities are cached when a
            // session is CREATED, so read them inside the closure, after
            // checkout — exactly like imap_move_emails below.
            //
            // `pool_ref`/`acct` bound outside the closure (not `state`
            // itself) to match `commands.rs`'s original capture set
            // byte-for-byte: `run_uid_delete` wants `Fn`, not `FnOnce` (the
            // dead-socket retry can call it twice), and `&ImapPool`/
            // `&ImapConfig` are the exact `Copy` references the original
            // shipped, not a structural guess.
            let pool_ref: &ImapPool = &state.imap_pool;
            let acct = &account;
            let result = state
                .imap_pool
                .run_uid_delete(&account, true, |mut session| {
                    let mailbox = mailbox.clone();
                    async move {
                        let has_uidplus = pool_ref.has_capability(acct, "UIDPLUS").await;
                        let outcome = imap::delete_email(&mut session, &mailbox, uid, permanent, has_uidplus)
                            .await
                            .map_err(|e| format!("Failed to delete email: {}", e))?;
                        Ok((outcome, session, Some(mailbox)))
                    }
                })
                .await;
            match result {
                // Where the message went, so the caller can offer an undo
                // instead of a search: both null for a permanent delete.
                Ok(outcome) => RpcResponse::success(
                    id,
                    json!({"success": true, "trash": outcome.trash, "trashUid": outcome.trash_uid}),
                ),
                Err(e) => {
                    tracing::error!("[delete_email] uid={} failed: {}", uid, e);
                    RpcResponse::error(id, ipc::INTERNAL_ERROR, e)
                }
            }
        }

        "imap_ensure_sent_mailbox" => {
            let account = req!(account_arg(&id, params));
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let path = imap::ensure_sent_mailbox(&mut session).await?;
                Ok((path, session, None))
            })
            .await;
            match result {
                // Bare string, matching the deleted Tauri command's
                // `Result<String, String>` — api.js uses the reply directly
                // as the resolved mailbox path, not a `{path: ...}` wrapper.
                Ok(path) => RpcResponse::success(id, json!(path)),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        // All three folder-management routes report `None` as the pooled
        // session's last-selected mailbox: CREATE changes the hierarchy
        // under it, and RENAME/DELETE send CLOSE, so whatever the socket had
        // selected before is no longer selected.
        "imap_create_mailbox" => {
            let account = req!(account_arg(&id, params));
            let path = req!(str_arg(&id, params, "path"));
            let result = with_priority(&state.imap_pool, &account, |mut session| async move {
                imap::create_mailbox(&mut session, &path).await?;
                Ok(((), session, None))
            })
            .await;
            match result {
                Ok(()) => RpcResponse::success(id, json!({"success": true})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_rename_mailbox" => {
            let account = req!(account_arg(&id, params));
            let from = req!(str_arg(&id, params, "from"));
            let to = req!(str_arg(&id, params, "to"));
            let result = with_priority(&state.imap_pool, &account, |mut session| async move {
                imap::rename_mailbox(&mut session, &from, &to).await?;
                Ok(((), session, None))
            })
            .await;
            match result {
                Ok(()) => RpcResponse::success(id, json!({"success": true})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_delete_mailbox" => {
            let account = req!(account_arg(&id, params));
            let paths = req!(vec_arg::<String>(&id, params, "paths"));
            let result = with_priority(&state.imap_pool, &account, |mut session| async move {
                let n = imap::delete_mailbox(&mut session, &paths).await?;
                Ok((n, session, None))
            })
            .await;
            match result {
                Ok(deleted) => RpcResponse::success(id, json!({"success": true, "deleted": deleted})),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_find_message_id" => {
            let account = req!(account_arg(&id, params));
            let message_id = req!(str_arg(&id, params, "messageId"));
            let stop_on_first = params.get("stopOnFirst").and_then(Value::as_bool).unwrap_or(true);
            let result = with_background(&state.imap_pool, &account, |mut session| async move {
                let result = imap::find_message_id(&mut session, &message_id, stop_on_first).await?;
                // A sweep SELECTs many folders and can end on one whose
                // SELECT was refused, so it has no single answer for the
                // pool's bookkeeping — None says so rather than naming a
                // folder that may not be selected.
                Ok((result, session, None))
            })
            .await;
            match result {
                // Bare serialized probe struct
                // ({messageId, found, searched, failed, complete}) — api.js
                // returns this straight through, no wrapper.
                Ok(probe) => match serde_json::to_value(&probe) {
                    Ok(v) => RpcResponse::success(id, v),
                    Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, format!("Serialize probe: {}", e)),
                },
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        "imap_disconnect" => {
            let account = req!(account_arg(&id, params));
            state.imap_pool.disconnect(&account).await;
            RpcResponse::success(id, json!({"success": true}))
        }

        "imap_move_emails" => {
            let account = req!(account_arg(&id, params));
            let uids = req!(vec_arg::<u32>(&id, params, "uids"));
            let source_mailbox = req!(str_arg(&id, params, "sourceMailbox"));
            let target_mailbox = req!(str_arg(&id, params, "targetMailbox"));
            // Capabilities are cached when a session is CREATED, so read them
            // inside the closure, after checkout — a read before it sees an
            // empty map on the first call of a process and takes the slow
            // COPY path.
            //
            // Same `pool_ref`/`acct` binding as imap_delete_email above —
            // `with_priority` is `FnOnce` here so it's not load-bearing for
            // compilation, but kept for the identical capture shape.
            let pool_ref: &ImapPool = &state.imap_pool;
            let acct = &account;
            let result = with_priority(&state.imap_pool, &account, |mut session| async move {
                let has_move = pool_ref.has_capability(acct, "MOVE").await;
                let has_uidplus = pool_ref.has_capability(acct, "UIDPLUS").await;
                let result = imap::move_uids(&mut session, &source_mailbox, &target_mailbox, &uids, has_move, has_uidplus).await?;
                Ok((result, session, Some(source_mailbox)))
            })
            .await;
            match result {
                // `newUids` is null on a server without UIDPLUS: it reported
                // no COPYUID, and a guessed destination uid addresses the
                // wrong message.
                Ok(outcome) => RpcResponse::success(
                    id,
                    json!({"success": true, "moved": outcome.moved, "newUids": outcome.new_uids}),
                ),
                Err(e) => RpcResponse::error(id, ipc::INTERNAL_ERROR, e),
            }
        }

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use mock_imap::state::{synthetic_mailbox, Mailbox, Message};
    use mock_imap::{MockImap, Scenario};

    fn st(mail_dir_ok: bool) -> Arc<DaemonState> {
        let dir = std::env::temp_dir().join(format!("mv-imap-handler-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        DaemonState::for_test(dir.clone(), dir, mail_dir_ok)
    }

    async fn call(s: &Arc<DaemonState>, method: &str, params: Value) -> RpcResponse {
        route(s, method, &params, json!(1)).await.expect("routed")
    }

    /// Every test dials a real (mock) socket, so this must be set before the
    /// connection is attempted — same env var, same reasoning as
    /// `server.rs`'s own sync.now test. Always "1", so unlike
    /// `MAILVAULT_TEST_CREDENTIALS` (a per-test path) two tests racing this
    /// set is harmless.
    fn plaintext() {
        std::env::set_var("MAILVAULT_IMAP_PLAINTEXT", "1");
    }

    fn account_json(server: &MockImap) -> Value {
        json!({
            "email": "user@example.com",
            "password": "hunter2",
            "imapHost": server.host(),
            "imapPort": server.port(),
        })
    }

    #[tokio::test]
    async fn get_mailboxes_lists_the_servers_folders() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Archive")));
        let s = st(true);

        let resp = call(&s, "imap_get_mailboxes", json!({"account": account_json(&server)})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        let names: Vec<String> =
            result["mailboxes"].as_array().unwrap().iter().map(|m| m["path"].as_str().unwrap().to_string()).collect();
        assert!(names.contains(&"INBOX".to_string()));
        assert!(names.contains(&"Archive".to_string()));
    }

    #[tokio::test]
    async fn get_emails_pages_the_selected_mailbox() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        let s = st(true);

        let resp = call(&s, "imap_get_emails", json!({"account": account_json(&server), "mailbox": "INBOX"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["total"], json!(3));
        assert_eq!(result["emails"].as_array().unwrap().len(), 3);
        assert_eq!(result["page"], json!(1));
        assert_eq!(result["limit"], json!(200));
    }

    #[tokio::test]
    async fn check_mailbox_status_answers_exists_and_uid_next() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let s = st(true);

        let resp = call(&s, "imap_check_mailbox_status", json!({"account": account_json(&server), "mailbox": "INBOX"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["exists"], json!(2));
        assert_eq!(result["uidNext"], json!(3));
    }

    #[tokio::test]
    async fn folder_status_is_a_bare_array_not_wrapped() {
        plaintext();
        let server =
            MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)).mailbox(synthetic_mailbox("Archive", 2)));
        let s = st(true);

        let resp = call(
            &s,
            "imap_folder_status",
            json!({"account": account_json(&server), "mailboxes": ["INBOX", "Archive"]}),
        )
        .await;
        let result = resp.result.expect("success");
        assert!(result.is_array(), "must be a bare array, api.js returns it directly: {result:?}");
        let paths: Vec<String> = result.as_array().unwrap().iter().map(|m| m["path"].as_str().unwrap().to_string()).collect();
        assert!(paths.contains(&"INBOX".to_string()) && paths.contains(&"Archive".to_string()));
    }

    #[tokio::test]
    async fn search_all_uids_returns_every_uid_ascending() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        let s = st(true);

        let resp = call(&s, "imap_search_all_uids", json!({"account": account_json(&server), "mailbox": "INBOX"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["uids"], json!([1, 2, 3]));
    }

    #[tokio::test]
    async fn fetch_headers_by_uids_returns_only_the_asked_uids() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 3)));
        let s = st(true);

        let resp = call(
            &s,
            "imap_fetch_headers_by_uids",
            json!({"account": account_json(&server), "mailbox": "INBOX", "uids": [1, 3]}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["total"], json!(3));
        let uids: Vec<u32> = result["emails"].as_array().unwrap().iter().map(|e| e["uid"].as_u64().unwrap() as u32).collect();
        assert_eq!(uids.len(), 2);
        assert!(uids.contains(&1) && uids.contains(&3));
    }

    fn mailbox_with_modseqs() -> Mailbox {
        let mut mb = Mailbox::new("INBOX");
        for (uid, modseq) in [(1u32, 10u64), (2, 20), (3, 30), (4, 40)] {
            mb.add(
                Message::new(
                    uid,
                    format!("From: a@example.com\nSubject: Msg {uid}\n\nBody {uid}\n"),
                )
                .with_modseq(modseq),
            );
        }
        mb.highest_modseq = 40;
        mb
    }

    #[tokio::test]
    async fn fetch_changed_flags_filters_out_uids_at_or_before_since() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(mailbox_with_modseqs()));
        let s = st(true);

        let resp = call(
            &s,
            "imap_fetch_changed_flags",
            json!({"account": account_json(&server), "mailbox": "INBOX", "sinceModseq": 20}),
        )
        .await;
        let result = resp.result.expect("success");
        let uids: Vec<u32> = result["changes"].as_array().unwrap().iter().map(|c| c["uid"].as_u64().unwrap() as u32).collect();
        assert_eq!(uids, vec![3, 4], "MODSEQ <= since must be filtered out");
    }

    #[tokio::test]
    async fn get_email_returns_the_full_body() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let s = st(true);

        let resp = call(&s, "imap_get_email", json!({"account": account_json(&server), "uid": 1, "mailbox": "INBOX"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["email"]["uid"], json!(1));
    }

    #[tokio::test]
    async fn get_email_for_a_gone_uid_is_an_e_uid_gone_error() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let s = st(true);

        let resp = call(&s, "imap_get_email", json!({"account": account_json(&server), "uid": 99, "mailbox": "INBOX"})).await;
        let err = resp.error.expect("must be an error");
        assert!(err.message.starts_with("E_UID_GONE:"), "{}", err.message);
    }

    #[tokio::test]
    async fn get_email_light_auto_caches_to_the_vault_and_nudges_the_index() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let (tmp, s) = {
            let dir = std::env::temp_dir().join(format!("mv-imap-light-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            (dir.clone(), DaemonState::for_test(dir.clone(), dir, true))
        };

        let resp = call(
            &s,
            "imap_get_email_light",
            json!({"account": account_json(&server), "uid": 1, "mailbox": "INBOX", "accountId": "acc1"}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["email"]["uid"], json!(1));
        // `raw_source_bytes` is `#[serde(skip)]` on `LightFullEmail` — the
        // light payload must not carry it under any key. `email` itself must
        // still be an object with real fields, so this isn't vacuously true
        // of e.g. a null/missing `email`.
        assert!(result["email"].is_object() && !result["email"].as_object().unwrap().is_empty());
        let keys: Vec<&String> = result["email"].as_object().unwrap().keys().collect();
        assert!(
            keys.iter().all(|k| !k.to_lowercase().contains("raw")),
            "no raw-source key of any name may appear: {keys:?}"
        );

        let cur = tmp.join("Maildir").join("acc1").join("INBOX").join("cur");
        let files: Vec<_> = std::fs::read_dir(&cur).unwrap().collect();
        assert_eq!(files.len(), 1, "the light fetch must auto-cache the .eml to the vault: {cur:?}");
        assert_eq!(result["cached"], json!(true));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn get_email_light_for_a_gone_uid_is_a_success_payload_not_an_error() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let s = st(true);

        let resp = call(
            &s,
            "imap_get_email_light",
            json!({"account": account_json(&server), "uid": 99, "mailbox": "INBOX"}),
        )
        .await;
        let result = resp.result.expect("gone is a success payload, not an RPC error");
        assert_eq!(result["success"], json!(false));
        assert_eq!(result["gone"], json!(true));
        assert_eq!(result["uid"], json!(99));
    }

    /// A cache write that cannot land (vault unreachable) must not fail the
    /// fetch itself — the app's own `imap_get_email_light` only `warn!`s.
    #[tokio::test]
    async fn get_email_light_still_succeeds_when_the_vault_is_unavailable() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 1)));
        let s = st(false);

        let resp = call(&s, "imap_get_email_light", json!({"account": account_json(&server), "uid": 1, "mailbox": "INBOX"})).await;
        let result = resp.result.expect("the fetch must still succeed");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["cached"], json!(false), "a cache write that did not land is not reported as cached");
    }

    #[tokio::test]
    async fn search_emails_with_no_criteria_matches_nothing() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let s = st(true);

        let resp = call(&s, "imap_search_emails", json!({"account": account_json(&server), "mailbox": "INBOX"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["total"], json!(0));
        assert_eq!(result["emails"], json!([]));
    }

    // ── Task 5.4b: write-path + lifecycle ───────────────────────────────────

    #[tokio::test]
    async fn test_connection_succeeds_against_a_reachable_server() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(&s, "imap_test_connection", json!({"account": account_json(&server)})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
    }

    #[tokio::test]
    async fn set_flags_adds_a_flag_and_reports_what_was_written() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let s = st(true);

        let resp = call(
            &s,
            "imap_set_flags",
            json!({"account": account_json(&server), "uid": 1, "mailbox": "INBOX", "flags": ["\\Seen"]}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["written"], json!(["\\Seen"]));
    }

    #[tokio::test]
    async fn delete_email_permanent_reports_null_trash() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)));
        let s = st(true);

        let resp = call(
            &s,
            "imap_delete_email",
            json!({"account": account_json(&server), "uid": 1, "mailbox": "INBOX", "permanent": true}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["trash"], json!(null), "permanent delete addresses nothing to undo to");
        assert_eq!(result["trashUid"], json!(null));
    }

    #[tokio::test]
    async fn ensure_sent_mailbox_returns_a_bare_string_not_an_object() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("Sent").with_attrs(&["\\Sent"])));
        let s = st(true);

        let resp = call(&s, "imap_ensure_sent_mailbox", json!({"account": account_json(&server)})).await;
        let result = resp.result.expect("success");
        assert_eq!(result, json!("Sent"), "the Tauri twin returned Result<String, _> bare, not {{path: ...}}");
    }

    #[tokio::test]
    async fn create_mailbox_makes_the_folder_on_the_server() {
        plaintext();
        let server = MockImap::start(Scenario::new());
        let s = st(true);

        let resp = call(&s, "imap_create_mailbox", json!({"account": account_json(&server), "path": "Projects/Alpha"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert!(server.state().find("Projects/Alpha").is_some());
    }

    #[tokio::test]
    async fn rename_mailbox_renames_on_the_server() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("Projects")));
        let s = st(true);

        let resp = call(&s, "imap_rename_mailbox", json!({"account": account_json(&server), "from": "Projects", "to": "Work"})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert!(server.state().find("Work").is_some() && server.state().find("Projects").is_none());
    }

    #[tokio::test]
    async fn delete_mailbox_deletes_and_reports_the_count() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("Old")));
        let s = st(true);

        let resp = call(&s, "imap_delete_mailbox", json!({"account": account_json(&server), "paths": ["Old"]})).await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["deleted"], json!(1));
        assert!(server.state().find("Old").is_none());
    }

    #[tokio::test]
    async fn find_message_id_returns_the_bare_probe_shape_not_wrapped() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(Mailbox::new("INBOX")).mailbox(Mailbox::new("Archive")));
        let s = st(true);

        let resp = call(
            &s,
            "imap_find_message_id",
            json!({"account": account_json(&server), "messageId": "<gone@example.com>", "stopOnFirst": false}),
        )
        .await;
        let result = resp.result.expect("success");
        // Bare MessageIdProbe fields, no `success`/`result` wrapper key —
        // api.js's findMessageId returns this straight through.
        assert_eq!(result["messageId"], json!("<gone@example.com>"));
        assert_eq!(result["found"], json!([]));
        assert_eq!(result["searched"].as_array().unwrap().len(), 2);
        assert!(result["failed"].as_array().unwrap().is_empty());
        assert_eq!(result["complete"], json!(true), "two folders, both answered, neither had it");
    }

    #[tokio::test]
    async fn disconnect_is_a_success_no_op_when_nothing_is_pooled() {
        let s = st(true);
        let resp = call(
            &s,
            "imap_disconnect",
            json!({"account": {"email": "user@example.com", "password": "x", "imapHost": "127.0.0.1", "imapPort": 1}}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
    }

    #[tokio::test]
    async fn move_emails_moves_the_uid_and_reports_how_many() {
        plaintext();
        let server = MockImap::start(Scenario::new().mailbox(synthetic_mailbox("INBOX", 2)).mailbox(Mailbox::new("Archive")));
        let s = st(true);

        let resp = call(
            &s,
            "imap_move_emails",
            json!({"account": account_json(&server), "uids": [1], "sourceMailbox": "INBOX", "targetMailbox": "Archive"}),
        )
        .await;
        let result = resp.result.expect("success");
        assert_eq!(result["success"], json!(true));
        assert_eq!(result["moved"], json!(1));
        assert!(server.state().find("Archive").unwrap().by_uid(1).is_some(), "message must have actually landed in Archive");
    }

    #[tokio::test]
    async fn another_domains_method_is_not_routed_here() {
        let s = st(true);
        assert!(route(&s, "sync.now", &json!({}), json!(1)).await.is_none());
    }
}
