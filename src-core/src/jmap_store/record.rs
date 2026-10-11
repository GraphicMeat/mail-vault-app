//! The `<uid>.json` record of the JMAP storage format: the message's blob id,
//! its local state (archived, trashed), its server ids on a JMAP account, and
//! an RFC 8621 Email object holding the metadata subset only. Body-part
//! properties (`bodyStructure`, `textBody`, `htmlBody`, `attachments`,
//! `bodyValues`) and `headers` are never stored: they derive from the blob.
//!
//! Flags are the Maildir letters A D F R S T, read from flag words the way
//! the vault filename builder reads them and written back the way the vault
//! filename parser returns them, so a message carries the same flags in either
//! format. The tests pin both against those two functions for every letter
//! combination. They are not called here: the `message_store_guard` ratchet
//! keeps filename code in its owner modules. D F R S are the JMAP keywords
//! `$draft`, `$flagged`, `$answered`, `$seen` (the spelling `jmap::headers`
//! uses); A and T are `local.archived` and `local.trashed`, never keywords.

use super::blobs;
use mailparse::{MailHeaderMap, ParsedMail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const FORMAT: &str = "mailvault-jmap/1";

/// `preview` length in chars, after whitespace is collapsed.
const PREVIEW_CHARS: usize = 256;

/// The Maildir letters that are JMAP keywords, and their keyword.
const LETTER_KEYWORDS: [(char, &str); 4] = [('D', "$draft"), ('F', "$flagged"), ('R', "$answered"), ('S', "$seen")];

/// Each Maildir letter and the flag word the vault filename parser returns
/// for it, in filename (sorted) order.
const LETTER_WORDS: [(char, &str); 6] =
    [('A', "archived"), ('D', "draft"), ('F', "flagged"), ('R', "replied"), ('S', "seen"), ('T', "trashed")];

/// The IMAP flags the vault filename parser appends after the words, in its order.
const IMAP_ECHOES: [(&str, &str); 3] = [("seen", "\\Seen"), ("flagged", "\\Flagged"), ("replied", "\\Answered")];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Record {
    pub format: String,
    pub uid: u32,
    pub blob: String,
    pub size: u64,
    pub local: Local,
    pub server: Option<ServerIds>,
    pub email: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
pub struct Local {
    pub archived: bool,
    pub trashed: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ServerIds {
    #[serde(rename = "emailId")]
    pub email_id: String,
    #[serde(rename = "blobId")]
    pub blob_id: String,
    #[serde(rename = "threadId")]
    pub thread_id: Option<String>,
}

/// The letter a flag gives a vault filename, read as the vault filename
/// builder reads it: the word or the letter, in any case. Anything else
/// (`\Seen`, `$junk`) gives none, as it gives a filename none.
fn letter_of(flag: &str) -> Option<char> {
    match flag.to_lowercase().as_str() {
        "archived" | "a" => Some('A'),
        "draft" | "d" => Some('D'),
        "flagged" | "f" => Some('F'),
        "replied" | "r" => Some('R'),
        "seen" | "s" => Some('S'),
        "trashed" | "t" => Some('T'),
        _ => None,
    }
}

/// The letters these flags give a vault filename: sorted, deduped.
fn letters(flags: &[String]) -> String {
    let mut letters: Vec<char> = flags.iter().filter_map(|f| letter_of(f)).collect();
    letters.sort();
    letters.dedup();
    letters.into_iter().collect()
}

fn local_for(letters: &str) -> Local {
    Local { archived: letters.contains('A'), trashed: letters.contains('T') }
}

fn keywords_for(letters: &str) -> Map<String, Value> {
    LETTER_KEYWORDS
        .iter()
        .filter(|(letter, _)| letters.contains(*letter))
        .map(|(_, keyword)| (keyword.to_string(), Value::Bool(true)))
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Message ids without angle brackets, as RFC 8621 stores them. A value
/// `msgidparse` refuses (a bare id, a trailing comment) keeps its bracketed
/// ids, or else the whole trimmed value as one id. Empty: `None`.
fn msg_ids(value: &str) -> Option<Vec<String>> {
    let ids: Vec<String> = match mailparse::msgidparse(value) {
        Ok(list) => list.iter().map(|id| id.trim().to_string()).collect(),
        Err(_) => {
            let bracketed: Vec<String> = value
                .split('<')
                .skip(1)
                .filter_map(|s| s.split_once('>').map(|(id, _)| id.trim().to_string()))
                .collect();
            if bracketed.is_empty() {
                vec![value.trim().to_string()]
            } else {
                bracketed
            }
        }
    };
    let ids: Vec<String> = ids.into_iter().filter(|id| !id.is_empty()).collect();
    (!ids.is_empty()).then_some(ids)
}

/// An address header as RFC 8621 `EmailAddress[]` (groups flattened, a blank
/// name as null). An empty value gives `[]`.
fn addresses(value: &str) -> Value {
    Value::Array(
        crate::vault_eml::parse_address_str(value)
            .into_iter()
            .map(|a| {
                let name = a.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
                serde_json::json!({ "name": name, "email": a.address })
            })
            .collect(),
    )
}

/// The Date header as a timestamp with its own offset: strict RFC 2822
/// first, then mailparse's lenient parser (read as UTC). `None` when
/// neither reads it.
fn date_parts(date: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(date) {
        return Some(dt);
    }
    let ts = mailparse::dateparse(date).ok().filter(|ts| *ts > 0)?;
    Some(chrono::DateTime::from_timestamp(ts, 0)?.fixed_offset())
}

/// RFC 8621 `sentAt`: the Date header with its own offset.
fn sent_at(date: &str) -> Option<String> {
    Some(date_parts(date)?.to_rfc3339_opts(chrono::SecondsFormat::Secs, false))
}

/// RFC 8621 `UTCDate` (`Z` suffix) of the Date header.
fn utc_date(date: &str) -> Option<String> {
    Some(date_parts(date)?.with_timezone(&chrono::Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

fn collect_leaves<'a, 'b>(part: &'b ParsedMail<'a>, out: &mut Vec<&'b ParsedMail<'a>>) {
    if part.subparts.is_empty() {
        out.push(part);
    } else {
        for sub in &part.subparts {
            collect_leaves(sub, out);
        }
    }
}

fn is_attachment_disposition(part: &ParsedMail) -> bool {
    part.get_content_disposition().disposition == mailparse::DispositionType::Attachment
}

/// `hasAttachment`: a leaf with `disposition=attachment`, or a non-text,
/// non-multipart leaf.
fn has_attachment(leaves: &[&ParsedMail]) -> bool {
    leaves.iter().any(|part| {
        let mime = part.ctype.mimetype.to_ascii_lowercase();
        is_attachment_disposition(part) || (!mime.starts_with("text/") && !mime.starts_with("multipart/"))
    })
}

/// `preview`: the first text/plain part (else the first text/html part,
/// tags stripped) that is not an attachment, whitespace collapsed to single
/// spaces, cut at 256 chars.
fn preview(leaves: &[&ParsedMail]) -> String {
    let body = |mime: &str| {
        leaves
            .iter()
            .find(|p| p.ctype.mimetype.eq_ignore_ascii_case(mime) && !is_attachment_disposition(p))
            .and_then(|p| p.get_body().ok())
    };
    let text = body("text/plain")
        .or_else(|| body("text/html").map(|html| crate::search_index::text::html_to_text(&html)))
        .unwrap_or_default();
    text.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(PREVIEW_CHARS).collect()
}

/// The record for message `uid` of mailbox `vault_dir` with bytes `raw`.
///
/// - `blob` and `email.blobId`: `blobs::blob_id(raw)`, also on a JMAP account
///   (the server's blob id lives in `server`).
/// - `email.id`: the server's `emailId` when `server` is given, else
///   `L<uid>-<first 12 hex of the blob hash>`.
/// - `email.threadId`: the server's `threadId` when given, else `T` + the
///   first 12 hex of sha256 of the root message id (first References id, else
///   first In-Reply-To id, else the own Message-ID), else `T` + the first 12
///   hex of the blob hash (a message with no ids is its own thread).
/// - `email.receivedAt`: `received_at` verbatim, else the Date header at UTC,
///   else `null` (the caller fills in the file mtime).
/// - `flags`: only the letters a vault filename keeps (A D F R S T).
pub fn build(
    uid: u32,
    vault_dir: &str,
    raw: &[u8],
    flags: &[String],
    received_at: Option<&str>,
    server: Option<ServerIds>,
) -> Result<Record, String> {
    let parsed = mailparse::parse_mail(raw).map_err(|e| format!("jmap record: failed to parse email: {e}"))?;
    let blob = blobs::blob_id(raw);
    let blob_hex = sha256_hex(raw);
    let headers = &parsed.headers;
    let header = |name: &str| headers.get_first_value(name).map(|v| v.trim().to_string());

    let message_id = header("Message-ID").and_then(|v| msg_ids(&v));
    let in_reply_to = header("In-Reply-To").and_then(|v| msg_ids(&v));
    let references = header("References").and_then(|v| msg_ids(&v));
    let date = header("Date").filter(|d| !d.is_empty());

    let id = match &server {
        Some(ids) => ids.email_id.clone(),
        None => format!("L{uid}-{}", &blob_hex[..12]),
    };
    let root_id = references
        .as_ref()
        .and_then(|ids| ids.first())
        .or_else(|| in_reply_to.as_ref().and_then(|ids| ids.first()))
        .or_else(|| message_id.as_ref().and_then(|ids| ids.first()));
    let thread_id = server.as_ref().and_then(|ids| ids.thread_id.clone()).unwrap_or_else(|| match root_id {
        Some(root) => format!("T{}", &sha256_hex(root.as_bytes())[..12]),
        None => format!("T{}", &blob_hex[..12]),
    });
    let received = received_at.map(str::to_string).or_else(|| date.as_deref().and_then(utc_date));
    let sent = date.as_deref().and_then(sent_at);

    let mut leaves = Vec::new();
    collect_leaves(&parsed, &mut leaves);

    let letters = letters(flags);
    let mut mailbox_ids = Map::new();
    mailbox_ids.insert(vault_dir.to_string(), Value::Bool(true));
    let ids_value = |ids: Option<Vec<String>>| ids.map(Value::from).unwrap_or(Value::Null);

    let mut email = Map::new();
    email.insert("id".into(), Value::String(id));
    email.insert("blobId".into(), Value::String(blob.clone()));
    email.insert("threadId".into(), Value::String(thread_id));
    email.insert("mailboxIds".into(), Value::Object(mailbox_ids));
    email.insert("keywords".into(), Value::Object(keywords_for(&letters)));
    email.insert("size".into(), Value::from(raw.len() as u64));
    email.insert("receivedAt".into(), received.map(Value::String).unwrap_or(Value::Null));
    email.insert("messageId".into(), ids_value(message_id));
    email.insert("inReplyTo".into(), ids_value(in_reply_to));
    email.insert("references".into(), ids_value(references));
    // The on-disk format's shape: `sender` is `null` when absent, the address
    // lists are `[]` when absent.
    let list = |name: &str| addresses(&headers.get_first_value(name).unwrap_or_default());
    email.insert("sender".into(), headers.get_first_value("Sender").map(|v| addresses(&v)).unwrap_or(Value::Null));
    email.insert("from".into(), list("From"));
    email.insert("to".into(), list("To"));
    email.insert("cc".into(), list("Cc"));
    email.insert("bcc".into(), list("Bcc"));
    email.insert("replyTo".into(), list("Reply-To"));
    email.insert("subject".into(), header("Subject").map(Value::String).unwrap_or(Value::Null));
    email.insert("sentAt".into(), sent.map(Value::String).unwrap_or(Value::Null));
    email.insert("hasAttachment".into(), Value::Bool(has_attachment(&leaves)));
    email.insert("preview".into(), Value::String(preview(&leaves)));

    Ok(Record {
        format: FORMAT.to_string(),
        uid,
        blob,
        size: raw.len() as u64,
        local: local_for(&letters),
        server,
        email: Value::Object(email),
    })
}

/// The record's flags exactly as the vault filename parser returns them for
/// the `.eml` filename carrying the same letters: the words in A D F R S T
/// order, then `\Seen`, `\Flagged`, `\Answered` for the words present.
pub fn flags_of(rec: &Record) -> Vec<String> {
    let on = |keyword: &str| {
        rec.email["keywords"]
            .as_object()
            .is_some_and(|map| map.iter().any(|(k, v)| k.eq_ignore_ascii_case(keyword) && v.as_bool() == Some(true)))
    };
    let has = |letter: char| match letter {
        'A' => rec.local.archived,
        'T' => rec.local.trashed,
        _ => LETTER_KEYWORDS.iter().any(|(l, keyword)| *l == letter && on(keyword)),
    };
    let mut flags: Vec<String> =
        LETTER_WORDS.iter().filter(|(letter, _)| has(*letter)).map(|(_, word)| word.to_string()).collect();
    for (word, imap) in IMAP_ECHOES {
        if flags.iter().any(|f| f == word) {
            flags.push(imap.to_string());
        }
    }
    flags
}

/// `rec` with its flags replaced by `flags` (read as `build` reads them): the
/// four system keywords and `local` are rewritten, any other keyword the
/// record holds (a server keyword such as `$junk`) is kept.
pub fn with_flags(rec: &Record, flags: &[String]) -> Record {
    let letters = letters(flags);
    let mut out = rec.clone();
    out.local = local_for(&letters);
    let mut keywords = rec.email["keywords"].as_object().cloned().unwrap_or_default();
    keywords.retain(|k, _| !LETTER_KEYWORDS.iter().any(|(_, keyword)| k.eq_ignore_ascii_case(keyword)));
    keywords.extend(keywords_for(&letters));
    if let Some(email) = out.email.as_object_mut() {
        email.insert("keywords".into(), Value::Object(keywords));
    }
    out
}

/// A record read back from `<uid>.json`. Refuses a `format` other than
/// `FORMAT` (checked before the shape, so a future format reads as unknown
/// rather than malformed), a malformed `blob` id, and a non-object `email`.
pub fn parse(bytes: &[u8]) -> Result<Record, String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|e| format!("jmap record: {e}"))?;
    match value.get("format").and_then(Value::as_str) {
        Some(FORMAT) => {}
        other => return Err(format!("jmap record: unknown format {:?}", other.unwrap_or(""))),
    }
    let rec: Record = serde_json::from_value(value).map_err(|e| format!("jmap record: {e}"))?;
    if !blobs::is_valid_id(&rec.blob) {
        return Err(format!("jmap record: invalid blob id {:?}", rec.blob));
    }
    if !rec.email.is_object() {
        return Err("jmap record: email is not an object".to_string());
    }
    Ok(rec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    /// Plain text, one Message-ID, no Date.
    const SIMPLE: &[u8] =
        b"From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\nMessage-ID: <simple@example.com>\r\n\r\nbody\r\n";

    /// A thread root.
    const ROOT: &[u8] = b"From: Bob <bob@example.com>\r\nTo: alice@example.com\r\nSubject: Report?\r\n\
Date: Wed, 30 Sep 2026 08:00:00 +0000\r\nMessage-ID: <root@example.com>\r\n\r\nSend the report.\r\n";

    /// A reply to ROOT with a PDF attachment.
    const REPLY_PDF: &[u8] = b"From: Alice Example <alice@example.com>\r\n\
To: Bob <bob@example.com>, carol@example.com\r\n\
Cc: Dave <dave@example.com>\r\n\
Subject: Quarterly report\r\n\
Date: Thu, 01 Oct 2026 09:59:58 +0200\r\n\
Message-ID: <msg2@example.com>\r\n\
In-Reply-To: <msg1@example.com>\r\n\
References: <root@example.com> <msg1@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"b1\"\r\n\
\r\n\
--b1\r\n\
Content-Type: text/plain; charset=utf-8\r\n\
\r\n\
Hello Bob,\r\n\
\r\n\
   the report   is attached.\r\n\
--b1\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--b1--\r\n";

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn keys(v: &Value) -> BTreeSet<String> {
        v.as_object().expect("object").keys().cloned().collect()
    }

    #[test]
    fn flags_round_trip_matches_filename_parser_for_every_letter_combo() {
        let blank = build(1, "INBOX", SIMPLE, &[], None, None).unwrap();
        for mask in 0u32..64 {
            let letters: Vec<String> = "ADFRST"
                .chars()
                .enumerate()
                .filter(|(i, _)| mask & (1 << i) != 0)
                .map(|(_, c)| c.to_string())
                .collect();
            let name = crate::vault_files::build_maildir_filename(1, &letters);
            let expected = crate::vault_eml::parse_flags_from_filename(&name);

            assert_eq!(flags_of(&build(1, "INBOX", SIMPLE, &expected, None, None).unwrap()), expected, "{name}");
            assert_eq!(flags_of(&build(1, "INBOX", SIMPLE, &letters, None, None).unwrap()), expected, "{name}");
            assert_eq!(flags_of(&with_flags(&blank, &expected)), expected, "{name}");
            let rec = with_flags(&blank, &expected);
            assert_eq!(flags_of(&parse(&serde_json::to_vec(&rec).unwrap()).unwrap()), expected, "{name}");
        }
    }

    #[test]
    fn flag_spellings_read_as_the_filename_builder_reads_them() {
        let spellings = [
            "seen", "SEEN", "Seen", "s", "S", "\\Seen", "\\seen", "$seen", "archived", "Archived", "a", "draft", "D",
            "flagged", "F", "replied", "R", "\\Answered", "answered", "trashed", "T", "deleted", "$junk", "",
        ];
        for spelling in spellings {
            let flags = strings(&[spelling]);
            let name = crate::vault_files::build_maildir_filename(1, &flags);
            let expected = crate::vault_eml::parse_flags_from_filename(&name);
            assert_eq!(flags_of(&build(1, "INBOX", SIMPLE, &flags, None, None).unwrap()), expected, "{spelling:?}");
        }
        let mixed = strings(&["S", "seen", "Flagged", "\\Flagged", "t", "t"]);
        let name = crate::vault_files::build_maildir_filename(1, &mixed);
        let expected = crate::vault_eml::parse_flags_from_filename(&name);
        assert_eq!(flags_of(&build(1, "INBOX", SIMPLE, &mixed, None, None).unwrap()), expected);
        assert_eq!(expected, strings(&["flagged", "seen", "trashed", "\\Seen", "\\Flagged"]));
    }

    #[test]
    fn letters_a_and_t_are_local_state_and_the_rest_are_plan_a_keywords() {
        let rec = build(1, "INBOX", SIMPLE, &strings(&["archived", "draft", "flagged", "replied", "seen", "trashed"]), None, None).unwrap();
        assert_eq!(rec.local, Local { archived: true, trashed: true });
        assert_eq!(
            rec.email["keywords"],
            json!({ "$draft": true, "$flagged": true, "$answered": true, "$seen": true })
        );
        assert_eq!(
            crate::jmap::headers::keywords_to_flags(&rec.email["keywords"]),
            strings(&["\\Seen", "\\Answered", "\\Flagged", "\\Draft"])
        );
        let none = build(1, "INBOX", SIMPLE, &strings(&["\\Seen", "$junk", "unknown"]), None, None).unwrap();
        assert_eq!(none.email["keywords"], json!({}), "a vault filename keeps none of these");
        assert_eq!(none.local, Local::default());
    }

    #[test]
    fn with_flags_keeps_server_keywords_and_rewrites_the_system_ones() {
        let mut rec = build(1, "INBOX", SIMPLE, &strings(&["seen", "archived"]), None, None).unwrap();
        rec.email["keywords"]["$junk"] = json!(true);
        rec.email["keywords"]["$Flagged"] = json!(true);

        let out = with_flags(&rec, &strings(&["replied", "trashed"]));

        assert_eq!(out.email["keywords"], json!({ "$junk": true, "$answered": true }));
        assert_eq!(out.local, Local { archived: false, trashed: true });
        assert_eq!(flags_of(&out), strings(&["replied", "trashed", "\\Answered"]));
        assert_eq!(out.email["id"], rec.email["id"]);
        assert_eq!(out.blob, rec.blob);
    }

    #[test]
    fn build_fills_header_metadata() {
        let rec = build(7, "INBOX", REPLY_PDF, &strings(&["seen", "\\Seen"]), None, None).unwrap();
        let e = &rec.email;
        assert_eq!(rec.format, FORMAT);
        assert_eq!(rec.uid, 7);
        assert_eq!(rec.size, REPLY_PDF.len() as u64);
        assert_eq!(rec.blob, blobs::blob_id(REPLY_PDF));
        assert_eq!(rec.server, None);
        assert_eq!(e["blobId"], json!(rec.blob));
        assert_eq!(e["size"], json!(REPLY_PDF.len()));
        assert_eq!(e["mailboxIds"], json!({ "INBOX": true }));
        assert_eq!(e["keywords"], json!({ "$seen": true }));
        assert_eq!(e["from"], json!([{ "name": "Alice Example", "email": "alice@example.com" }]));
        assert_eq!(
            e["to"],
            json!([{ "name": "Bob", "email": "bob@example.com" }, { "name": null, "email": "carol@example.com" }])
        );
        assert_eq!(e["cc"], json!([{ "name": "Dave", "email": "dave@example.com" }]));
        assert_eq!(e["bcc"], json!([]), "absent list: [] as the on-disk format shows");
        assert_eq!(e["replyTo"], json!([]));
        assert_eq!(e["sender"], Value::Null, "absent sender: null as the on-disk format shows");
        assert_eq!(e["subject"], json!("Quarterly report"));
        assert_eq!(e["messageId"], json!(["msg2@example.com"]));
        assert_eq!(e["inReplyTo"], json!(["msg1@example.com"]));
        assert_eq!(e["references"], json!(["root@example.com", "msg1@example.com"]));
        assert_eq!(e["sentAt"], json!("2026-10-01T09:59:58+02:00"));
        assert_eq!(e["receivedAt"], json!("2026-10-01T07:59:58Z"));
        assert_eq!(e["hasAttachment"], json!(true));
        assert_eq!(e["preview"], json!("Hello Bob, the report is attached."));
        assert!(e.get("bodyStructure").is_none());
    }

    #[test]
    fn record_json_matches_the_on_disk_format_field_names() {
        let server = ServerIds { email_id: "M1".into(), blob_id: "G1".into(), thread_id: Some("T1".into()) };
        for server in [None, Some(server)] {
            let rec = build(4182, "INBOX", REPLY_PDF, &strings(&["seen", "archived"]), None, server).unwrap();
            let v = serde_json::to_value(&rec).unwrap();
            assert_eq!(
                keys(&v),
                ["format", "uid", "blob", "size", "local", "server", "email"].iter().map(|s| s.to_string()).collect()
            );
            assert_eq!(v["format"], json!("mailvault-jmap/1"));
            assert_eq!(keys(&v["local"]), ["archived", "trashed"].iter().map(|s| s.to_string()).collect());
            match &rec.server {
                None => assert_eq!(v["server"], Value::Null),
                Some(_) => assert_eq!(
                    keys(&v["server"]),
                    ["emailId", "blobId", "threadId"].iter().map(|s| s.to_string()).collect()
                ),
            }
            let email_keys: BTreeSet<String> = [
                "id", "blobId", "threadId", "mailboxIds", "keywords", "size", "receivedAt", "messageId",
                "inReplyTo", "references", "sender", "from", "to", "cc", "bcc", "replyTo", "subject", "sentAt",
                "hasAttachment", "preview",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect();
            assert_eq!(keys(&v["email"]), email_keys);
            for absent in ["bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues", "headers"] {
                assert!(v["email"].get(absent).is_none(), "{absent} must not be stored");
            }
        }
        let s = ServerIds { email_id: "M1".into(), blob_id: "G1".into(), thread_id: None };
        assert_eq!(serde_json::to_value(&s).unwrap(), json!({ "emailId": "M1", "blobId": "G1", "threadId": null }));
    }

    #[test]
    fn local_id_and_thread_id_are_stable() {
        let a = build(3, "INBOX", ROOT, &[], None, None).unwrap();
        let b = build(3, "INBOX", ROOT, &[], None, None).unwrap();
        assert_eq!(a.email["id"], b.email["id"]);
        assert_eq!(a.email["threadId"], b.email["threadId"]);
        let hex = format!("{:x}", Sha256::digest(ROOT));
        assert_eq!(a.email["id"], json!(format!("L3-{}", &hex[..12])));
        let root_thread = format!("T{}", &format!("{:x}", Sha256::digest(b"root@example.com"))[..12]);
        assert_eq!(a.email["threadId"], json!(root_thread));

        // References root wins.
        let reply = build(4, "INBOX", REPLY_PDF, &[], None, None).unwrap();
        assert_eq!(reply.email["threadId"], json!(root_thread));
        assert_ne!(reply.email["id"], a.email["id"]);

        // In-Reply-To only.
        let short = b"From: a@example.com\r\nMessage-ID: <r2@example.com>\r\nIn-Reply-To: <root@example.com>\r\n\r\nok\r\n";
        assert_eq!(build(5, "INBOX", short, &[], None, None).unwrap().email["threadId"], json!(root_thread));

        // No ids at all: its own thread, from the blob hash.
        let bare = b"From: a@example.com\r\nSubject: none\r\n\r\nok\r\n";
        let bare_hex = format!("{:x}", Sha256::digest(bare));
        assert_eq!(
            build(6, "INBOX", bare, &[], None, None).unwrap().email["threadId"],
            json!(format!("T{}", &bare_hex[..12]))
        );
        assert_eq!(build(6, "INBOX", bare, &[], None, None).unwrap().email["messageId"], Value::Null);
    }

    #[test]
    fn lenient_message_ids() {
        let raw = b"From: a@example.com\r\nMessage-ID: bare@example.com\r\nIn-Reply-To: <p@example.com> (sent from phone)\r\n\r\nok\r\n";
        let rec = build(1, "INBOX", raw, &[], None, None).unwrap();
        assert_eq!(rec.email["messageId"], json!(["bare@example.com"]));
        assert_eq!(rec.email["inReplyTo"], json!(["p@example.com"]));
    }

    #[test]
    fn server_ids_win_for_jmap_accounts() {
        let ids = ServerIds { email_id: "M7c1".into(), blob_id: "G88a".into(), thread_id: Some("T12".into()) };
        let rec = build(4182, "INBOX", REPLY_PDF, &[], None, Some(ids.clone())).unwrap();
        assert_eq!(rec.email["id"], json!("M7c1"));
        assert_eq!(rec.email["threadId"], json!("T12"));
        assert_eq!(rec.server, Some(ids));
        assert_eq!(rec.email["blobId"], json!(blobs::blob_id(REPLY_PDF)), "blobId is the local id, not the server's");
        assert_eq!(rec.email["blobId"], json!(rec.blob));

        let no_thread = ServerIds { email_id: "M8".into(), blob_id: "G9".into(), thread_id: None };
        let rec = build(4183, "INBOX", REPLY_PDF, &[], None, Some(no_thread)).unwrap();
        assert_eq!(rec.email["id"], json!("M8"));
        let root_thread = format!("T{}", &format!("{:x}", Sha256::digest(b"root@example.com"))[..12]);
        assert_eq!(rec.email["threadId"], json!(root_thread));
    }

    #[test]
    fn received_at_fallback_order() {
        let given = build(1, "INBOX", REPLY_PDF, &[], Some("2026-10-01T10:00:00Z"), None).unwrap();
        assert_eq!(given.email["receivedAt"], json!("2026-10-01T10:00:00Z"));
        assert_eq!(given.email["sentAt"], json!("2026-10-01T09:59:58+02:00"));

        let from_date = build(1, "INBOX", REPLY_PDF, &[], None, None).unwrap();
        assert_eq!(from_date.email["receivedAt"], json!("2026-10-01T07:59:58Z"));

        let no_date = build(1, "INBOX", SIMPLE, &[], None, None).unwrap();
        assert_eq!(no_date.email["receivedAt"], Value::Null, "caller supplies the file mtime");
        assert_eq!(no_date.email["sentAt"], Value::Null);

        // Not strict RFC 2822 (a wrong weekday): mailparse's parser reads it, at UTC.
        let loose = b"From: a@example.com\r\nDate: Mon, 01 Oct 2026 09:59:58 +0200\r\n\r\nok\r\n";
        let rec = build(1, "INBOX", loose, &[], None, None).unwrap();
        assert_eq!(rec.email["receivedAt"], json!("2026-10-01T07:59:58Z"));
        assert_eq!(rec.email["sentAt"], json!("2026-10-01T07:59:58+00:00"));

        let junk = b"From: a@example.com\r\nDate: not a date\r\n\r\nok\r\n";
        let rec = build(1, "INBOX", junk, &[], None, None).unwrap();
        assert_eq!(rec.email["receivedAt"], Value::Null);
        assert_eq!(rec.email["sentAt"], Value::Null);
    }

    #[test]
    fn preview_falls_back_to_stripped_html_and_caps_at_256_chars() {
        let html = b"From: a@example.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n\
<html><head><style>p { color: red }</style></head><body><p>Hi&nbsp;there</p><p>second   line</p></body></html>\r\n";
        let rec = build(1, "INBOX", html, &[], None, None).unwrap();
        assert_eq!(rec.email["preview"], json!("Hi there second line"));
        assert_eq!(rec.email["hasAttachment"], json!(false));

        let mut long = b"From: a@example.com\r\nContent-Type: text/plain\r\n\r\n".to_vec();
        long.extend_from_slice("word\r\n  ".repeat(100).as_bytes());
        let rec = build(1, "INBOX", &long, &[], None, None).unwrap();
        let preview = rec.email["preview"].as_str().unwrap();
        assert_eq!(preview.chars().count(), 256);
        assert!(preview.starts_with("word word word"));
        assert!(!preview.contains("  ") && !preview.contains('\n'));
    }

    #[test]
    fn has_attachment_counts_non_text_leaves_and_attachment_dispositions() {
        let inline_image = b"From: a@example.com\r\nContent-Type: multipart/related; boundary=\"r\"\r\n\r\n\
--r\r\nContent-Type: text/html\r\n\r\n<p>see <img src=\"cid:i1\"></p>\r\n\
--r\r\nContent-Type: image/png\r\nContent-ID: <i1>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n--r--\r\n";
        assert_eq!(build(1, "INBOX", inline_image, &[], None, None).unwrap().email["hasAttachment"], json!(true));

        let text_attachment = b"From: a@example.com\r\nContent-Type: multipart/mixed; boundary=\"m\"\r\n\r\n\
--m\r\nContent-Type: text/plain\r\n\r\nbody text\r\n\
--m\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n\r\nattached notes\r\n--m--\r\n";
        let rec = build(1, "INBOX", text_attachment, &[], None, None).unwrap();
        assert_eq!(rec.email["hasAttachment"], json!(true));
        assert_eq!(rec.email["preview"], json!("body text"));

        assert_eq!(build(1, "INBOX", SIMPLE, &[], None, None).unwrap().email["hasAttachment"], json!(false));
    }

    #[test]
    fn parse_rejects_unknown_format() {
        let rec = build(2, "INBOX", REPLY_PDF, &strings(&["seen", "flagged", "trashed"]), None, None).unwrap();
        let bytes = serde_json::to_vec_pretty(&rec).unwrap();
        assert_eq!(parse(&bytes).unwrap(), rec);

        let mut v = serde_json::to_value(&rec).unwrap();
        v["format"] = json!("mailvault-jmap/2");
        let err = parse(&serde_json::to_vec(&v).unwrap()).unwrap_err();
        assert!(err.contains("unknown format"), "{err}");

        let mut v = serde_json::to_value(&rec).unwrap();
        v.as_object_mut().unwrap().remove("format");
        assert!(parse(&serde_json::to_vec(&v).unwrap()).unwrap_err().contains("unknown format"));

        let mut v = serde_json::to_value(&rec).unwrap();
        v["blob"] = json!("sha256-../../etc/passwd");
        assert!(parse(&serde_json::to_vec(&v).unwrap()).unwrap_err().contains("invalid blob id"));

        let mut v = serde_json::to_value(&rec).unwrap();
        v["email"] = json!("nope");
        assert!(parse(&serde_json::to_vec(&v).unwrap()).is_err());

        assert!(parse(b"not json").is_err());
    }
}
