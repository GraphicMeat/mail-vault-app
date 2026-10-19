//! Hostile CSS against the Dark Reader port. Every case here is a mail that opens fine in
//! light mode; the dark pass must not loop, go quadratic, or build huge strings on it (a
//! worker that is silent past the open timeout is killed with every document it holds).
use mailvault_render::dark::modify_css::{bg_image_modifier, shadow_modifier, RuleStyle};
use mailvault_render::dark::{DarkCx, DarkTheme, Profile, Theme};
use mailvault_render::{RenderDoc, RenderOptions};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const WORKER_STACK_BYTES: usize = 256 * 1024 * 1024;

/// One timed run at a time: the cases here are CPU-heavy, and libtest runs them in
/// parallel, so on a two-core CI runner one case's open raced another's and a ratio of
/// two opens measured the contention, not the pass.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Run `f` on its own thread; fail instead of hanging when it takes longer than `limit`.
fn within<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> T + Send + 'static) -> (T, Duration) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
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

/// How long the dark open of `html` takes, on its own bounded thread.
fn dark_open(html: String) -> Duration {
    let opts = RenderOptions { dark: Some(theme()), ..RenderOptions::new(600, 1.0) };
    within(Duration::from_secs(120), move || RenderDoc::open(&html, opts, None).is_ok()).1
}

/// The dark pass grows with the mail, never faster: the mail at `large` may
/// cost at most `max` times its dark open at `small`. Each case passes the
/// sizes and the bound its pass must keep. Measured on WSL2 Ubuntu, debug:
/// twice the custom properties cost x2.0, twice the rules and chain x1.5 to
/// x1.6 (the walk budget is a fixed part), the rules over the dense graph
/// x1.2. With the walk budget lifted, twice the rules and chain cost x3.5 or
/// did not finish in 120 s.
///
/// A ratio of two dark opens on one machine, not a budget against a light
/// open: a slow runner is slow at both sizes. Blitz 0.3.0-beta.4 opened these
/// mails 2.3 to 4.3 times faster in light mode while the dark pass stayed as it
/// was, and `dark < 4 * light + 2 s` then failed on CI runners with nothing
/// growing faster than before.
fn assert_dark_grows_at_most(max: f64, mail: impl Fn(usize) -> String, small: usize, large: usize) {
    let at_small = dark_open(mail(small));
    let at_large = dark_open(mail(large));
    let grew = at_large.as_secs_f64() / at_small.as_secs_f64();
    eprintln!("dark {small}: {at_small:?}, {large}: {at_large:?}, x{grew:.2}");
    assert!(grew < max, "dark grew x{grew:.2} (bound x{max}) from {small} to {large}: {at_small:?} -> {at_large:?}");
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
    let mail = |n: usize| {
        let props: String = (0..n).map(|i| format!("--a{i:05}:0;")).collect();
        format!("<style>:root{{{props}}}</style><p>x</p>")
    };
    assert_dark_grows_at_most(3.0, mail, 20_000, 40_000);
}

#[test]
fn many_custom_properties_in_one_style_attribute_open_in_linear_time() {
    let mail = |n: usize| {
        let props: String = (0..n).map(|i| format!("--a{i:05}:0;")).collect();
        format!(r#"<p style="{props}">x</p>"#)
    };
    assert_dark_grows_at_most(3.0, mail, 20_000, 40_000);
}

/// `--c0: var(--c1)` ... `--c{n}: var(--c{n+1})`, a chain that never reaches a colour.
fn chain(n: usize) -> String {
    let defs: String = (0..n).map(|i| format!("--c{i}:var(--c{});", i + 1)).collect();
    format!(":root{{{defs}}}")
}

#[test]
fn many_background_rules_over_a_long_variable_chain_open_in_linear_time() {
    // Rules and chain both grow: a walk of the chain per rule is rules x chain.
    let mail = |n: usize| {
        let rules: String = (0..n).map(|i| format!(".a{i}{{background:var(--c0)}}")).collect();
        format!("<style>{}{rules}</style><p>x</p>", chain(n / 4))
    };
    assert_dark_grows_at_most(2.5, mail, 10_000, 20_000);
}

#[test]
fn interleaved_variable_definitions_do_not_make_the_chain_walk_quadratic() {
    // Each pair adds a variable reference, so a result cached for the previous rule is stale.
    let mail = |n: usize| {
        let rules: String = (0..n).map(|i| format!(".a{i}{{background:var(--c0)}}.b{i}{{--d{i}:var(--z)}}")).collect();
        format!("<style>{}{rules}</style><p>x</p>", chain(n / 2))
    };
    assert_dark_grows_at_most(2.5, mail, 5_000, 10_000);
}

#[test]
fn a_dense_variable_graph_does_not_make_the_walk_pay_per_edge() {
    // 550 variables that each name the same 550 targets: a walk visits ~1100 names but pops
    // ~300k edges. Each interleaved pair adds a reference, so no result is reusable. The
    // graph stays; the rules over it go from none to 1500, which must cost about one more
    // walk of the graph, never one per rule.
    let targets: String = (0..550).map(|i| format!("var(--t{i}) ")).collect();
    let mids: String = (0..550).map(|i| format!("--m{i}:{targets};")).collect();
    let all: String = (0..550).map(|i| format!("var(--m{i}) ")).collect();
    let mail = |n: usize| {
        let rules: String = (0..n).map(|i| format!(".a{i}{{background:var(--r)}}.b{i}{{--d{i}:var(--z)}}")).collect();
        format!("<style>:root{{{mids}--r:{all};}}{rules}</style><p>x</p>")
    };
    assert_dark_grows_at_most(2.0, mail, 0, 1500);
}
