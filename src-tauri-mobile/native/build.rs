// No commands of its own: JS cannot reach this plugin. The shell calls it from Rust
// (`mobile_open_file` / `mobile_share_file` / `mobile_pick_files`, and the navigation hook for
// links).
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").ios_path("ios").build();
}
