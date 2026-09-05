//! Command parsing and dispatch.
//!
//! Only the commands MailVault actually sends are implemented — the surface was
//! taken from a grep of `src-core`, `src-daemon` and `src-tauri`, not from RFC 3501.
//! An unimplemented command returns BAD, which is what we want: it makes new
//! client behavior visible instead of silently passing.

use crate::encode::{self, quoted, FetchItem};
use crate::scenario::Action;
use crate::state::{Mailbox, Message, ServerState};

pub struct Response {
    pub untagged: Vec<Vec<u8>>,
    /// ("OK" | "NO" | "BAD" | "BYE", human text)
    pub tagged: (String, String),
    pub close_after: bool,
}

impl Response {
    pub fn ok(text: &str) -> Self {
        Response { untagged: vec![], tagged: ("OK".into(), text.into()), close_after: false }
    }
    pub fn no(text: &str) -> Self {
        Response { untagged: vec![], tagged: ("NO".into(), text.into()), close_after: false }
    }
    pub fn bad(text: &str) -> Self {
        Response { untagged: vec![], tagged: ("BAD".into(), text.into()), close_after: false }
    }
    pub fn line(mut self, s: impl Into<String>) -> Self {
        self.untagged.push(s.into().into_bytes());
        self
    }
    pub fn raw_line(mut self, b: Vec<u8>) -> Self {
        self.untagged.push(b);
        self
    }
}

/// Per-connection state that outlives a single command.
#[derive(Default)]
pub struct Session {
    pub authenticated: bool,
    pub selected: Option<String>,
    pub read_only: bool,
}

// ── argument scanning ───────────────────────────────────────────────────────

/// Pop the next astring (quoted-string or atom) off the front of `s`.
pub fn next_arg(s: &mut &str) -> Option<String> {
    let t = s.trim_start();
    if t.is_empty() {
        *s = t;
        return None;
    }
    if let Some(rest) = t.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = rest.chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => out.push(chars.next().unwrap_or('\\')),
                '"' => break,
                _ => out.push(c),
            }
        }
        let consumed = t.len() - chars.as_str().len();
        *s = &t[consumed..];
        return Some(out);
    }
    let end = t.find(char::is_whitespace).unwrap_or(t.len());
    let (word, rest) = t.split_at(end);
    *s = rest;
    Some(word.to_string())
}

/// Pop a parenthesised group, returning its inner text.
fn next_group(s: &mut &str) -> Option<String> {
    let t = s.trim_start();
    if !t.starts_with('(') {
        return None;
    }
    let mut depth = 0usize;
    for (i, c) in t.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let inner = t[1..i].to_string();
                    *s = &t[i + 1..];
                    return Some(inner);
                }
            }
            _ => {}
        }
    }
    None
}

