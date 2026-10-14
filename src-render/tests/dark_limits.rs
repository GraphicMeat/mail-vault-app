//! Hostile CSS against the Dark Reader port. Every case here is a mail that opens fine in
//! light mode; the dark pass must not loop, go quadratic, or build huge strings on it (a
//! worker that is silent past the open timeout is killed with every document it holds).
use mailvault_render::dark::modify_css::{bg_image_modifier, shadow_modifier, RuleStyle};
use mailvault_render::dark::{DarkCx, Profile, Theme};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Run `f` on its own thread; fail instead of hanging when it takes longer than `limit`.
fn within<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> (T, Duration) {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let t = Instant::now();
        let out = f();
        let _ = tx.send((out, t.elapsed()));
    });
    rx.recv_timeout(limit).unwrap_or_else(|_| panic!("did not finish within {limit:?}"))
}

fn cx() -> DarkCx {
    DarkCx::new(Theme::mailvault("#0a0a12", "#e8e8ef", 100.0, 100.0, 0.0), Profile::WEBKIT_IFRAME)
}

struct NoRule;
impl RuleStyle for NoRule {
    fn get_property_value(&self, _: &str) -> String {
        String::new()
    }
    fn get_property_priority(&self, _: &str) -> bool {
        false
    }
}

// ---- fancy-regex errors end the match, they are not retried forever ----

#[test]
fn a_shadow_that_exhausts_the_regex_backtrack_limit_is_left_alone() {
    let value = format!("{} var(--x)", "1".repeat(600_000));
    let (out, took) = within(Duration::from_secs(30), move || shadow_modifier(&value, &mut cx()).map(|r| r.result.len()));
    eprintln!("shadow {took:?} -> {out:?}");
    assert_eq!(out, None, "the declaration is left alone");
}

#[test]
fn a_gradient_that_exhausts_the_regex_backtrack_limit_is_left_alone() {
    let value = format!("linear-gradient({})", ",".repeat(1_100_000));
    let (out, took) = within(Duration::from_secs(30), move || bg_image_modifier(&value, &NoRule, &mut cx()).map(|s| s.len()));
    eprintln!("gradient {took:?} -> {out:?}");
    assert_eq!(out, None, "the declaration is left alone");
}
