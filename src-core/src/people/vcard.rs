//! Replaced in full by Task 10; this first cut exists so the journal can
//! rebuild `record_address` from a record's raw text.
pub fn addresses(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        let upper = line.to_ascii_uppercase();
        let head = upper.split(':').next().unwrap_or("");
        if head == "EMAIL" || head.starts_with("EMAIL;") || head.contains(".EMAIL") {
            if let Some((_, v)) = line.split_once(':') {
                if let Some(a) = crate::people::message_addr::normalize(v) {
                    if !out.contains(&a) { out.push(a); }
                }
            }
        }
    }
    out
}
