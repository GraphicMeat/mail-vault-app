//! A small vCard 3.0/4.0 reader and writer that keeps what it does not
//! understand: every content line is held verbatim as (group, name, params,
//! value), so an edit rewrites only the lines it means to change.
use crate::people::dedupe::{norm_name, phone_tail};
use crate::people::message_addr::normalize;
use crate::people::journal::{self, Step};
use crate::people::model::{new_id, now_ms, RecordRow};
use crate::people::store::{create_person_steps, find_person_by_address, get_card, list, reindex, NewPerson, Sort};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::json;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Line {
    pub group: Option<String>,
    pub name: String,
    pub params: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct VCard {
    pub lines: Vec<Line>,
}

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut it = v.chars();
    while let Some(c) = it.next() {
        if c != '\\' { out.push(c); continue; }
        match it.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(o) => out.push(o),
            None => out.push('\\'),
        }
    }
    out
}

fn escape(v: &str) -> String {
    v.replace('\\', "\\\\").replace('\n', "\\n").replace(',', "\\,").replace(';', "\\;")
}

/// First ':' that is not inside a double-quoted parameter value.
fn value_colon(l: &str) -> Option<usize> {
    let mut quoted = false;
    for (i, c) in l.char_indices() {
        match c { '"' => quoted = !quoted, ':' if !quoted => return Some(i), _ => {} }
    }
    None
}

fn parse_line(l: &str) -> Option<Line> {
    let colon = value_colon(l)?;
    let (head, value) = (&l[..colon], &l[colon + 1..]);
    let (name_part, params) = match head.find(';') { Some(i) => (&head[..i], &head[i + 1..]), None => (head, "") };
    let (group, name) = match name_part.rfind('.') {
        Some(i) => (Some(name_part[..i].to_string()), &name_part[i + 1..]),
        None => (None, name_part),
    };
    if name.is_empty() { return None; }
    Some(Line { group, name: name.to_ascii_uppercase(), params: params.to_string(), value: value.to_string() })
}

fn type_label(params: &str) -> String {
    for p in params.split(';') {
        let (k, v) = match p.split_once('=') { Some((k, v)) => (k.to_ascii_uppercase(), v), None => ("TYPE".to_string(), p) };
        if k == "TYPE" {
            if let Some(t) = v.split(',').map(|t| t.trim().trim_matches('"').to_lowercase())
                .find(|t| !t.is_empty() && t != "internet" && t != "pref" && t != "voice") {
                return t;
            }
        }
    }
    String::new()
}

fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for c in line.chars() {
        let w = c.len_utf8();
        if count + w > 75 { out.push_str("\r\n "); count = 1; }
        out.push(c);
        count += w;
    }
    out
}

impl VCard {
    pub fn parse_all(text: &str) -> Vec<VCard> {
        let text = text.trim_start_matches('\u{feff}');
        let mut logical: Vec<String> = Vec::new();
        for raw in text.split('\n') {
            let raw = raw.strip_suffix('\r').unwrap_or(raw);
            if (raw.starts_with(' ') || raw.starts_with('\t')) && !logical.is_empty() {
                logical.last_mut().unwrap().push_str(&raw[1..]);
            } else {
                logical.push(raw.to_string());
            }
        }
        let mut cards = Vec::new();
        let mut cur: Option<VCard> = None;
        for l in logical {
            let t = l.trim();
            if t.eq_ignore_ascii_case("BEGIN:VCARD") { cur = Some(VCard::default()); continue; }
            if t.eq_ignore_ascii_case("END:VCARD") { if let Some(c) = cur.take() { cards.push(c); } continue; }
            let Some(card) = cur.as_mut() else { continue };
            if t.is_empty() { continue; }
            if let Some(line) = parse_line(&l) { card.lines.push(line); }
        }
        cards
    }

    pub fn new_card(name: &str, emails: &[String], phones: &[String], org: &str) -> VCard {
        let mut c = VCard::default();
        let mk = |n: &str, p: &str, v: String| Line { group: None, name: n.into(), params: p.into(), value: v };
        c.lines.push(mk("VERSION", "", "3.0".into()));
        c.lines.push(mk("FN", "", escape(name)));
        c.lines.push(mk("N", "", format!("{};;;;", escape(name))));
        for e in emails { c.lines.push(mk("EMAIL", "TYPE=INTERNET", e.clone())); }
        for p in phones { c.lines.push(mk("TEL", "", escape(p))); }
        if !org.is_empty() { c.lines.push(mk("ORG", "", escape(org))); }
        c
    }

