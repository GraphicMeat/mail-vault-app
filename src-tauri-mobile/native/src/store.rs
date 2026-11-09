//! Store purchases (plan 4 Task 6): what the shell lets through to the native store code
//! (StoreKit 2 on iOS, Play Billing 7 on Android) and what it lets back to the page.
//!
//! The native side owns the purchase and the receipt. Every new transaction (a purchase, a
//! renewal or an approval that arrives later, one left unfinished by a killed app, a Restore) goes
//! from the native code straight to the engine's `mobile.premium.verify` through the shell's own
//! export (`src-tauri-mobile/src/store.rs`), and iOS finishes a transaction only once the engine
//! says the server answered ([`answered`]). The page never sees a receipt: it gets the purchase's
//! outcome and the engine's verdict, both rebuilt here from the fields it may see.
//!
//! Nothing the native side answers is trusted: an unknown product, period or status is dropped.

use serde::Deserialize;
use serde_json::{json, Map, Value};

/// The two subscriptions, the same ids on both stores (plan Ruling 1, ledger Ruling P6).
pub const PRODUCT_IDS: [&str; 2] = ["com.mailvault.app.premium.monthly", "com.mailvault.app.premium.yearly"];

/// Whether `id` is one of ours. The shell refuses anything else before the store is asked.
pub fn product_ok(id: &str) -> bool {
    PRODUCT_IDS.contains(&id)
}

/// The engine codes that mean the billing server answered this receipt: a status reply (`Ok`),
/// `REFUSED` (it is invalid, revoked or another account's) or `INSTALL_LIMIT` (valid, but the
/// purchase is on its most installs). Only then may iOS finish the transaction. Anything else
/// (`NETWORK`, `RATE_LIMITED`, `INVALID`, `INTERNAL`, an engine that did not open) leaves it
/// unfinished, so the next launch hands it over again (Review Focus 1). Android never
/// acknowledges on the device: the server does, once it has accepted the purchase.
pub fn answered(result: Result<(), &str>) -> bool {
    match result {
        Ok(()) => true,
        Err(code) => matches!(code, "REFUSED" | "INSTALL_LIMIT"),
    }
}

/// Bounded text from the store for the page: titles and localized prices.
fn text(v: &Value, max: usize) -> Option<String> {
    let s = v.as_str()?.trim();
    if s.is_empty() || s.chars().count() > max || s.chars().any(char::is_control) {
        return None;
    }
    Some(s.to_string())
}

/// An ISO 8601 period the stores use for a subscription or an offer (`P1M`, `P1Y`, `P1W`, `P3D`,
/// `P6M`...): `P`, 1 to 3 digits, one unit.
fn period(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let rest = s.strip_prefix('P').filter(|r| r.is_ascii())?;
    let (digits, unit) = rest.split_at(rest.len().checked_sub(1)?);
    if digits.is_empty() || digits.len() > 3 || !digits.bytes().all(|b| b.is_ascii_digit()) || !matches!(unit, "D" | "W" | "M" | "Y") {
        return None;
    }
    Some(s.to_string())
}

fn intro_offer(v: &Value) -> Option<Value> {
    let mode = v["paymentMode"].as_str().filter(|m| matches!(*m, "freeTrial" | "payAsYouGo" | "payUpFront"))?;
    let count = v["periodCount"].as_u64().filter(|n| (1..=99).contains(n))?;
    Some(json!({ "price": text(&v["price"], 40)?, "period": period(&v["period"])?, "paymentMode": mode, "periodCount": count }))
}

/// The store's products as the page may see them: `{id, title, price, period: "P1M"|"P1Y",
/// introOffer?: {price, period, paymentMode, periodCount}}`, ours only, monthly first, each once.
/// A product with a field that does not read is left out (the paywall shows what it can).
pub fn products(raw: &Value) -> Vec<Value> {
    let items = raw.get("products").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for id in PRODUCT_IDS {
        let Some(p) = items.iter().find(|p| p["id"].as_str() == Some(id)) else { continue };
        let Some(period) = p["period"].as_str().filter(|s| matches!(*s, "P1M" | "P1Y")) else { continue };
        let (Some(title), Some(price)) = (text(&p["title"], 120), text(&p["price"], 40)) else { continue };
        let mut item = json!({ "id": id, "title": title, "price": price, "period": period });
        if let Some(offer) = intro_offer(&p["introOffer"]) {
            item["introOffer"] = offer;
        }
        out.push(item);
    }
    out
}

/// The engine's answer as the native side passes it back: `{answered, premium?, code?}`.
#[derive(Debug, Default, Deserialize)]
struct RawVerify {
    #[serde(default)]
    premium: Option<Value>,
    #[serde(default)]
    code: Option<String>,
}

