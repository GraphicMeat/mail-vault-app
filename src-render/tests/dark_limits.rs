//! Hostile CSS against the Dark Reader port. Every case here is a mail that opens fine in
//! light mode; the dark pass must not loop, go quadratic, or build huge strings on it (a
//! worker that is silent past the open timeout is killed with every document it holds).
use mailvault_render::dark::modify_css::{bg_image_modifier, shadow_modifier, RuleStyle};
use mailvault_render::dark::{DarkCx, DarkTheme, Profile, Theme};
use mailvault_render::{RenderDoc, RenderOptions};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const WORKER_STACK_BYTES: usize = 256 * 1024 * 1024;

/// Run `f` on its own thread; fail instead of hanging when it takes longer than `limit`.
fn within<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> (T, Duration) {
    let (tx, rx) = mpsc::channel();
    // The render worker runs on a 256 MiB stack; libtest's default is 2 MiB (8 MiB with the
    // repo's RUST_MIN_STACK), and a 5000-link variable chain overflows that in a Linux debug build.
    std::thread::Builder::new()
        .stack_size(WORKER_STACK_BYTES)
        .spawn(move || {
            let t = Instant::now();
            let out = f();
            let _ = tx.send((out, t.elapsed()));
        })
        .unwrap();
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

fn theme() -> DarkTheme {
    DarkTheme { bg: "#0a0a12".into(), fg: "#e8e8ef".into(), brightness: 100.0, contrast: 100.0, sepia: 0.0, top_level: false }
}

/// (light open, dark open) times for `html`, each on its own bounded thread.
fn open_times(html: String, limit: Duration) -> (Duration, Duration) {
    let h = html.clone();
    let (_, light) = within(limit, move || RenderDoc::open(&h, RenderOptions::new(600, 1.0), None).is_ok());
    let (_, dark) = within(limit, move || RenderDoc::open(&html, RenderOptions { dark: Some(theme()), ..RenderOptions::new(600, 1.0) }, None).is_ok());
    eprintln!("light {light:?}, dark {dark:?}");
    (light, dark)
}

/// The dark pass may cost a few times a light open (a second resolve, a sheet re-parse),
/// never something that grows faster than the mail.
fn assert_dark_is_linear(light: Duration, dark: Duration) {
    assert!(dark < light * 4 + Duration::from_secs(2), "light {light:?}, dark {dark:?}");
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

// ---- no super-linear passes over a block's declarations or the variable graph ----

#[test]
fn forty_thousand_custom_properties_in_one_block_open_in_linear_time() {
    let props: String = (0..40_000).map(|i| format!("--a{i:05}:0;")).collect();
    let html = format!("<style>:root{{{props}}}</style><p>x</p>");
    let (light, dark) = open_times(html, Duration::from_secs(120));
    assert_dark_is_linear(light, dark);
}

#[test]
fn many_custom_properties_in_one_style_attribute_open_in_linear_time() {
    let props: String = (0..40_000).map(|i| format!("--a{i:05}:0;")).collect();
    let html = format!(r#"<p style="{props}">x</p>"#);
    let (light, dark) = open_times(html, Duration::from_secs(120));
    assert_dark_is_linear(light, dark);
}

/// `--c0: var(--c1)` ... `--c{n}: var(--c{n+1})`, a chain that never reaches a colour.
fn chain(n: usize) -> String {
    let defs: String = (0..n).map(|i| format!("--c{i}:var(--c{});", i + 1)).collect();
    format!(":root{{{defs}}}")
}

#[test]
fn many_background_rules_over_a_long_variable_chain_open_in_linear_time() {
    let rules: String = (0..20_000).map(|i| format!(".a{i}{{background:var(--c0)}}")).collect();
    let html = format!("<style>{}{rules}</style><p>x</p>", chain(5000));
    let (light, dark) = open_times(html, Duration::from_secs(120));
    assert_dark_is_linear(light, dark);
}

#[test]
fn interleaved_variable_definitions_do_not_make_the_chain_walk_quadratic() {
    // Each pair adds a variable reference, so a result cached for the previous rule is stale.
    let rules: String = (0..10_000).map(|i| format!(".a{i}{{background:var(--c0)}}.b{i}{{--d{i}:var(--z)}}")).collect();
    let html = format!("<style>{}{rules}</style><p>x</p>", chain(5000));
    let (light, dark) = open_times(html, Duration::from_secs(120));
    assert_dark_is_linear(light, dark);
}
