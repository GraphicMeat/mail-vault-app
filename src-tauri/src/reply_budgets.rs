//! Reading `src-daemon/methods.json` into reply budgets. Shared by the shell
//! (`rpc_proxy::reply_timeout`) and `build.rs`, which refuses to build with a
//! file this cannot read: a release build aborts on a panic, and an unread
//! table would otherwise first fail on the app's first daemon call.

/// `methods.json` rows to budgets. A row without `replySecs` is an error,
/// never a silent "no budget".
pub fn parse_reply_budgets(
    json: &str,
) -> Result<std::collections::HashMap<String, Option<std::time::Duration>>, String> {
    let rows: Vec<serde_json::Value> = serde_json::from_str(json).map_err(|e| e.to_string())?;
    rows.iter()
        .map(|row| {
            let name = row["name"].as_str().ok_or_else(|| format!("row without a name: {row}"))?;
            let budget = match row.get("replySecs") {
                None => return Err(format!("{name}: no replySecs")),
                Some(serde_json::Value::Null) => None,
                Some(v) => Some(std::time::Duration::from_secs(
                    v.as_u64().ok_or_else(|| format!("{name}: replySecs is not whole seconds"))?,
                )),
            };
            Ok((name.to_owned(), budget))
        })
        .collect()
}
