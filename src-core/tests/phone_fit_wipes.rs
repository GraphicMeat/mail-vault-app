//! `transfer::phone::settings::fit` measures the bundle (its passwords and tokens included) many
//! times. A buffer that holds them must never be left behind unwiped: a `Vec` that grows
//! reallocates, and the block it leaves still holds every secret written so far. This binary's
//! allocator moves every reallocation (alloc, copy, free) and, while armed on the calling
//! thread, looks into each block a reallocation leaves for the marker password.

use mailvault_core::transfer::phone::{settings, PhoneBundle};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

const MARKER: &[u8] = b"Mk7-wipe-me-0123456789-secret";

thread_local! {
    static ARMED: Cell<bool> = const { Cell::new(false) };
}
static LEFT_BEHIND: AtomicUsize = AtomicUsize::new(0);

struct Scanning;

unsafe impl GlobalAlloc for Scanning {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        System.alloc(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
        let new = System.alloc(new_layout);
        if new.is_null() {
            return new;
        }
        std::ptr::copy_nonoverlapping(ptr, new, layout.size().min(new_size));
        if ARMED.try_with(Cell::get).unwrap_or(false) {
            let old = std::slice::from_raw_parts(ptr, layout.size());
            if old.windows(MARKER.len()).any(|w| w == MARKER) {
                LEFT_BEHIND.fetch_add(1, Ordering::SeqCst);
            }
        }
        System.dealloc(ptr, layout);
        new
    }
}

#[global_allocator]
static ALLOC: Scanning = Scanning;

#[test]
fn fit_leaves_no_unwiped_copy_of_a_secret_behind() {
    let marker = std::str::from_utf8(MARKER).unwrap();
    // A signature with a large inline image: fit measures the bundle again after each cut.
    // Noise, so it does not deflate away.
    let mut seed = 0x2545_f491_4f6c_dd1du64;
    let noise: String = (0..60_000)
        .map(|_| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[(seed % 64) as usize] as char
        })
        .collect();
    let image = format!("<img src=\"data:image/png;base64,{noise}\">");
    let mut bundle: PhoneBundle = serde_json::from_value(json!({
        "v": 1,
        "accounts": [{
            "email": "user@example.test", "kind": "imap", "auth": "password",
            "imapHost": "imap.example.test", "imapPort": 993, "security": "ssl",
            "password": marker,
            "settings": { "signature": { "html": format!("<p>Hi</p>{image}"), "text": "Hi", "enabled": true } }
        }]
    }))
    .unwrap();
    assert_eq!(bundle.accounts[0].password.as_deref(), Some(marker));
    ARMED.with(|a| a.set(true));
    let degrade = settings::fit(&mut bundle);
    ARMED.with(|a| a.set(false));
    assert_ne!(degrade, settings::Degrade::Full, "the test bundle must make fit measure more than once");
    assert_eq!(LEFT_BEHIND.load(Ordering::SeqCst), 0, "a grown buffer left a copy of the password behind");
}
