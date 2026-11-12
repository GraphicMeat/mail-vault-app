#[path = "src/reply_budgets.rs"]
mod reply_budgets;

fn main() {
    // The shell reads every method's reply budget from the daemon's method
    // table at compile time (`include_str!`); a row it cannot read fails the
    // build here instead of the first RPC at run time.
    let methods = "../src-daemon/methods.json";
    println!("cargo:rerun-if-changed={methods}");
    let text = std::fs::read_to_string(methods).unwrap_or_else(|e| panic!("{methods}: {e}"));
    if let Err(e) = reply_budgets::parse_reply_budgets(&text) {
        panic!("{methods}: {e} (every row is {{\"name\", \"replySecs\": whole seconds or null}})");
    }
    tauri_build::build()
}
