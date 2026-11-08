//! The plain-text quote of an original, for a composer that writes plain text (mobile).
//! Desktop quotes HTML (`original_html` in the parent module); both put the same header
//! fields in the same order: original label, From, Date, Subject.
use serde_json::Value;

/// Labels of the quote's header, in the page's language. Each is one line.
pub struct QuoteLabels {
    pub original: String,
    pub from: String,
    pub date: String,
    pub subject: String,
}

/// The original's text quoted line by line (`> `), under a short header built from `header`
/// (`from {name, address}`, `subject`) and the display `date`.
pub fn quoted_text(labels: &QuoteLabels, header: &Value, date: &str, text: &str) -> String {
    let from = &header["from"];
    let mut out = format!(
        "{}\n{}: {} <{}>\n{}: {date}\n{}: {}\n\n",
        labels.original,
        labels.from,
        from["name"].as_str().unwrap_or(""),
        from["address"].as_str().unwrap_or(""),
        labels.date,
        labels.subject,
        header["subject"].as_str().unwrap_or("")
    );
    for line in text.lines() {
        out.push_str("> ");
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn labels() -> QuoteLabels {
        QuoteLabels { original: "Original message".into(), from: "From".into(), date: "Date".into(), subject: "Subject".into() }
    }

    #[test]
    fn quotes_each_line_under_the_header() {
        let h = json!({"from": {"name": "Ann", "address": "ann@x.test"}, "subject": "Plans"});
        assert_eq!(
            quoted_text(&labels(), &h, "today", "one\n\ntwo"),
            "Original message\nFrom: Ann <ann@x.test>\nDate: today\nSubject: Plans\n\n> one\n> \n> two\n"
        );
    }

    #[test]
    fn missing_fields_are_empty_and_an_empty_text_has_no_quote_lines() {
        assert_eq!(quoted_text(&labels(), &json!({}), "", ""), "Original message\nFrom:  <>\nDate: \nSubject: \n\n");
    }
}
