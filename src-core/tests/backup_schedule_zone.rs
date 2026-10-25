// Own test binary: process TZ mutation cannot race the other policy tests.
use mailvault_core::backup_schedule::{local_zone, next_in_zone};
use serde_json::json;
#[test]
fn machine_zone_changes_are_re_evaluated_without_persisting_an_offset() {
    let prior = std::env::var_os("TZ");
    // Exact epochs from the active real-JS oracle's /12/null case. The last
    // UTC check rejects a provider that captured only its first zone/offset.
    for (name, expected) in [
        ("UTC", 1792918800000),
        ("Europe/Vilnius", 1792911600000),
        ("America/New_York", 1792933200000),
        ("UTC", 1792918800000),
    ] {
        std::env::set_var("TZ", name);
        assert_eq!(
            next_in_zone(
                &json!({}),
                &json!({"interval":"hours","hours":[9]}),
                1792888200000,
                &local_zone().unwrap()
            )
            .unwrap(),
            expected,
            "{name}"
        );
    }
    if let Some(prior) = prior {
        std::env::set_var("TZ", prior);
    } else {
        std::env::remove_var("TZ");
    }
}
