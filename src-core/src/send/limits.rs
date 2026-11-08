//! How many bytes of attachments one message may carry, per way of sending.
//!
//! - SMTP: 25 MB, the common server limit (Gmail and Outlook refuse above it).
//! - Graph sends through `sendMail`, whose body (the MIME, base64-encoded once
//!   more) Graph refuses above [`crate::graph::SEND_MAIL_LIMIT_BYTES`]: the MIME
//!   may be 3/4 of that.
//! - JMAP uploads the MIME, which the server refuses above its session's
//!   `maxSizeUpload`, and may cap attachments at `maxSizeAttachmentsPerEmail`;
//!   never above 25 MB.
//!
//! In the MIME an attachment takes 4/3 of its size in base64 plus a line break
//! every 76 characters. The budget is deliberately on the safe side: it leaves
//! room for the headers, the text (which may be quoted-printable) and the MIME
//! structure.

/// Most bytes of attachments one message takes on any account.
pub const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
/// Room left in a Graph or JMAP send for everything but the attachments.
const HEADER_MARGIN: u64 = 16 * 1024;

/// How the account sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendKind {
    Smtp,
    Graph,
    Jmap,
}

impl SendKind {
    /// The kind a stored account kind names (`graph`, `jmap`; anything else
    /// sends over SMTP).
    pub fn of(kind: &str) -> SendKind {
        match kind {
            "graph" => SendKind::Graph,
            "jmap" => SendKind::Jmap,
            _ => SendKind::Smtp,
        }
    }
}

/// A JMAP session's limits, as last seen (`None`: not known).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JmapLimits {
    /// `maxSizeUpload`.
    pub upload: Option<u64>,
    /// `maxSizeAttachmentsPerEmail`.
    pub attachments: Option<u64>,
}

/// Most bytes of attachments a message may carry when it sends as `kind`, with
/// `text_len` bytes of body text and `header_len` bytes of header values
/// (subject, addresses, references).
pub fn attachment_budget(kind: SendKind, text_len: u64, header_len: u64, jmap: JmapLimits) -> u64 {
    let other = HEADER_MARGIN.saturating_add(text_len.saturating_mul(3)).saturating_add(header_len);
    let fits = |mime_budget: u64| mime_budget.saturating_sub(other) * 3 / 4 * 76 / 78;
    match kind {
        SendKind::Graph => fits(crate::graph::SEND_MAIL_LIMIT_BYTES as u64 * 3 / 4),
        SendKind::Jmap => {
            let mut limit = MAX_ATTACHMENT_BYTES;
            if let Some(upload) = jmap.upload {
                limit = limit.min(fits(upload));
            }
            if let Some(attachments) = jmap.attachments {
                limit = limit.min(attachments);
            }
            limit
        }
        SendKind::Smtp => MAX_ATTACHMENT_BYTES,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mobile engine's former `compose::attachment_limit`, written out.
    fn old_formula(kind: &str, text: u64, header: u64, upload: Option<u64>, attachments: Option<u64>) -> u64 {
        let other = 16 * 1024 + 3 * text + header;
        let fits = |b: u64| b.saturating_sub(other) * 3 / 4 * 76 / 78;
        match kind {
            "graph" => fits(4 * 1024 * 1024 * 3 / 4),
            "jmap" => {
                let mut l = 25 * 1024 * 1024;
                if let Some(u) = upload {
                    l = l.min(fits(u));
                }
                if let Some(a) = attachments {
                    l = l.min(a);
                }
                l
            }
            _ => 25 * 1024 * 1024,
        }
    }

    #[test]
    fn budget_table() {
        const MB: u64 = 1024 * 1024;
        let none = JmapLimits::default();
        let cases: [(SendKind, u64, u64, JmapLimits, u64); 9] = [
            (SendKind::Smtp, 0, 0, none, 25 * MB),
            (SendKind::Smtp, 10 * MB, 500, none, 25 * MB),
            // (3 MB - 16 KB) * 3/4 * 76/78
            (SendKind::Graph, 0, 0, none, 2_286_828),
            (SendKind::Graph, 1000, 200, none, 2_284_489),
            (SendKind::Graph, 2 * MB, 0, none, 0),
            (SendKind::Jmap, 0, 0, none, 25 * MB),
            (SendKind::Jmap, 0, 0, JmapLimits { upload: Some(10 * MB), attachments: None }, 7_650_697),
            (SendKind::Jmap, 0, 0, JmapLimits { upload: Some(50 * MB), attachments: Some(5 * MB) }, 5 * MB),
            (SendKind::Jmap, 100, 100, JmapLimits { upload: Some(1000), attachments: None }, 0),
        ];
        for (kind, text, header, jmap, want) in cases {
            assert_eq!(attachment_budget(kind, text, header, jmap), want, "{kind:?} {text} {header} {jmap:?}");
        }
    }

    #[test]
    fn budget_matches_the_engine_formula_it_replaces() {
        let kinds = [("imap", SendKind::Smtp), ("graph", SendKind::Graph), ("jmap", SendKind::Jmap)];
        let limits = [None, Some(1), Some(64 * 1024), Some(10 * 1024 * 1024), Some(100 * 1024 * 1024)];
        for (name, kind) in kinds {
            assert_eq!(SendKind::of(name), kind);
            for text in [0, 1, 4096, 1 << 20, 5 << 20] {
                for header in [0, 37, 4096] {
                    for upload in limits {
                        for attachments in limits {
                            let jmap = JmapLimits { upload, attachments };
                            assert_eq!(
                                attachment_budget(kind, text, header, jmap),
                                old_formula(name, text, header, upload, attachments),
                                "{name} {text} {header} {jmap:?}"
                            );
                        }
                    }
                }
            }
        }
    }
}