    fn first(&self, name: &str) -> Option<&Line> { self.lines.iter().find(|l| l.name == name) }

    pub fn fn_name(&self) -> String {
        if let Some(l) = self.first("FN") { let v = unescape(&l.value); if !v.trim().is_empty() { return v.trim().to_string(); } }
        if let Some(l) = self.first("N") {
            let parts: Vec<String> = l.value.split(';').map(unescape).collect();
            let family = parts.first().cloned().unwrap_or_default();
            let given = parts.get(1).cloned().unwrap_or_default();
            return format!("{given} {family}").trim().to_string();
        }
        String::new()
    }

    /// The name a person is listed by: the card's name, else its first email
    /// address, else its first phone number, so a row is never blank.
    pub fn display_name(&self) -> String {
        let name = self.fn_name();
        if !name.is_empty() { return name; }
        self.emails().into_iter().next().map(|(a, _)| a).or_else(|| self.phones().into_iter().next().map(|(n, _)| n)).unwrap_or_default()
    }

    pub fn emails(&self) -> Vec<(String, String)> {
        self.lines.iter().filter(|l| l.name == "EMAIL")
            .filter_map(|l| normalize(&unescape(&l.value)).map(|a| (a, type_label(&l.params)))).collect()
    }

    pub fn phones(&self) -> Vec<(String, String)> {
        self.lines.iter().filter(|l| l.name == "TEL")
            .map(|l| (unescape(&l.value).trim().to_string(), type_label(&l.params))).filter(|(n, _)| !n.is_empty()).collect()
    }

    pub fn org(&self) -> String {
        self.first("ORG").map(|l| unescape(l.value.split(';').next().unwrap_or(""))).unwrap_or_default()
    }

    pub fn note(&self) -> String { self.first("NOTE").map(|l| unescape(&l.value)).unwrap_or_default() }

    pub fn set_emails(&mut self, wanted: &[String]) {
        let old: Vec<Line> = self.lines.iter().filter(|l| l.name == "EMAIL").cloned().collect();
        self.lines.retain(|l| l.name != "EMAIL");
        for a in wanted {
            let kept = old.iter().find(|l| normalize(&unescape(&l.value)).as_deref() == Some(a.as_str()));
            self.lines.push(kept.cloned().unwrap_or_else(|| Line { group: None, name: "EMAIL".into(), params: "TYPE=INTERNET".into(), value: a.clone() }));
        }
    }

    pub fn set_phones(&mut self, wanted: &[String]) {
        let old: Vec<Line> = self.lines.iter().filter(|l| l.name == "TEL").cloned().collect();
        self.lines.retain(|l| l.name != "TEL");
        for p in wanted {
            let kept = old.iter().find(|l| unescape(&l.value).trim() == p.trim());
            self.lines.push(kept.cloned().unwrap_or_else(|| Line { group: None, name: "TEL".into(), params: String::new(), value: escape(p) }));
        }
    }

    pub fn set_org(&mut self, org: &str) {
        self.lines.retain(|l| l.name != "ORG");
        if !org.trim().is_empty() { self.lines.push(Line { group: None, name: "ORG".into(), params: String::new(), value: escape(org.trim()) }); }
    }

    pub fn set_fn(&mut self, name: &str) {
        self.lines.retain(|l| l.name != "FN");
        let at = if self.lines.first().is_some_and(|l| l.name == "VERSION") { 1 } else { 0 };
        self.lines.insert(at, Line { group: None, name: "FN".into(), params: String::new(), value: escape(name) });
        if self.first("N").is_none() { self.lines.push(Line { group: None, name: "N".into(), params: String::new(), value: format!("{};;;;", escape(name)) }); }
    }

    /// A boolean marker line such as `X-MAILVAULT-VIP:1`.
    pub fn flag(&self, name: &str) -> bool {
        self.first(name).map(|l| matches!(l.value.trim(), "1" | "true" | "TRUE" | "yes")).unwrap_or(false)
    }

    pub fn set_flag(&mut self, name: &str, on: bool) {
        self.lines.retain(|l| l.name != name);
        if on { self.lines.push(Line { group: None, name: name.into(), params: String::new(), value: "1".into() }); }
    }

