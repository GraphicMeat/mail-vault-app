//! Embed Info.plist into the binary itself.
//!
//! A sandboxed *standalone* binary — no `.app` around it — still needs a
//! bundle identifier, or `libsystem_secinit` cannot establish its container
//! and kills the process before `main` (SIGTRAP; launchd reports exit -5).
//! The linker section is how a loose executable carries one.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let plist = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("Info.plist");
        println!(
            "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            plist.display()
        );
        println!("cargo:rerun-if-changed=Info.plist");
    }
}
