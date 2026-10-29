//! Graph ordinary body unit (Wave 4, S7). Until the Graph arm lands this is the
//! seam `ordinary_runner::run_body_unit` calls: a Graph message is never fetched
//! here yet, so the unit reports a policy skip.

use crate::account_lifecycle::AccountStamp;
use crate::ordinary_runner::BodyUnitOutcome;
use crate::server::DaemonState;
use std::sync::Arc;

pub(crate) async fn run_graph_body_unit(_state: &Arc<DaemonState>, _stamp: &AccountStamp, _config: &crate::imap::ImapConfig,
    _account_id: &str, _mailbox: &str, _uid: u32) -> BodyUnitOutcome {
    BodyUnitOutcome::PolicySkipped
}