    pub fn set_note(&mut self, note: &str) {
        self.lines.retain(|l| l.name != "NOTE");
        if !note.is_empty() { self.lines.push(Line { group: None, name: "NOTE".into(), params: String::new(), value: escape(note) }); }
    }

    pub fn to_text(&self) -> String {
        let mut out = String::from("BEGIN:VCARD\r\n");
        if self.first("VERSION").is_none() { out.push_str("VERSION:3.0\r\n"); }
        for l in &self.lines {
            let mut s = String::new();
            if let Some(g) = &l.group { s.push_str(g); s.push('.'); }
            s.push_str(&l.name);
            if !l.params.is_empty() { s.push(';'); s.push_str(&l.params); }
            s.push(':');
            s.push_str(&l.value);
            out.push_str(&fold(&s));
            out.push_str("\r\n");
        }
        out.push_str("END:VCARD\r\n");
        out
    }
}

/// Lowercased email addresses of every card in `raw` (a source record holds one
/// card; this rebuilds `record_address`).
pub fn addresses(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in VCard::parse_all(raw) {
        for (a, _) in c.emails() { if !out.contains(&a) { out.push(a); } }
    }
    out
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub created: usize,
    pub linked: usize,
    pub skipped: usize,
}

fn derr(e: rusqlite::Error) -> String { e.to_string() }

/// Cards per `import_cards` call. The daemon takes the custody lock once per
/// chunk, so a 10k-card Takeout file never holds it for long.
pub const IMPORT_CHUNK: usize = 200;

/// Live people by normalized name: the lookup for cards with no address.
fn people_by_name(conn: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = conn.prepare("SELECT id, display_name FROM person WHERE deleted_ms IS NULL ORDER BY id").map_err(derr)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(derr)?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (id, mut name) = row.map_err(derr)?;
        if name.trim().is_empty() {
            name = get_card(conn, &id)?.map(|c| c.display_name).unwrap_or(name);
        }
        let key = norm_name(&name);
        if !key.is_empty() {
            map.entry(key).or_default().push(id);
        }
    }
    Ok(map)
}

/// The person an email-less card is: same normalized name and, when the card has
/// phones, one number in common (last 10 digits). Two people who share only a
/// name stay two, so a card with a name and no phone matches only a person who
/// already holds that very card (this file imported before).
fn owner_by_name(conn: &Connection, names: &HashMap<String, Vec<String>>, card: &VCard) -> Result<Option<String>, String> {
    let keys: Vec<String> = card.phones().iter().map(|(n, _)| phone_tail(n)).filter(|k| !k.is_empty()).collect();
    let text = card.to_text();
    for id in names.get(&norm_name(&card.display_name())).into_iter().flatten() {
        let Some(existing) = get_card(conn, id)? else { continue };
        let hit = if keys.is_empty() {
            let mut held = false;
            for rid in &existing.record_ids {
                held |= journal::snapshot_record(conn, rid)?.is_some_and(|r| r.raw == text);
            }
            held
        } else {
            existing.phones.iter().any(|p| keys.contains(&phone_tail(&p.number)))
        };
        if hit {
            return Ok(Some(id.clone()));
        }
    }
    Ok(None)
}

