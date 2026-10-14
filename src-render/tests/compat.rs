//! The `word-break: break-word` rewrite runs on the raw HTML before Blitz parses it, on the
//! worker's open path: it must be linear in the mail's size and touch only CSS (`style`
//! attribute values and `<style>` text), never a link, an attribute or body text.
use mailvault_render::compat::word_break_break_word as rewrite;
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

#[test]
fn a_mail_full_of_the_phrase_is_rewritten_in_linear_time() {
    // ~1.1 MB of the phrase in body text, and as much again inside one style attribute.
    let text = "word-break:break-word ".repeat(50_000);
    let html = format!(r#"<p>{text}</p><div style="{text}">x</div>"#);
    let (out, took) = within(Duration::from_secs(30), move || rewrite(&html).len());
    assert!(out > 0);
    assert!(took < Duration::from_secs(1), "took {took:?}");
}

#[test]
fn only_style_attributes_and_style_text_are_rewritten() {
    let html = r#"<style>td{word-break:break-word}</style><td style="color:red;word-break: break-word">a</td>"#;
    assert_eq!(
        rewrite(html),
        r#"<style>td{overflow-wrap:anywhere}</style><td style="color:red;overflow-wrap:anywhere">a</td>"#
    );
}

#[test]
fn links_other_attributes_and_text_are_left_alone() {
    for html in [
        r#"<a href="https://x.test/?q=word-break:break-word">l</a>"#,
        r#"<img alt="word-break:break-word" title='word-break:break-word' src=x>"#,
        r#"<td data-css=word-break:break-word>a</td>"#,
        r#"<p>word-break:break-word</p>"#,
        r#"<!-- <style>p{word-break:break-word}</style> -->"#,
        r#"<textarea><style>p{word-break:break-word}</style></textarea>"#,
        r#"<td style="color:red" title="word-break:break-word">a</td>"#,
    ] {
        assert_eq!(rewrite(html), html, "changed: {html}");
    }
}

#[test]
fn quoted_and_unquoted_style_values_and_odd_case_are_found() {
    assert_eq!(rewrite(r#"<TD STYLE='Word-Break:Break-Word'>a"#), "<TD STYLE='overflow-wrap:anywhere'>a");
    assert_eq!(rewrite(r#"<td style=word-break:break-word>a"#), "<td style=overflow-wrap:anywhere>a");
    assert_eq!(rewrite(r#"<td title="a>b" style="word-break:break-word">a"#), r#"<td title="a>b" style="overflow-wrap:anywhere">a"#);
    assert_eq!(rewrite("<STYLE media=screen>p{word-break:break-word}</STYLE>"), "<STYLE media=screen>p{overflow-wrap:anywhere}</STYLE>");
}
