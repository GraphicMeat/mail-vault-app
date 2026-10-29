//! Graph ordinary body unit (Wave 4, S7). One message of a Graph mailbox for the
//! ordinary download-ahead runner: the Graph id comes from the mailbox's stable
//! uid ledger (never from the renderer), the token from the daemon's own
//! resolution (`config.access_token`), and the body goes through the same
//! stamped writer as every other ordinary body. Scope is the focused folder and
//! the background accounts' INBOX; there is no Graph full-mailbox sweep.

use crate::ordinary_runner::{BodyUnitOutcome, Spec};
use crate::sync_observation::SourceKey;
use crate::server::DaemonState;
use std::sync::Arc;

/// The Graph message id a ledger holds for `uid`. `Ok(None)`: no mapping, which
/// must never turn into a fetch of some other message.
fn ledger_id(state: &Arc<DaemonState>, account_id: &str, mailbox: &str, uid: u32) -> Result<Option<String>, String> {
    let root = crate::handlers::common::vault_root(state)?;
    let path = root.join("email_cache")
        .join(mailvault_core::header_cache::cache_base_name(account_id, mailbox))
        .join(mailvault_core::graph_ledger::LEDGER_FILE);
    Ok(mailvault_core::graph_ledger::load(&path)?.get(&uid).cloned())
}

fn header_date_ms(raw: &[u8]) -> Option<i64> {
    let date = mailparse::parse_headers(raw).ok()
        .and_then(|(headers, _)| mailparse::MailHeaderMap::get_first_value(headers.as_slice(), "Date"));
    crate::handlers::imap::email_date_ms(date.as_deref(), None)
}

pub(crate) async fn run_graph_body_unit(state: &Arc<DaemonState>, spec: &Spec, config: &crate::imap::ImapConfig,
    key: &SourceKey, uid: u32) -> BodyUnitOutcome {
    use crate::handlers::imap::{auto_cache_backfill_original, BODY_FETCH_TIMEOUT};
    let Some(token) = config.access_token.as_deref().filter(|token| !token.is_empty()) else {
        // No usable token: the daemon renews its own before the next round.
        return BodyUnitOutcome::Retryable("errors.syncCredentialsMissing".into());
    };
    let (ledger_state, account, folder) = (Arc::clone(state), spec.account_id.clone(), spec.mailbox.clone());
    let graph_id = match crate::handlers::common::blocking(move || ledger_id(&ledger_state, &account, &folder, uid)).await {
        Ok(Ok(Some(id))) => id,
        // This number names no Graph message here: nothing is fetched under it, nothing pruned.
        Ok(Ok(None)) => return BodyUnitOutcome::PolicySkipped,
        Ok(Err(error)) | Err(error) => return BodyUnitOutcome::Retryable(error),
    };
    let client = mailvault_core::graph::GraphClient::for_purpose(token, "download ahead").for_account(&config.email);
    let raw = match tokio::time::timeout(BODY_FETCH_TIMEOUT, client.get_mime_content(&graph_id)).await {
        Ok(Ok(raw)) => raw,
        // A deleted message answers 404: the ledger entry is real, the message is gone.
        Ok(Err(error)) if error.contains("(404)") => return BodyUnitOutcome::Gone,
        Ok(Err(error)) => return BodyUnitOutcome::Retryable(error),
        Err(_) => return BodyUnitOutcome::Retryable("timed out".into()),
    };
    let dated = header_date_ms(&raw);
    let result = auto_cache_backfill_original(state, key, uid, raw, dated, None).await;
    crate::ordinary_runner::finish_write(state, &spec.stamp, result).await
}