/// Import already-parsed cards in ONE transaction, journaled as one entry in
/// group `grp` (a caller importing in chunks gives every chunk the same group,
/// so a single undo reverses the whole file). A card whose email already
/// belongs to a person is added as a second record of that person
/// (exact-address auto-link); a card with no email is matched to a person by
/// name and phone instead; a card that adds no name, address or phone to
/// that person, one with no name, address or phone, and a duplicate are skipped. Nothing leaves the vault.
pub fn import_cards(conn: &Connection, cards: &[VCard], grp: &str) -> Result<ImportReport, String> {
    let mut report = ImportReport::default();
    let tx = conn.unchecked_transaction().map_err(derr)?;
    let mut inverse: Vec<Step> = Vec::new();
    let mut names: Option<HashMap<String, Vec<String>>> = None;
    for card in cards {
        let emails: Vec<String> = card.emails().into_iter().map(|(a, _)| a).collect();
        if emails.is_empty() && card.fn_name().is_empty() && card.phones().is_empty() {
            report.skipped += 1;
            continue;
        }
        let mut owner = emails.iter().find_map(|a| find_person_by_address(&tx, a).ok().flatten());
        if owner.is_none() && emails.is_empty() {
            if names.is_none() {
                names = Some(people_by_name(&tx)?);
            }
            if let Some(map) = &names {
                owner = owner_by_name(&tx, map, card)?;
            }
        }
        match owner {
            Some(pid) => {
                let existing = get_card(&tx, &pid)?.ok_or("E_NOT_FOUND: person")?;
                let known: Vec<_> = existing.emails.iter().map(|e| e.address.clone()).collect();
                // a record the person already holds (this file imported before) knows the card's name or is the card
                let (name, text) = (card.fn_name(), card.to_text());
                let mut same_name = norm_name(&name) == norm_name(&existing.display_name);
                let mut same_card = false;
                for rid in &existing.record_ids {
                    let Some(r) = journal::snapshot_record(&tx, rid)? else { continue };
                    same_card |= r.raw == text;
                    same_name |= VCard::parse_all(&r.raw).first().is_some_and(|c| norm_name(&c.fn_name()) == norm_name(&name));
                }
                let has_phone = |n: &str| existing.phones.iter().any(|p| p.number.trim() == n);
                if same_card || (same_name && emails.iter().all(|a| known.contains(a)) && card.phones().iter().all(|(n, _)| has_phone(n))) {
                    report.skipped += 1;
                    continue;
                }
                let rec = RecordRow {
                    id: new_id(),
                    account_id: String::new(),
                    source_kind: "import".into(),
                    remote_id: String::new(),
                    etag: String::new(),
                    raw: text,
                    tombstone: false,
                    fetched_ms: now_ms(),
                };
                let before = journal::snapshot_person(&tx, &pid)?.ok_or("E_NOT_FOUND: person")?;
                journal::apply(&tx, &Step::PutRecord(rec.clone()))?;
                journal::apply(&tx, &Step::SetLink { record_id: rec.id.clone(), person_id: Some(pid.clone()) })?;
                reindex(&tx, &pid)?;
                // newest first: undo restores the person's old search text and drops the record
                inverse.insert(0, Step::DropRecord { id: rec.id });
                inverse.insert(0, Step::PutPerson(before));
                report.linked += 1;
            }
            None => {
                let (pid, steps) = create_person_steps(&tx, &NewPerson { source_kind: "import".into(), raw: Some(card.to_text()), ..Default::default() })?;
                if let Some(map) = names.as_mut() {
                    let key = norm_name(&card.display_name());
                    if !key.is_empty() {
                        map.entry(key).or_default().push(pid);
                    }
                }
                for s in steps.into_iter().rev() {
                    inverse.insert(0, s);
                }
                report.created += 1;
            }
        }
    }
    if report.created + report.linked > 0 {
        journal::record_in(&tx, "import", &json!({"created": report.created, "linked": report.linked}), &inverse, grp)?;
    }
    tx.commit().map_err(derr)?;
    Ok(report)
}

/// The whole file in chunks of `IMPORT_CHUNK`, one group, one undo. Tests and
/// small tools; the daemon parses outside the lock and calls `import_cards`
/// once per chunk, each under its own `with_conn`.
pub fn import(conn: &Connection, text: &str) -> Result<ImportReport, String> {
    let grp = new_id();
    let mut total = ImportReport::default();
    for chunk in VCard::parse_all(text).chunks(IMPORT_CHUNK) {
        let r = import_cards(conn, chunk, &grp)?;
        total.created += r.created;
        total.linked += r.linked;
        total.skipped += r.skipped;
    }
    Ok(total)
}