/// Expand a sequence-set (`1:5`, `3,7`, `2:*`) against the known UID space.
pub fn expand_set(set: &str, universe: &[u32]) -> Vec<u32> {
    let max = universe.iter().copied().max().unwrap_or(0);
    let mut out = Vec::new();
    for part in set.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.split_once(':') {
            Some((a, b)) => {
                let lo = if a == "*" { max } else { a.parse().unwrap_or(0) };
                let hi = if b == "*" { max } else { b.parse().unwrap_or(0) };
                let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                out.extend(universe.iter().copied().filter(|u| *u >= lo && *u <= hi));
            }
            None => {
                if let Ok(n) = part.parse::<u32>() {
                    if universe.contains(&n) {
                        out.push(n);
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

// ── dispatch ────────────────────────────────────────────────────────────────

pub struct Command {
    pub tag: String,
    /// Uppercase command word, `UID ` prefix stripped ("FETCH", not "UID FETCH").
    pub name: String,
    pub is_uid: bool,
    pub args: String,
    /// Literal payload that followed the command line (APPEND).
    pub literal: Vec<u8>,
}

pub fn parse_command(line: &str) -> Option<Command> {
    let mut rest = line;
    let tag = next_arg(&mut rest)?;
    let mut name = next_arg(&mut rest)?.to_uppercase();
    let is_uid = name == "UID";
    if is_uid {
        name = next_arg(&mut rest)?.to_uppercase();
    }
    Some(Command {
        tag,
        name,
        is_uid,
        args: rest.trim().to_string(),
        literal: Vec::new(),
    })
}

pub fn dispatch(
    cmd: &Command,
    state: &mut ServerState,
    sess: &mut Session,
    faults: &[Action],
) -> Response {
    match cmd.name.as_str() {
        "CAPABILITY" => Response::ok("CAPABILITY completed")
            .line(format!("* CAPABILITY {}", state.capabilities.join(" "))),
        "NOOP" => Response::ok("NOOP completed"),
        "LOGOUT" => {
            let mut r = Response::ok("LOGOUT completed").line("* BYE MockIMAP signing off");
            r.close_after = true;
            r
        }
        "LOGIN" => do_login(cmd, state, sess),
        "AUTHENTICATE" => Response::bad("AUTHENTICATE handled inline"),
        _ if !sess.authenticated => Response::no("Not authenticated"),
        "LIST" | "LSUB" => do_list(cmd, state),
        "SELECT" | "EXAMINE" => do_select(cmd, state, sess, faults),
        "STATUS" => do_status(cmd, state),
        "CREATE" => do_create(cmd, state),
        "DELETE" => do_delete(cmd, state),
        "SEARCH" => do_search(cmd, state, sess, faults),
        "FETCH" => do_fetch(cmd, state, sess, faults),
        "STORE" => do_store(cmd, state, sess),
        "COPY" => do_copy(cmd, state, sess, false),
        "MOVE" => do_copy(cmd, state, sess, true),
        "EXPUNGE" => do_expunge(cmd, state, sess),
        "APPEND" => do_append(cmd, state),
        "COMPRESS" => Response::no("COMPRESS not supported by mock"),
        other => Response::bad(&format!("Unknown command {}", other)),
    }
}

fn do_login(cmd: &Command, state: &ServerState, sess: &mut Session) -> Response {
    let mut args = cmd.args.as_str();
    let user = next_arg(&mut args).unwrap_or_default();
    let pass = next_arg(&mut args).unwrap_or_default();
    match &state.expect_login {
        Some((u, p)) if *u != user || *p != pass => {
            Response::no("[AUTHENTICATIONFAILED] Invalid credentials")
        }
        _ => {
            sess.authenticated = true;
            Response::ok("LOGIN completed")
        }
    }
}

fn do_list(cmd: &Command, state: &ServerState) -> Response {
    // `LIST "" ""` is RFC 3501 root discovery: return only the hierarchy
    // delimiter, not the mailbox list. ImapFlow uses it to derive a namespace
    // prefix when NAMESPACE isn't advertised; dumping real mailboxes here makes
    // it adopt one of them as the prefix and corrupt every non-INBOX path.
    let mut args = cmd.args.as_str();
    let _reference = next_arg(&mut args);
    if next_arg(&mut args).is_some_and(|p| p.is_empty()) {
        return Response::ok("LIST completed").line(format!(
            "* LIST (\\Noselect) {} \"\"",
            quoted(&state.delimiter)
        ));
    }

    let mut r = Response::ok("LIST completed");
    for mb in &state.mailboxes {
        r = r.line(format!(
            "* LIST ({}) {} {}",
            mb.attrs.join(" "),
            quoted(&state.delimiter),
            quoted(&mb.name)
        ));
    }
    r
}

fn do_select(cmd: &Command, state: &ServerState, sess: &mut Session, faults: &[Action]) -> Response {
    let mut args = cmd.args.as_str();
    let name = next_arg(&mut args).unwrap_or_default();
    let Some(mb) = state.find(&name) else {
        return Response::no("[NONEXISTENT] Mailbox does not exist");
    };
    if mb.attrs.iter().any(|a| a.eq_ignore_ascii_case("\\Noselect")) {
        return Response::no("[CANNOT] Mailbox is not selectable");
    }

    let uid_validity = if faults.contains(&Action::BumpUidValidity) {
        mb.uid_validity.wrapping_add(1000)
    } else {
        mb.uid_validity
    };
    let uid_next = faults
        .iter()
        .find_map(|f| match f {
            Action::LieUidNext(n) => Some(*n),
            _ => None,
        })
        .unwrap_or(mb.uid_next);

    sess.selected = Some(mb.name.clone());
    sess.read_only = cmd.name == "EXAMINE";

    let mut r = Response::ok(if sess.read_only {
        "[READ-ONLY] EXAMINE completed"
    } else {
        "[READ-WRITE] SELECT completed"
    })
    .line("* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)")
    .line("* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited")
    .line(format!("* {} EXISTS", mb.messages.len()))
    .line("* 0 RECENT")
    .line(format!("* OK [UIDVALIDITY {}] UIDs valid", uid_validity))
    .line(format!("* OK [UIDNEXT {}] Predicted next UID", uid_next));

    if state.has_cap("CONDSTORE") {
        r = r.line(format!(
            "* OK [HIGHESTMODSEQ {}] Highest modseq",
            mb.highest_modseq
        ));
    }
    r
}

fn do_status(cmd: &Command, state: &ServerState) -> Response {
    let mut args = cmd.args.as_str();
    let name = next_arg(&mut args).unwrap_or_default();
    let items = next_group(&mut args).unwrap_or_default();
    let Some(mb) = state.find(&name) else {
        return Response::no("[NONEXISTENT] Mailbox does not exist");
    };

    let values: Vec<String> = items
        .split_whitespace()
        .map(|item| {
            let v = match item.to_uppercase().as_str() {
                "MESSAGES" => mb.messages.len() as u64,
                "UIDNEXT" => mb.uid_next as u64,
                "UIDVALIDITY" => mb.uid_validity as u64,
                "UNSEEN" => mb.unseen() as u64,
                "RECENT" => 0,
                "HIGHESTMODSEQ" => mb.highest_modseq,
                _ => 0,
            };
            format!("{} {}", item.to_uppercase(), v)
        })
        .collect();

    Response::ok("STATUS completed").line(format!(
        "* STATUS {} ({})",
        quoted(&mb.name),
        values.join(" ")
    ))
}

fn do_create(cmd: &Command, state: &mut ServerState) -> Response {
    let mut args = cmd.args.as_str();
    let name = next_arg(&mut args).unwrap_or_default();
    if state.find(&name).is_some() {
        return Response::no("[ALREADYEXISTS] Mailbox already exists");
    }
    state.mailboxes.push(Mailbox::new(&name));
    Response::ok("CREATE completed")
}

fn do_delete(cmd: &Command, state: &mut ServerState) -> Response {
    let mut args = cmd.args.as_str();
    let name = next_arg(&mut args).unwrap_or_default();
    let before = state.mailboxes.len();
    state.mailboxes.retain(|m| !m.name.eq_ignore_ascii_case(&name));
    if state.mailboxes.len() == before {
        return Response::no("[NONEXISTENT] Mailbox does not exist");
    }
    Response::ok("DELETE completed")
}

fn selected<'a>(state: &'a ServerState, sess: &Session) -> Option<&'a Mailbox> {
    sess.selected.as_ref().and_then(|n| state.find(n))
}

fn selected_mut<'a>(state: &'a mut ServerState, sess: &Session) -> Option<&'a mut Mailbox> {
    let name = sess.selected.clone()?;
    state.find_mut(&name)
}

// ── SEARCH ──────────────────────────────────────────────────────────────────

fn header_value(raw: &[u8], name: &str) -> Option<String> {
    let parsed = mailparse::parse_mail(raw).ok()?;
    use mailparse::MailHeaderMap;
    parsed.headers.get_first_value(name)
}

fn matches_criteria(msg: &Message, criteria: &str) -> bool {
    let mut rest = criteria.trim();
    if rest.is_empty() || rest.eq_ignore_ascii_case("ALL") {
        return true;
    }
    let text = String::from_utf8_lossy(&msg.raw).to_lowercase();

    // All criteria are ANDed, matching how the client builds them.
    let mut s = rest;
    loop {
        let Some(key) = next_arg(&mut s) else { break };
        let ok = match key.to_uppercase().as_str() {
            "ALL" => true,
            // Clients prepend `CHARSET <name>` for non-ASCII values; matching is
            // byte-oriented here, so consume and ignore it rather than silently
            // matching nothing.
            "CHARSET" => {
                next_arg(&mut s);
                true
            }
            "UNSEEN" => !msg.has_flag("\\Seen"),
            "SEEN" => msg.has_flag("\\Seen"),
            "HEADER" => {
                let name = next_arg(&mut s).unwrap_or_default();
                let want = next_arg(&mut s).unwrap_or_default();
                header_value(&msg.raw, &name)
                    .map(|v| v.to_lowercase().contains(&want.to_lowercase()))
                    .unwrap_or(false)
            }
            "TEXT" => {
                let want = next_arg(&mut s).unwrap_or_default();
                text.contains(&want.to_lowercase())
            }
            "FROM" | "TO" | "CC" | "SUBJECT" => {
                let want = next_arg(&mut s).unwrap_or_default();
                header_value(&msg.raw, &key)
                    .map(|v| v.to_lowercase().contains(&want.to_lowercase()))
                    .unwrap_or(false)
            }
            "SINCE" | "BEFORE" => {
                let when = next_arg(&mut s).unwrap_or_default();
                match (
                    chrono::NaiveDate::parse_from_str(&when, "%d-%b-%Y"),
                    chrono::NaiveDate::parse_from_str(
                        msg.internal_date.split(' ').next().unwrap_or(""),
                        "%d-%b-%Y",
                    ),
                ) {
                    (Ok(bound), Ok(actual)) => {
                        if key.eq_ignore_ascii_case("SINCE") {
                            actual >= bound
                        } else {
                            actual < bound
                        }
                    }
                    _ => true,
                }
            }
            // Unknown key: do not silently pass — a test relying on it should fail loudly.
            _ => false,
        };
        if !ok {
            return false;
        }
        rest = s;
        if rest.trim().is_empty() {
            break;
        }
    }
    true
}

fn do_search(cmd: &Command, state: &ServerState, sess: &Session, faults: &[Action]) -> Response {
    let Some(mb) = selected(state, sess) else {
        return Response::bad("No mailbox selected");
    };

    let mut hits: Vec<u32> = mb
        .messages
        .iter()
        .filter(|m| matches_criteria(m, &cmd.args))
        .map(|m| if cmd.is_uid { m.uid } else { mb.seq_of(m.uid).unwrap_or(0) })
        .collect();

    if let Some(Action::PartialSearchResult(frac)) = faults
        .iter()
        .find(|f| matches!(f, Action::PartialSearchResult(_)))
    {
        let keep = ((hits.len() as f32) * frac).floor().max(0.0) as usize;
        hits.truncate(keep);
    }

    let joined = hits
        .iter()
        .map(|u| u.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    Response::ok("SEARCH completed").line(format!("* SEARCH {}", joined).trim_end().to_string())
}

// ── FETCH ───────────────────────────────────────────────────────────────────

fn do_fetch(cmd: &Command, state: &ServerState, sess: &Session, faults: &[Action]) -> Response {
    let Some(mb) = selected(state, sess) else {
        return Response::bad("No mailbox selected");
    };

    let mut args = cmd.args.as_str();
    let set = next_arg(&mut args).unwrap_or_default();
    let spec_and_mods = args.trim().to_string();

    // Split off a trailing modifier group, e.g. "(UID FLAGS) (CHANGEDSINCE 42)".
    let (spec, changed_since) = split_changedsince(&spec_and_mods);
    let mut items = encode::parse_fetch_spec(&spec);
    if changed_since.is_some() && !items.contains(&FetchItem::ModSeq) {
        items.push(FetchItem::ModSeq);
    }

    let universe: Vec<u32> = if cmd.is_uid {
        mb.messages.iter().map(|m| m.uid).collect()
    } else {
        (1..=mb.messages.len() as u32).collect()
    };
    let targets = expand_set(&set, &universe);

    // Server-side truncation also hits `UID FETCH 1:* (UID)`, which is how the
    // client enumerates UIDs — and a short list there is what prunes the cache.
    let targets = match faults
        .iter()
        .find(|f| matches!(f, Action::PartialSearchResult(_)))
    {
        Some(Action::PartialSearchResult(frac)) => {
            let keep = ((targets.len() as f32) * frac).floor().max(0.0) as usize;
            targets.into_iter().take(keep).collect()
        }
        _ => targets,
    };

    let mut r = Response::ok("FETCH completed");
    for id in targets {
        let msg = if cmd.is_uid {
            mb.by_uid(id)
        } else {
            mb.messages.get(id as usize - 1)
        };
        let Some(msg) = msg else { continue };

        if let Some(since) = changed_since {
            if msg.modseq <= since {
                continue;
            }
        }

        let seq = mb.seq_of(msg.uid).unwrap_or(0);
        let data = encode::render_items(msg, &items, cmd.is_uid);
        let mut line = format!("* {} FETCH (", seq).into_bytes();
        line.extend_from_slice(&data);
        line.push(b')');
        r = r.raw_line(line);
    }

    // OmitExpunged is a no-op on the wire by design: a CONDSTORE-aware client
    // that trusts CHANGEDSINCE alone will never learn about vanished UIDs.
    // The fault exists so a test can assert we do NOT rely on that.
    let _ = faults.contains(&Action::OmitExpunged);
    r
}

fn split_changedsince(spec: &str) -> (String, Option<u64>) {
    let upper = spec.to_uppercase();
    let Some(pos) = upper.find("(CHANGEDSINCE") else {
        return (spec.to_string(), None);
    };
    let head = spec[..pos].trim().to_string();
    let tail = &spec[pos..];
    let n = tail
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .ok();
    (head, n)
}

// ── STORE / COPY / MOVE / EXPUNGE / APPEND ──────────────────────────────────

fn do_store(cmd: &Command, state: &mut ServerState, sess: &Session) -> Response {
    let mut args = cmd.args.as_str();
    let set = next_arg(&mut args).unwrap_or_default();
    let op = next_arg(&mut args).unwrap_or_default().to_uppercase();
    let flags_raw = next_group(&mut args).unwrap_or_else(|| args.trim().to_string());
    let flags: Vec<String> = flags_raw.split_whitespace().map(|s| s.to_string()).collect();
    let silent = op.ends_with(".SILENT");

    let Some(mb) = selected_mut(state, sess) else {
        return Response::bad("No mailbox selected");
    };
    let universe: Vec<u32> = if cmd.is_uid {
        mb.messages.iter().map(|m| m.uid).collect()
    } else {
        (1..=mb.messages.len() as u32).collect()
    };
    let targets = expand_set(&set, &universe);
    let next_modseq = mb.highest_modseq + 1;
    mb.highest_modseq = next_modseq;

    let mut touched: Vec<u32> = Vec::new();
    for id in targets {
        let uid = if cmd.is_uid {
            id
        } else {
            match mb.messages.get(id as usize - 1) {
                Some(m) => m.uid,
                None => continue,
            }
        };
        let Some(msg) = mb.by_uid_mut(uid) else { continue };
        if op.starts_with("+FLAGS") {
            for f in &flags {
                if !msg.has_flag(f) {
                    msg.flags.push(f.clone());
                }
            }
        } else if op.starts_with("-FLAGS") {
            msg.flags.retain(|f| !flags.iter().any(|n| n.eq_ignore_ascii_case(f)));
        } else {
            msg.flags = flags.clone();
        }
        msg.modseq = next_modseq;
        touched.push(uid);
    }

    let mut r = Response::ok("STORE completed");
    if !silent {
        for uid in touched {
            let seq = mb.seq_of(uid).unwrap_or(0);
            let msg = mb.by_uid(uid).unwrap();
            r = r.line(format!(
                "* {} FETCH (UID {} FLAGS ({}))",
                seq,
                uid,
                msg.flags.join(" ")
            ));
        }
    }
    r
}

fn do_copy(cmd: &Command, state: &mut ServerState, sess: &Session, is_move: bool) -> Response {
    let mut args = cmd.args.as_str();
    let set = next_arg(&mut args).unwrap_or_default();
    let dest_name = next_arg(&mut args).unwrap_or_default();

    if state.find(&dest_name).is_none() {
        return Response::no("[TRYCREATE] Destination mailbox does not exist");
    }
    let Some(src) = selected(state, sess) else {
        return Response::bad("No mailbox selected");
    };
    let universe: Vec<u32> = src.messages.iter().map(|m| m.uid).collect();
    let targets = expand_set(&set, &universe);
    let moved: Vec<Message> = targets
        .iter()
        .filter_map(|u| src.by_uid(*u).cloned())
        .collect();
    let src_validity = src.uid_validity;
    let src_name = src.name.clone();

    let dest = state.find_mut(&dest_name).unwrap();
    let dest_validity = dest.uid_validity;
    let mut new_uids = Vec::new();
    for mut m in moved {
        m.uid = dest.uid_next;
        new_uids.push(dest.uid_next);
        dest.add(m);
    }

    let mut r = Response::ok(if is_move { "MOVE completed" } else { "COPY completed" }).line(
        format!(
            "* OK [COPYUID {} {} {}] Copied",
            dest_validity,
            targets.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(","),
            new_uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(","),
        ),
    );

    if is_move {
        let src = state.find_mut(&src_name).unwrap();
        let mut seqs: Vec<u32> = targets.iter().filter_map(|u| src.seq_of(*u)).collect();
        seqs.sort_unstable_by(|a, b| b.cmp(a)); // descending — sequence numbers shift
        src.messages.retain(|m| !targets.contains(&m.uid));
        for seq in seqs {
            r = r.line(format!("* {} EXPUNGE", seq));
        }
    }
    let _ = src_validity;
    r
}

fn do_expunge(cmd: &Command, state: &mut ServerState, sess: &Session) -> Response {
    let Some(mb) = selected_mut(state, sess) else {
        return Response::bad("No mailbox selected");
    };

    // UID EXPUNGE (RFC 4315) scopes the expunge to the given UIDs.
    let scope: Option<Vec<u32>> = if cmd.is_uid && !cmd.args.trim().is_empty() {
        let universe: Vec<u32> = mb.messages.iter().map(|m| m.uid).collect();
        Some(expand_set(cmd.args.trim(), &universe))
    } else {
        None
    };

    let doomed: Vec<u32> = mb
        .messages
        .iter()
        .filter(|m| m.has_flag("\\Deleted"))
        .filter(|m| scope.as_ref().map_or(true, |s| s.contains(&m.uid)))
        .map(|m| m.uid)
        .collect();

    let mut seqs: Vec<u32> = doomed.iter().filter_map(|u| mb.seq_of(*u)).collect();
    seqs.sort_unstable_by(|a, b| b.cmp(a));
    mb.messages.retain(|m| !doomed.contains(&m.uid));

    let mut r = Response::ok("EXPUNGE completed");
    for seq in seqs {
        r = r.line(format!("* {} EXPUNGE", seq));
    }
    r
}

fn do_append(cmd: &Command, state: &mut ServerState) -> Response {
    let mut args = cmd.args.as_str();
    let name = next_arg(&mut args).unwrap_or_default();
    // Optional flag list and optional date-time precede the literal marker.
    let _flags = next_group(&mut args);
    let date = if args.trim_start().starts_with('"') { next_arg(&mut args) } else { None };

    let Some(mb) = state.find_mut(&name) else {
        return Response::no("[TRYCREATE] Mailbox does not exist");
    };
    let uid = mb.uid_next;
    let validity = mb.uid_validity;
    let modseq = mb.highest_modseq + 1;
    let mut msg = Message::new(uid, cmd.literal.clone());
    if let Some(d) = date {
        msg.internal_date = d;
    }
    msg.modseq = modseq;
    mb.add(msg);
    mb.highest_modseq = modseq;

    Response::ok(&format!("[APPENDUID {} {}] APPEND completed", validity, uid))
}
