//! List-Unsubscribe (RFC 2369) and one-click List-Unsubscribe-Post
//! (RFC 8058), plus the two Authentication-Results claims the unsubscribe and
//! BIMI paths gate on. Pure: the daemon does the network side.

use serde::Serialize;

/// Where a message says it can be unsubscribed from.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsubscribeTargets {
    /// The https URL to POST `List-Unsubscribe=One-Click` to. Only set when
    /// the message also carries `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
    pub one_click_url: Option<String>,
    /// The first web link (https preferred), for the browser fallback.
    pub http_url: Option<String>,
    /// The first `mailto:` link, with its `?subject=` etc. intact.
    pub mailto: Option<String>,
}

pub const ONE_CLICK_BODY: &str = "List-Unsubscribe=One-Click";

/// Parse a List-Unsubscribe value (`<mailto:...>, <https://...>`) and its
/// List-Unsubscribe-Post companion. Whitespace inside the angle brackets is
/// dropped (a folded header may split a long URL across lines, RFC 2369 §2).
pub fn parse(list_unsubscribe: &str, post: Option<&str>) -> UnsubscribeTargets {
    let mut out = UnsubscribeTargets::default();
    let mut http = None;
    for chunk in list_unsubscribe.split('<').skip(1) {
        let Some(end) = chunk.find('>') else { continue };
        let uri: String = chunk[..end].chars().filter(|c| !c.is_whitespace()).collect();
        let lower = uri.to_ascii_lowercase();
        if lower.starts_with("mailto:") {
            out.mailto.get_or_insert(uri);
        } else if lower.starts_with("https://") {
            out.http_url.get_or_insert(uri);
        } else if lower.starts_with("http://") {
            http.get_or_insert(uri);
        }
    }
    let one_click = post.is_some_and(|p| p.trim().eq_ignore_ascii_case(ONE_CLICK_BODY));
    if one_click {
        out.one_click_url = out.http_url.clone();
    }
    if out.http_url.is_none() {
        out.http_url = http;
    }
    out
}

/// One `;`-separated result per method in an Authentication-Results value
/// (`mx.example; dkim=pass header.d=a.test; dmarc=pass header.from=a.test`).
fn results<'a>(auth: &'a str, method: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let want = format!("{method}=pass");
    auth.split(';').filter(move |r| {
        r.split_whitespace().next().is_some_and(|t| t.eq_ignore_ascii_case(&want))
    })
}

/// Does the receiving server claim a DKIM pass? RFC 8058 needs the
/// List-Unsubscribe headers DKIM-covered; the app cannot re-verify the
/// signature, so a pass claim from the receiving server is what it can check.
pub fn dkim_pass(auth: &str) -> bool {
    results(auth, "dkim").next().is_some()
}

/// A DMARC pass for `from_domain`: the result's `header.from`, when present,
/// must be that domain.
pub fn dmarc_pass_for(auth: &str, from_domain: &str) -> bool {
    results(auth, "dmarc").any(|r| {
        let header_from = r.split_whitespace().find_map(|t| {
            let (k, v) = t.split_once('=')?;
            k.eq_ignore_ascii_case("header.from").then_some(v)
        });
        header_from.is_none_or(|d| d.trim_end_matches('.').eq_ignore_ascii_case(from_domain))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mailto_and_https_with_one_click() {
        let t = parse(
            "<mailto:unsub@list.example.com?subject=unsubscribe>, <https://list.example.com/u/abc>",
            Some("List-Unsubscribe=One-Click"),
        );
        assert_eq!(t.mailto.as_deref(), Some("mailto:unsub@list.example.com?subject=unsubscribe"));
        assert_eq!(t.http_url.as_deref(), Some("https://list.example.com/u/abc"));
        assert_eq!(t.one_click_url.as_deref(), Some("https://list.example.com/u/abc"));
    }

    #[test]
    fn no_post_header_means_no_one_click() {
        let t = parse("<https://list.example.com/u/abc>", None);
        assert_eq!(t.one_click_url, None);
        assert_eq!(t.http_url.as_deref(), Some("https://list.example.com/u/abc"));
        assert_eq!(parse("<https://x.test/u>", Some("something else")).one_click_url, None);
    }

    #[test]
    fn one_click_never_uses_plain_http() {
        let t = parse("<http://list.example.com/u>", Some(" List-Unsubscribe=One-Click "));
        assert_eq!(t.one_click_url, None);
        assert_eq!(t.http_url.as_deref(), Some("http://list.example.com/u"));
    }

    #[test]
    fn https_wins_over_an_earlier_http_link() {
        let t = parse("<http://a.test/u>, <https://b.test/u>", Some("List-Unsubscribe=One-Click"));
        assert_eq!(t.http_url.as_deref(), Some("https://b.test/u"));
        assert_eq!(t.one_click_url.as_deref(), Some("https://b.test/u"));
    }

    #[test]
    fn folded_whitespace_inside_brackets_is_dropped() {
        let t = parse("<https://list.example.com/unsubscribe?\r\n id=1234&\r\n\tk=zz>,\r\n <mailto:u@x.test>", None);
        assert_eq!(t.http_url.as_deref(), Some("https://list.example.com/unsubscribe?id=1234&k=zz"));
        assert_eq!(t.mailto.as_deref(), Some("mailto:u@x.test"));
    }

    #[test]
    fn first_of_each_kind_wins_and_junk_is_ignored() {
        let t = parse("<ftp://x.test>, <mailto:a@x.test>, <mailto:b@x.test>, <https://1.test>, <https://2.test>, <broken", None);
        assert_eq!(t.mailto.as_deref(), Some("mailto:a@x.test"));
        assert_eq!(t.http_url.as_deref(), Some("https://1.test"));
        assert_eq!(parse("", None), UnsubscribeTargets::default());
        assert_eq!(parse("no brackets at all", None), UnsubscribeTargets::default());
    }

    #[test]
    fn dkim_pass_reads_the_result_not_a_comment() {
        assert!(dkim_pass("mx.google.com;\r\n dkim=pass header.i=@list.test header.s=s1; spf=pass"));
        assert!(dkim_pass("mx.test; spf=pass smtp.mailfrom=a.test;DKIM=Pass header.d=a.test"));
        assert!(!dkim_pass("mx.test; dkim=fail (bad sig) header.d=a.test; spf=pass"));
        assert!(!dkim_pass("mx.test; spf=pass (dkim=pass was not checked)"));
        assert!(!dkim_pass(""));
    }

    #[test]
    fn dmarc_pass_must_match_the_from_domain() {
        let auth = "mx.test; dkim=pass header.d=brand.test; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=brand.test";
        assert!(dmarc_pass_for(auth, "brand.test"));
        assert!(dmarc_pass_for(auth, "BRAND.test"));
        assert!(!dmarc_pass_for(auth, "other.test"));
        assert!(dmarc_pass_for("mx.test; dmarc=pass action=none", "brand.test"));
        assert!(!dmarc_pass_for("mx.test; dmarc=fail header.from=brand.test", "brand.test"));
        assert!(!dmarc_pass_for("mx.test; dmarc=bestguesspass header.from=brand.test", "brand.test"));
    }
}