/// One card per person. The first record is the base (so unknown lines
/// survive); name, emails, phones, org, NOTE and the VIP/pinned/blocked flags
/// are written from the resolved card, so nothing the Contacts view shows is
/// lost and a merged person's other records add their addresses and phones
/// without duplicating anything.
pub fn export(conn: &Connection, ids: Option<&[String]>) -> Result<String, String> {
    let wanted: Vec<String> = match ids {
        Some(i) => i.to_vec(),
        None => list(conn, None, false, Sort::Name, usize::MAX, 0)?.0.into_iter().map(|s| s.id).collect(),
    };
    let mut out = String::new();
    for id in wanted {
        let Some(card) = get_card(conn, &id)? else { continue };
        let mut records = Vec::new();
        for rid in &card.record_ids {
            if let Some(r) = journal::snapshot_record(conn, rid)? {
                records.push(r);
            }
        }
        let mut base = records
            .first()
            .and_then(|r| VCard::parse_all(&r.raw).into_iter().next())
            .unwrap_or_else(|| VCard::new_card(&card.display_name, &[], &[], ""));
        base.set_fn(&card.display_name);
        base.set_emails(&card.emails.iter().map(|e| e.address.clone()).collect::<Vec<_>>());
        base.set_phones(&card.phones.iter().map(|p| p.number.clone()).collect::<Vec<_>>());
        if !card.org.is_empty() {
            base.set_org(&card.org);
        }
        base.set_note(&card.notes);
        base.set_flag("X-MAILVAULT-VIP", card.vip);
        base.set_flag("X-MAILVAULT-PINNED", card.pinned);
        base.set_flag("X-MAILVAULT-BLOCKED", card.blocked);
        out.push_str(&base.to_text());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\u{feff}BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Jane Doe\r\nN:Doe;Jane;;;\r\nEMAIL;TYPE=WORK:Jane@Corp.COM\r\nEMAIL;TYPE=HOME,INTERNET:jane@home.org\r\nTEL;TYPE=CELL:+1 555 0100\r\nORG:Acme;Sales\r\nNOTE:Line one\\nLine two\\, with comma\r\nX-CUSTOM;FOO=bar:keep-me\r\nitem1.URL:https://x.io\r\nEND:VCARD\r\n";

    #[test]
    fn parses_fields_labels_and_unescapes() {
        let c = &VCard::parse_all(SAMPLE)[0];
        assert_eq!(c.fn_name(), "Jane Doe");
        assert_eq!(c.emails(), vec![("jane@corp.com".to_string(), "work".to_string()), ("jane@home.org".to_string(), "home".to_string())]);
        assert_eq!(c.phones(), vec![("+1 555 0100".to_string(), "cell".to_string())]);
        assert_eq!(c.org(), "Acme");
        assert_eq!(c.note(), "Line one\nLine two, with comma");
    }

    #[test]
    fn unfolds_lf_and_crlf_and_reads_several_cards() {
        let text = "BEGIN:VCARD\nFN:Long\n Name Here\nEMAIL:a@x.io\nEND:VCARD\nBEGIN:VCARD\r\nFN:Two\r\nEND:VCARD\r\n";
        let cards = VCard::parse_all(text);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0].fn_name(), "LongName Here");
        assert_eq!(cards[1].fn_name(), "Two");
    }

    #[test]
    fn a_colon_inside_a_quoted_parameter_does_not_split_the_line() {
        let c = &VCard::parse_all("BEGIN:VCARD\nFN:X\nX-TEST;LABEL=\"a:b\":value\nEND:VCARD").remove(0);
        let l = c.lines.iter().find(|l| l.name == "X-TEST").unwrap();
        assert_eq!(l.value, "value");
    }

    #[test]
    fn a_huge_photo_line_and_unknown_encodings_survive_untouched() {
        let photo = "A".repeat(200_000);
        let text = format!("BEGIN:VCARD\nFN:P\nPHOTO;ENCODING=b;TYPE=JPEG:{photo}\nNOTE;ENCODING=QUOTED-PRINTABLE:=C3=A9\nEND:VCARD");
        let c = VCard::parse_all(&text).remove(0);
        let out = VCard::parse_all(&c.to_text()).remove(0);
        assert_eq!(out.lines.iter().find(|l| l.name == "PHOTO").unwrap().value.len(), 200_000);
        assert_eq!(out.lines.iter().find(|l| l.name == "NOTE").unwrap().params, "ENCODING=QUOTED-PRINTABLE");
    }

    #[test]
    fn round_trip_keeps_unknown_lines_and_groups() {
        let c = VCard::parse_all(SAMPLE).remove(0);
        let back = VCard::parse_all(&c.to_text()).remove(0);
        assert_eq!(back.lines.iter().find(|l| l.name == "X-CUSTOM").unwrap().value, "keep-me");
        assert_eq!(back.lines.iter().find(|l| l.name == "URL").unwrap().group.as_deref(), Some("item1"));
    }

    #[test]
    fn to_text_folds_at_75_octets_without_splitting_a_character() {
        let c = VCard::new_card(&"é".repeat(120), &[], &[], "");
        let text = c.to_text();
        for l in text.split("\r\n") { assert!(l.len() <= 76, "{} bytes", l.len()); }
        assert_eq!(VCard::parse_all(&text)[0].fn_name(), "é".repeat(120));
    }

    #[test]
    fn set_emails_keeps_labels_of_addresses_that_stay_and_drops_the_rest() {
        let mut c = VCard::parse_all(SAMPLE).remove(0);
        c.set_emails(&["jane@corp.com".to_string(), "new@x.io".to_string()]);
        let e = c.emails();
        assert_eq!(e, vec![("jane@corp.com".to_string(), "work".to_string()), ("new@x.io".to_string(), String::new())]);
    }

    #[test]
    fn note_and_flag_lines_round_trip() {
        let mut c = VCard::new_card("N", &[], &[], "");
        c.set_note("two\nlines, with comma");
        c.set_flag("X-MAILVAULT-VIP", true);
        c.set_flag("X-MAILVAULT-BLOCKED", false);
        let back = VCard::parse_all(&c.to_text()).remove(0);
        assert_eq!(back.note(), "two\nlines, with comma");
        assert!(back.flag("X-MAILVAULT-VIP") && !back.flag("X-MAILVAULT-BLOCKED") && !back.flag("X-MAILVAULT-PINNED"));
        let mut cleared = back;
        cleared.set_note("");
        assert_eq!(cleared.note(), "");
    }

    #[test]
    fn a_card_without_fn_falls_back_to_n() {
        let c = VCard::parse_all("BEGIN:VCARD\nN:Doe;Jane;;;\nEND:VCARD").remove(0);
        assert_eq!(c.fn_name(), "Jane Doe");
    }

    #[test]
    fn garbage_input_yields_no_cards_not_a_panic() {
        assert!(VCard::parse_all("hello\nworld").is_empty());
        assert!(VCard::parse_all("BEGIN:VCARD\nFN:Unterminated").is_empty());
        assert!(VCard::parse_all("").is_empty());
    }

    #[test]
    fn addresses_reads_grouped_email_lines() {
        assert_eq!(addresses("BEGIN:VCARD\nitem2.EMAIL;type=INTERNET:A@B.io\nEND:VCARD"), vec!["a@b.io".to_string()]);
    }

    mod io {
        use super::super::*;
        use crate::custody::db;
        use crate::people::store::{create_person, get_card, NewPerson};

        fn conn() -> (tempfile::TempDir, rusqlite::Connection) {
            let t = tempfile::tempdir().unwrap();
            let c = db::open(t.path()).unwrap();
            (t, c)
        }

        #[test]
        fn import_creates_people_links_by_exact_address_and_skips_empty_cards() {
            let (_t, c) = conn();
            let existing = create_person(&c, &NewPerson { display_name: "Jane".into(), emails: vec!["jane@corp.com".into()], ..Default::default() }).unwrap();
            let text = "BEGIN:VCARD\nFN:Jane D\nEMAIL:JANE@corp.com\nEND:VCARD\nBEGIN:VCARD\nFN:New One\nEMAIL:new@x.io\nEND:VCARD\nBEGIN:VCARD\nEND:VCARD\nBEGIN:VCARD\nFN:Phone Only\nTEL:555\nEND:VCARD\n";
            let r = import(&c, text).unwrap();
            assert_eq!((r.created, r.linked, r.skipped), (2, 1, 1));
            assert_eq!(get_card(&c, &existing).unwrap().unwrap().record_ids.len(), 2, "linked as a second record, not a new person");
        }

        #[test]
        fn a_card_linked_only_for_its_name_is_not_linked_again_by_the_same_file_or_its_export() {
            let (_t, c) = conn();
            let id = create_person(&c, &NewPerson { display_name: "Jane".into(), emails: vec!["jane@corp.com".into()], ..Default::default() }).unwrap();
            let text = "BEGIN:VCARD\nFN:Jane D\nEMAIL:jane@corp.com\nEND:VCARD\n";
            assert_eq!(import(&c, text).unwrap().linked, 1);
            let again = import(&c, text).unwrap();
            assert_eq!((again.created, again.linked), (0, 0));
            let exported = import(&c, &export(&c, None).unwrap()).unwrap();
            assert_eq!((exported.created, exported.linked), (0, 0));
            assert_eq!(get_card(&c, &id).unwrap().unwrap().record_ids.len(), 2);
        }

        #[test]
        fn a_card_with_a_known_address_and_name_but_a_new_phone_is_linked() {
            let (_t, c) = conn();
            let id = create_person(&c, &NewPerson { display_name: "Jane".into(), emails: vec!["jane@corp.com".into()], phones: vec!["111".into()], ..Default::default() }).unwrap();
            let same = "BEGIN:VCARD\nFN: jane \nEMAIL:jane@corp.com\nTEL:111\nEND:VCARD\n";
            assert_eq!(import(&c, same).unwrap().skipped, 1, "same name, address and phone adds nothing");
            let r = import(&c, "BEGIN:VCARD\nFN:Jane\nEMAIL:jane@corp.com\nTEL:222\nEND:VCARD\n").unwrap();
            assert_eq!((r.created, r.linked, r.skipped), (0, 1, 0));
            assert_eq!(get_card(&c, &id).unwrap().unwrap().record_ids.len(), 2);
        }

        #[test]
        fn phone_only_and_name_only_cards_are_not_created_again_by_a_second_import() {
            let (_t, c) = conn();
            let text = "BEGIN:VCARD\nFN:Phone Only\nTEL:+1 555 0100\nEND:VCARD\nBEGIN:VCARD\nFN:  Name   ONLY \nEND:VCARD\n";
            let r = import(&c, text).unwrap();
            assert_eq!((r.created, r.linked, r.skipped), (2, 0, 0));
            let again = import(&c, text).unwrap();
            assert_eq!((again.created, again.linked, again.skipped), (0, 0, 2));
            let respaced = import(&c, "BEGIN:VCARD\nFN:phone   only\nTEL:+1 555 0100\nEND:VCARD\n").unwrap();
            assert_eq!((respaced.created, respaced.linked, respaced.skipped), (0, 0, 1));
            assert_eq!(crate::people::store::list(&c, None, false, crate::people::store::Sort::Name, 10, 0).unwrap().1, 2);
        }

        #[test]
        fn two_people_with_one_name_and_different_phones_are_not_merged() {
            let (_t, c) = conn();
            let text = "BEGIN:VCARD\nFN:Sam\nTEL:+1 555 0100\nEND:VCARD\nBEGIN:VCARD\nFN:Sam\nTEL:+1 555 0200\nEND:VCARD\n";
            assert_eq!(import(&c, text).unwrap().created, 2, "same name, other phone: another person");
            let again = import(&c, text).unwrap();
            assert_eq!((again.created, again.linked, again.skipped), (0, 0, 2));
            assert_eq!(crate::people::store::list(&c, None, false, crate::people::store::Sort::Name, 10, 0).unwrap().1, 2);
        }

        #[test]
        fn an_emailless_card_with_a_known_name_and_phone_and_a_new_number_is_linked_to_that_person() {
            let (_t, c) = conn();
            let id = create_person(&c, &NewPerson { display_name: "Sam".into(), phones: vec!["111".into()], ..Default::default() }).unwrap();
            let r = import(&c, "BEGIN:VCARD\nFN:Sam\nTEL:111\nTEL:333\nEND:VCARD\n").unwrap();
            assert_eq!((r.created, r.linked, r.skipped), (0, 1, 0));
            assert_eq!(get_card(&c, &id).unwrap().unwrap().phones.len(), 2);
        }

        #[test]
        fn a_nameless_phone_only_card_is_not_created_again_by_a_second_import() {
            let (_t, c) = conn();
            let text = "BEGIN:VCARD\nTEL:+1 555 0100\nEND:VCARD\n";
            assert_eq!(import(&c, text).unwrap().created, 1);
            let again = import(&c, text).unwrap();
            assert_eq!((again.created, again.linked, again.skipped), (0, 0, 1));
        }

        #[test]
        fn two_name_only_cards_with_one_name_and_different_details_are_two_people_and_stay_two() {
            let (_t, c) = conn();
            let text = "BEGIN:VCARD\nFN:John\nNOTE:from work\nEND:VCARD\nBEGIN:VCARD\nFN:John\nNOTE:from school\nEND:VCARD\n";
            assert_eq!(import(&c, text).unwrap().created, 2, "nothing says they are one person");
            let again = import(&c, text).unwrap();
            assert_eq!((again.created, again.linked, again.skipped), (0, 0, 2));
            assert_eq!(crate::people::store::list(&c, None, false, crate::people::store::Sort::Name, 10, 0).unwrap().1, 2);
        }

        #[test]
        fn importing_the_same_file_twice_adds_nothing_new() {
            let (_t, c) = conn();
            let text = "BEGIN:VCARD\nFN:A\nEMAIL:a@x.io\nEND:VCARD\n";
            import(&c, text).unwrap();
            let again = import(&c, text).unwrap();
            assert_eq!((again.created, again.linked), (0, 0));
            assert_eq!(again.skipped, 1);
        }

        #[test]
        fn export_round_trips_names_addresses_and_unknown_lines() {
            let (_t, c) = conn();
            import(&c, "BEGIN:VCARD\nFN:Zed\nEMAIL:z@x.io\nX-KEEP:yes\nEND:VCARD\n").unwrap();
            let out = export(&c, None).unwrap();
            assert!(out.contains("FN:Zed") && out.contains("z@x.io") && out.contains("X-KEEP:yes"));
            let (_t2, c2) = conn();
            import(&c2, &out).unwrap();
            assert_eq!(crate::people::store::list(&c2, None, false, crate::people::store::Sort::Name, 10, 0).unwrap().1, 1);
        }

        #[test]
        fn export_keeps_notes_and_flags_and_import_restores_them() {
            let (_t, c) = conn();
            let id = create_person(&c, &NewPerson { display_name: "Nora".into(), emails: vec!["n@x.io".into()], notes: "met at the fair".into(), ..Default::default() }).unwrap();
            crate::people::store::update_person(&c, &id, &crate::people::store::Patch { vip: Some(true), pinned: Some(true), notes: Some("met at the fair, again".into()), ..Default::default() }).unwrap();
            let out = export(&c, None).unwrap();
            assert!(out.contains("NOTE:met at the fair\\, again") && out.contains("X-MAILVAULT-VIP:1") && out.contains("X-MAILVAULT-PINNED:1"), "{out}");
            assert!(!out.contains("X-MAILVAULT-BLOCKED"));
            let (_t2, c2) = conn();
            import(&c2, &out).unwrap();
            let items = crate::people::store::list(&c2, None, false, crate::people::store::Sort::Name, 10, 0).unwrap().0;
            let card = get_card(&c2, &items[0].id).unwrap().unwrap();
            assert_eq!((card.notes.as_str(), card.vip, card.pinned, card.blocked), ("met at the fair, again", true, true, false));
        }

        #[test]
        fn a_big_import_runs_in_chunks_and_one_undo_reverses_all_of_it() {
            let (_t, c) = conn();
            let mut text = String::new();
            for i in 0..(IMPORT_CHUNK * 2 + 30) {
                text.push_str(&format!("BEGIN:VCARD\nFN:P{i}\nEMAIL:p{i}@x.io\nEND:VCARD\n"));
            }
            let r = import(&c, &text).unwrap();
            assert_eq!(r.created, IMPORT_CHUNK * 2 + 30);
            let entries: i64 = c.query_row("SELECT count(*) FROM person_journal", [], |r| r.get(0)).unwrap();
            assert_eq!(entries, 3, "one journal entry per chunk");
            assert_eq!(crate::people::journal::recent(&c, 10).unwrap().len(), 1, "Activity shows the import as one line");
            crate::people::journal::undo_last(&c).unwrap();
            assert_eq!(crate::people::store::list(&c, None, false, crate::people::store::Sort::Name, 10, 0).unwrap().1, 0);
        }

        #[test]
        fn export_includes_phone_only_people_and_a_merged_person_once() {
            let (_t, c) = conn();
            let a = create_person(&c, &NewPerson { display_name: "A".into(), emails: vec!["a@x.io".into()], ..Default::default() }).unwrap();
            let b = create_person(&c, &NewPerson { display_name: "B".into(), emails: vec!["b@x.io".into()], ..Default::default() }).unwrap();
            create_person(&c, &NewPerson { display_name: "Phone".into(), phones: vec!["555".into()], ..Default::default() }).unwrap();
            crate::people::merge::merge(&c, &[a.clone(), b], &a).unwrap();
            let out = export(&c, None).unwrap();
            assert_eq!(out.matches("BEGIN:VCARD").count(), 2);
            assert!(out.contains("a@x.io") && out.contains("b@x.io"));
        }
    }
}