/// The engine's status object `{premium, source, expiresMs}`, rebuilt.
fn status(v: &Value) -> Option<Value> {
    let premium = v["premium"].as_bool()?;
    let source = v["source"].as_str().filter(|s| matches!(*s, "apple" | "google" | "web"));
    let expires = v["expiresMs"].as_i64();
    Some(json!({ "premium": premium, "source": source, "expiresMs": expires }))
}

/// An engine or native error code: upper case letters and `_`, short. Anything else is `INTERNAL`.
fn code(c: &str) -> String {
    if !c.is_empty() && c.len() <= 32 && c.bytes().all(|b| b.is_ascii_uppercase() || b == b'_') {
        c.to_string()
    } else {
        "INTERNAL".to_string()
    }
}

/// The verdict part of a purchase or restore item: `premium` (the engine's status after the
/// receipt was accepted) or `error: {code}` (the engine refused or could not check it, or the
/// store's own signature check failed: `UNVERIFIED`). Never the receipt.
fn verdict(raw: &Value, into: &mut Map<String, Value>) {
    let v: RawVerify = serde_json::from_value(raw.clone()).unwrap_or_default();
    match (v.premium.as_ref().and_then(status), v.code) {
        (Some(s), None) => {
            into.insert("premium".into(), s);
        }
        (_, Some(c)) => {
            into.insert("error".into(), json!({ "code": code(&c) }));
        }
        (None, None) => {
            into.insert("error".into(), json!({ "code": "INTERNAL" }));
        }
    }
}

fn platform(v: &Value) -> Option<&'static str> {
    match v.as_str()? {
        "apple" => Some("apple"),
        "google" => Some("google"),
        _ => None,
    }
}

/// A purchase's outcome for the page: `{status: "purchased"|"pending"|"cancelled", platform,
/// productId}`, and for `purchased` the verdict (`premium` or `error`). `None` when the native
/// reply does not read (the shell answers `INTERNAL`). `asked` is the product the page asked for.
pub fn purchase_reply(raw: &Value, asked: &str) -> Option<Value> {
    let status = raw["status"].as_str().filter(|s| matches!(*s, "purchased" | "pending" | "cancelled"))?;
    let platform = platform(&raw["platform"])?;
    let mut out = Map::new();
    out.insert("status".into(), json!(status));
    out.insert("platform".into(), json!(platform));
    out.insert("productId".into(), json!(asked));
    if status == "purchased" {
        verdict(&raw["verify"], &mut out);
    }
    Some(Value::Object(out))
}

