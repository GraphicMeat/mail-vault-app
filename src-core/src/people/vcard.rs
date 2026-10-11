//! A small vCard 3.0/4.0 reader and writer that keeps what it does not
//! understand: every content line is held verbatim as (group, name, params,
//! value), so an edit rewrites only the lines it means to change.
use crate::people::message_addr::normalize;

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
    v.replace('\\', "\\\\").replace('\n', "\\n").replace(',', "\\,").replace(';', "\;")
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
        self.lines.insert(0, Line { group: None, name: "FN".into(), params: String::new(), value: escape(name) });
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
}
