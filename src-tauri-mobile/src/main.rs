// Desktop-host entry so the crate builds and checks on a dev machine; phones enter through
// `mobile_entry_point` in lib.rs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    mailvault_mobile_lib::run()
}
