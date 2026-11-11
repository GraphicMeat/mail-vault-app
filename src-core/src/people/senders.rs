//! Address lists over `message_addr`. The grouping query is defined here once.
use crate::people::message_addr::normalize;
use rusqlite::types::Value as Sql;

/// `IN (...)` placeholders and bound values for the user's own addresses.
/// `x NOT IN (NULL)` is NULL, which would filter every row: an empty list is `''`.
pub(crate) fn own_list(own: &[String]) -> (String, Vec<Sql>) {
    let lc: Vec<String> = own.iter().filter_map(|a| normalize(a)).collect();
    let ph = if lc.is_empty() { "''".to_string() } else { (1..=lc.len()).map(|i| format!("?{i}")).collect::<Vec<_>>().join(",") };
    (ph, lc.into_iter().map(Sql::Text).collect())
}

/// Per-address aggregate over `message_addr`: address, newest name, messages
/// received from it, messages the user wrote to it, newest message. `filter`
/// is extra `AND ...` text on `m`, `having` an optional `HAVING ...` clause;
/// `own_ph` is the `IN (...)` placeholder list of the user's own addresses and
/// `after_n` / `lim` the parameter numbers of the paging cursor and page size.
pub(crate) fn aggregate_sql(own_ph: &str, filter: &str, having: &str, after_n: usize, lim: usize) -> String {
    let key = "m.account_id||char(31)||m.msg_key";
    format!(
        "SELECT m.address, MAX(m.name), \
           COUNT(DISTINCT CASE WHEN m.role='from' THEN {key} END), \
           COUNT(DISTINCT CASE WHEN m.role IN ('to','bcc') AND EXISTS(SELECT 1 FROM message_addr f WHERE f.account_id=m.account_id \
             AND f.mailbox_path=m.mailbox_path AND f.uid=m.uid AND f.role='from' AND f.address IN ({own_ph})) THEN {key} END), \
           MAX(m.sort_ms) \
         FROM message_addr m \
         WHERE m.counted=1 AND m.address > ?{after_n} {filter} \
         GROUP BY m.address {having} ORDER BY m.address LIMIT ?{lim}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregate_sql_builds_the_one_grouping_query_both_lists_read() {
        let sql = aggregate_sql("?1,?2", "AND m.address NOT IN (?1,?2)", "HAVING COUNT(*) > 0", 3, 4);
        assert!(sql.contains("m.address > ?3 AND m.address NOT IN (?1,?2) GROUP BY m.address HAVING COUNT(*) > 0 ORDER BY m.address LIMIT ?4"), "{sql}");
        assert!(sql.contains("f.address IN (?1,?2)"), "{sql}");
        assert!(aggregate_sql("''", "", "", 1, 2).contains("GROUP BY m.address  ORDER BY"));
    }

    #[test]
    fn own_list_binds_normalized_addresses_and_never_yields_an_empty_in() {
        let (ph, args) = own_list(&[" <ME@h.io> ".to_string(), "not an address".to_string()]);
        assert_eq!((ph.as_str(), args.len()), ("?1", 1));
        assert_eq!(own_list(&[]).0, "''");
    }
}