/// Restore's items for the page: one per store entitlement found, `{platform, productId}` plus the
/// verdict. Unknown products and platforms are dropped. Empty when the store holds none.
pub fn restore_reply(raw: &Value) -> Vec<Value> {
    let items = raw.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    items
        .iter()
        .filter_map(|item| {
            let platform = platform(&item["platform"])?;
            let id = item["productId"].as_str().filter(|id| product_ok(id))?;
            let mut out = Map::new();
            out.insert("platform".into(), json!(platform));
            out.insert("productId".into(), json!(id));
            verdict(&item["verify"], &mut out);
            Some(Value::Object(out))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_our_two_products_pass() {
        assert!(product_ok("com.mailvault.app.premium.monthly"));
        assert!(product_ok("com.mailvault.app.premium.yearly"));
        for bad in ["", "com.mailvault.app.premium", "com.mailvault.app.premium.monthly ", "COM.MAILVAULT.APP.PREMIUM.MONTHLY", "com.other.app.premium.monthly"] {
            assert!(!product_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn finished_only_when_the_server_answered() {
        assert!(answered(Ok(())));
        assert!(answered(Err("REFUSED")));
        assert!(answered(Err("INSTALL_LIMIT")));
        for code in ["NETWORK", "RATE_LIMITED", "INVALID", "INTERNAL", "DEVICE_REPLACED", "UNVERIFIED", ""] {
            assert!(!answered(Err(code)), "{code}");
        }
    }

    #[test]
    fn products_keep_ours_in_order_with_safe_fields() {
        let raw = json!({ "products": [
            { "id": "com.mailvault.app.premium.yearly", "title": "Yearly", "price": "39,99 €", "period": "P1Y",
              "introOffer": { "price": "0,00 €", "period": "P1W", "paymentMode": "freeTrial", "periodCount": 1 } },
            { "id": "com.mailvault.app.premium.monthly", "title": "Monthly", "price": "$5.99", "period": "P1M", "extra": "x",
              "introOffer": { "price": "$1", "period": "1 month", "paymentMode": "payAsYouGo", "periodCount": 3 } },
            { "id": "com.evil.premium", "title": "X", "price": "$0", "period": "P1M" },
            { "id": "com.mailvault.app.premium.monthly", "title": "Again", "price": "$1", "period": "P1M" },
        ]});
        assert_eq!(
            products(&raw),
            vec![
                json!({ "id": "com.mailvault.app.premium.monthly", "title": "Monthly", "price": "$5.99", "period": "P1M" }),
                json!({ "id": "com.mailvault.app.premium.yearly", "title": "Yearly", "price": "39,99 €", "period": "P1Y",
                        "introOffer": { "price": "0,00 €", "period": "P1W", "paymentMode": "freeTrial", "periodCount": 1 } }),
            ]
        );
        // A product with an unreadable period, title or price is left out.
        let bad = json!({ "products": [
            { "id": "com.mailvault.app.premium.monthly", "title": "M", "price": "$5.99", "period": "P1W" },
            { "id": "com.mailvault.app.premium.yearly", "title": "", "price": "$39.99", "period": "P1Y" },
        ]});
        assert!(products(&bad).is_empty());
        assert!(products(&json!(null)).is_empty());
    }

    #[test]
    fn a_purchase_reply_carries_no_receipt() {
        let raw = json!({ "status": "purchased", "platform": "apple", "productId": "com.mailvault.app.premium.yearly",
            "jws": "SECRET-JWS", "token": "SECRET-TOKEN",
            "verify": { "answered": true, "premium": { "premium": true, "source": "apple", "expiresMs": 123, "jws": "SECRET-JWS" } } });
        let reply = purchase_reply(&raw, "com.mailvault.app.premium.yearly").unwrap();
        assert_eq!(
            reply,
            json!({ "status": "purchased", "platform": "apple", "productId": "com.mailvault.app.premium.yearly",
                    "premium": { "premium": true, "source": "apple", "expiresMs": 123 } })
        );
        assert!(!reply.to_string().contains("SECRET"));
    }

    #[test]
    fn purchase_outcomes_and_errors() {
        let id = "com.mailvault.app.premium.monthly";
        let raw = json!({ "status": "purchased", "platform": "google", "verify": { "answered": false, "code": "NETWORK" } });
        assert_eq!(
            purchase_reply(&raw, id).unwrap(),
            json!({ "status": "purchased", "platform": "google", "productId": id, "error": { "code": "NETWORK" } })
        );
        let raw = json!({ "status": "purchased", "platform": "apple", "verify": { "answered": false, "code": "bad code<script>" } });
        assert_eq!(purchase_reply(&raw, id).unwrap()["error"], json!({ "code": "INTERNAL" }));
        let raw = json!({ "status": "purchased", "platform": "apple" });
        assert_eq!(purchase_reply(&raw, id).unwrap()["error"], json!({ "code": "INTERNAL" }));
        for status in ["pending", "cancelled"] {
            let raw = json!({ "status": status, "platform": "apple", "verify": { "premium": { "premium": true } } });
            assert_eq!(purchase_reply(&raw, id).unwrap(), json!({ "status": status, "platform": "apple", "productId": id }));
        }
        assert!(purchase_reply(&json!({ "status": "done", "platform": "apple" }), id).is_none());
        assert!(purchase_reply(&json!({ "status": "pending", "platform": "web" }), id).is_none());
        assert!(purchase_reply(&json!(null), id).is_none());
    }

    #[test]
    fn restore_items_keep_ours_without_receipts() {
        let raw = json!({ "items": [
            { "platform": "apple", "productId": "com.mailvault.app.premium.monthly", "jws": "SECRET",
              "verify": { "answered": true, "code": "INSTALL_LIMIT" } },
            { "platform": "google", "productId": "com.mailvault.app.premium.yearly", "token": "SECRET",
              "verify": { "answered": true, "premium": { "premium": true, "source": "google", "expiresMs": 9 } } },
            { "platform": "google", "productId": "com.other", "verify": {} },
            { "platform": "web", "productId": "com.mailvault.app.premium.yearly", "verify": {} },
        ]});
        let items = restore_reply(&raw);
        assert_eq!(
            items,
            vec![
                json!({ "platform": "apple", "productId": "com.mailvault.app.premium.monthly", "error": { "code": "INSTALL_LIMIT" } }),
                json!({ "platform": "google", "productId": "com.mailvault.app.premium.yearly",
                        "premium": { "premium": true, "source": "google", "expiresMs": 9 } }),
            ]
        );
        assert!(!serde_json::to_string(&items).unwrap().contains("SECRET"));
        assert!(restore_reply(&json!({})).is_empty());
    }
}
