use futures::StreamExt;
use tracing::info;

use crate::imap::{self, compress_uid_ranges, ImapSession};

/// Move emails between IMAP folders.
///
/// If the server supports the MOVE capability (RFC 6851), uses `UID MOVE`.
/// Otherwise, falls back to `UID COPY` + `UID STORE +FLAGS (\Deleted)` + `UID EXPUNGE`.
pub async fn move_emails(
    session: &mut ImapSession,
    source_mailbox: &str,
    target_mailbox: &str,
    uids: &[u32],
    has_move: bool,
) -> Result<u32, String> {
    if uids.is_empty() {
        return Ok(0);
    }

    // Select the source mailbox
    let _mbox = imap::select_mailbox(session, source_mailbox).await?;

    let uid_set = compress_uid_ranges(uids);
    let count = uids.len() as u32;

    if has_move {
        info!(
            "[move] Using UID MOVE for {} UIDs from '{}' to '{}' (range: {})",
            count, source_mailbox, target_mailbox, uid_set
        );

        session
            .uid_mv(&uid_set, target_mailbox)
            .await
            .map_err(|e| format!("UID MOVE failed: {}", e))?;
    } else {
        info!(
            "[move] Using COPY+DELETE fallback for {} UIDs from '{}' to '{}' (range: {})",
            count, source_mailbox, target_mailbox, uid_set
        );

        // Step 1: UID COPY to target mailbox
        session
            .uid_copy(&uid_set, target_mailbox)
            .await
            .map_err(|e| format!("UID COPY failed: {}", e))?;

        // Step 2: Flag as \Deleted in source
        let _: Vec<_> = session
            .uid_store(&uid_set, "+FLAGS (\\Deleted)")
            .await
            .map_err(|e| format!("STORE \\Deleted failed: {}", e))?
            .collect::<Vec<_>>()
            .await;

        // Step 3: UID EXPUNGE to remove only the flagged UIDs (RFC 4315 UIDPLUS)
        let _: Vec<_> = session
            .uid_expunge(&uid_set)
            .await
            .map_err(|e| format!("UID EXPUNGE failed: {}", e))?
            .collect::<Vec<_>>()
            .await;
    }

    info!(
        "[move] Successfully moved {} emails from '{}' to '{}'",
        count, source_mailbox, target_mailbox
    );

    Ok(count)
}
