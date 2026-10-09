//! Checks on the plaintext transfer bundle before it is sealed. A keychain
//! that was locked or denied hands the app accounts without secrets; sealing
//! those would produce a file that silently cannot sign anyone in.
use serde_json::Value;

fn non_empty(a: &Value, key: &str) -> bool {
    a.get(key).and_then(Value::as_str).is_some_and(|s| !s.is_empty())
}

pub fn completeness_problems(bundle: &Value) -> Vec<String> {
    let Some(accounts) = bundle.get("accounts").and_then(Value::as_array) else { return vec![] };
    accounts
        .iter()
        .filter(|a| {
            let oauth = a.get("authType").and_then(Value::as_str) == Some("oauth2");
            if oauth { !non_empty(a, "oauth2RefreshToken") } else { !non_empty(a, "password") }
        })
        .map(|a| a.get("email").and_then(Value::as_str).unwrap_or("?").to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn complete_bundle_has_no_problems() {
        let b = json!({ "accounts": [
            { "email": "a@x.com", "authType": "password", "password": "pw" },
            { "email": "b@x.com", "authType": "oauth2", "oauth2RefreshToken": "rt" },
            { "email": "c@x.com", "password": "pw" }
        ]});
        assert!(completeness_problems(&b).is_empty());
    }

    #[test]
    fn missing_secrets_are_named() {
        let b = json!({ "accounts": [
            { "email": "a@x.com", "authType": "password", "password": "" },
            { "email": "b@x.com", "authType": "oauth2" },
            { "email": "c@x.com" }
        ]});
        assert_eq!(completeness_problems(&b), vec!["a@x.com", "b@x.com", "c@x.com"]);
    }

    #[test]
    fn no_accounts_is_a_problem_free_bundle() {
        assert!(completeness_problems(&json!({})).is_empty());
    }

    // A JMAP account keeps its API token (or app password) in `password`, so
    // the transfer check treats it like any password account.
    #[test]
    fn jmap_token_account_counts_as_having_a_secret() {
        let acct = serde_json::json!({"email":"a@fastmail.com","authType":"password","password":"fmu1-tok","jmapSessionUrl":"https://api.fastmail.com/jmap/session"});
        assert!(completeness_problems(&serde_json::json!({ "accounts": [acct] })).is_empty());
    }

    #[test]
    fn jmap_token_account_missing_its_token_is_named() {
        let acct = json!({"email":"a@fastmail.com","authType":"password","jmapSessionUrl":"https://api.fastmail.com/jmap/session","jmapAuth":"bearer"});
        assert_eq!(completeness_problems(&json!({ "accounts": [acct] })), vec!["a@fastmail.com"]);
    }
}
