// Own test binary: process TZ mutation cannot race the other policy tests.
use mailvault_core::backup_schedule::{local_zone, next_in_zone};
use serde_json::json;
mod data { include!("support/backup_zone_tzif.rs"); }
fn offsets(zone: &jiff::tz::TimeZone) -> Vec<i32> {
    [1_699_999_999_000,1_750_000_000_000,1_800_000_001_000].into_iter().map(|t|zone.to_offset(jiff::Timestamp::from_millisecond(t).unwrap()).seconds()).collect()
}
// Test-only child process calls the OLD public Jiff system path exactly once,
// before its system cache can affect the supported-form compatibility oracle.
#[test]
#[ignore = "called in a fresh test process by the provider control"]
fn jiff_system_tz_oracle() {
    assert_eq!(std::env::var("ROW14_TZ_ORACLE").unwrap(),"1");
    let actual=jiff::tz::TimeZone::try_system().ok().map(|zone|offsets(&zone));
    println!("ROW14_TZ_ORACLE={}",serde_json::to_string(&actual).unwrap());
}
fn oracle(value: &str) -> Option<Vec<i32>> {
    let output=std::process::Command::new(std::env::current_exe().unwrap()).args(["--ignored","--exact","jiff_system_tz_oracle","--nocapture"]).env("ROW14_TZ_ORACLE","1").env("TZ",value).output().unwrap();
    assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    let stdout=String::from_utf8(output.stdout).unwrap();
    serde_json::from_str(stdout.lines().find_map(|line|line.strip_prefix("ROW14_TZ_ORACLE=")).expect("fresh oracle result")).unwrap()
}
#[test]
fn machine_zone_changes_are_re_evaluated_without_persisting_an_offset() {
    let prior=std::env::var_os("TZ");
    // Exact active real-JS /12/null epochs. Returning to UTC rejects a cache
    // that merely captured its first zone; this changes no host OS setting.
    for (name,expected) in [("UTC",1792918800000),("Europe/Vilnius",1792911600000),("America/New_York",1792933200000),("UTC",1792918800000)] {
        std::env::set_var("TZ",name);
        assert_eq!(next_in_zone(&json!({}),&json!({"interval":"hours","hours":[9]}),1792888200000,&local_zone().unwrap()).unwrap(),expected,"{name}");
    }
    let directory=tempfile::tempdir().unwrap();let custom=directory.path().join("custom.tzif");std::fs::write(&custom,data::tzif(7200)).unwrap();
    let mut forms=vec!["".to_string(),"UTC".into(),"Europe/Vilnius".into(),":Europe/Vilnius".into(),"EST5EDT,M3.2.0,M11.1.0".into(),"EST5EDT".into(),":EST5EDT".into(),"/not-present/zoneinfo/America/New_York".into()];
    forms.push(custom.to_str().unwrap().to_string());forms.push(format!(":{}",custom.display()));
    for value in forms {
        let expected=oracle(&value).expect("existing Jiff accepts this supported form");
        std::env::set_var("TZ",&value);assert_eq!(offsets(&local_zone().unwrap()),expected,"{value}");
    }
    std::env::set_var("TZ","EST5EDT,M3.2.0,M11.1.0");let posix=local_zone().unwrap();
    assert_eq!([1767225600000,1782864000000].map(|t|posix.to_offset(jiff::Timestamp::from_millisecond(t).unwrap()).seconds()),[-18000,-14400]);
    std::env::set_var("TZ",custom.to_str().unwrap());assert_eq!(offsets(&local_zone().unwrap()),vec![7200,10800,7200]);
    std::fs::write(&custom,data::tzif(0)).unwrap();assert_eq!(offsets(&local_zone().unwrap()),vec![0,3600,0]);
    assert_eq!(offsets(&local_zone().unwrap()),oracle(custom.to_str().unwrap()).unwrap());
    for value in ["not-a-zone","+02:00",":not-a-zone"] {
        assert!(oracle(value).is_none());std::env::set_var("TZ",value);assert!(local_zone().is_err(),"{value}");
    }
    std::fs::write(&custom,b"broken").unwrap();std::env::set_var("TZ",&custom);assert!(local_zone().is_err());
    if let Some(prior)=prior {std::env::set_var("TZ",prior);} else {std::env::remove_var("TZ");}
}
