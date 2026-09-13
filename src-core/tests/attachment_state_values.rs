//! Every state string `attachments::extract()` can return must be one of the
//! spec's closed set (spec 8's table's `state` column). A new state added to
//! `extract()` without adding it here is either a typo or an undocumented
//! behavior change — this test forces a deliberate edit either way.
//!
//! The set below was cross-checked against the current source, not copied
//! from the spec blindly: `"encrypted"` is never returned by `NoOcrExtractor`
//! (it always returns `Permanent("unsupported")`), but IS reachable through
//! the real platform extractor in `src-tauri/src/attachment_extract.rs`,
//! which returns `ExtractError::Permanent("encrypted")` for a password-
//! protected PDF. `"pending"` is the one non-spec, internal retry signal
//! (never written to the `attachments.state` column — see the module doc on
//! `ExtractError::Transient`), included here because `extract()` DOES return
//! it as its `&'static str` result, and a guard over the function's return
//! value has to cover every string the function can hand back, terminal or
//! not.
use mailvault_core::search_index::attachments::*;

const ALLOWED: &[&str] = &[
    "ok", "too_small", "too_large", "encrypted", "unsupported", "failed", "not_premium", "disabled", "pending",
];

fn input(mime: &str, filename: &str, size: u64) -> AttachmentInput {
    AttachmentInput { filename: filename.into(), mime: mime.into(), size, bytes: vec![0u8; size as usize] }
}

#[test]
fn every_reachable_state_is_in_the_closed_set() {
    let cases = [
        extract(&input("text/plain", "a.txt", 10), true, true, &NoOcrExtractor).0,
        extract(&input("text/plain", "a.txt", 10), true, false, &NoOcrExtractor).0,
        extract(&input("text/plain", "a.txt", 10), false, true, &NoOcrExtractor).0,
        extract(&input("image/png", "a.png", 1), true, true, &NoOcrExtractor).0,
        extract(&input("application/pdf", "a.pdf", 100), true, true, &NoOcrExtractor).0,
        extract(&input("application/octet-stream", "a.bin", 10), true, true, &NoOcrExtractor).0,
        extract(&input("application/pdf", "a.pdf", MAX_PART_BYTES + 1), true, true, &NoOcrExtractor).0,
    ];
    for state in cases {
        assert!(ALLOWED.contains(&state), "unexpected state: {state}");
    }
}
