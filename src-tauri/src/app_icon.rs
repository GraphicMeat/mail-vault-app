use tauri::Manager;

fn icon_bytes(icon: &str) -> Result<&'static [u8], String> {
    match icon {
        "purple" => Ok(include_bytes!("../icons/alternates/purple.png")),
        "teal" => Ok(include_bytes!("../icons/alternates/teal.png")),
        _ => Err("Unknown app icon".into()),
    }
}

/// Bundled icon names, so a stored choice is always one of them.
fn icon_name(icon: &str) -> &'static str {
    match icon {
        "teal" => "teal",
        _ => "purple",
    }
}

/// The icon picked in Settings, kept here so `send_notification` can read it:
/// the shell is the one process that both applies the choice and shows banners.
#[derive(Default)]
pub struct SelectedAppIcon(std::sync::Mutex<Option<&'static str>>);

impl SelectedAppIcon {
    /// An unknown name counts as the default, like the setting itself.
    pub fn set(&self, icon: &str) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(icon_name(icon));
        }
    }

    pub fn get(&self) -> &'static str {
        self.0.lock().ok().and_then(|slot| *slot).unwrap_or("purple")
    }
}

/// Writes the icon to a file a notification can point at. `unique` gives each
/// call its own file: macOS moves an attachment into its own store, so a shared
/// one would be gone for the next banner. Otherwise one file per icon, rewritten
/// only when its bytes differ.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn icon_file(
    dir: &std::path::Path,
    icon: &str,
    unique: bool,
) -> Result<std::path::PathBuf, String> {
    let bytes = icon_bytes(icon)?;
    let name = if unique {
        format!("notification-{icon}-{}.png", uuid::Uuid::new_v4())
    } else {
        format!("notification-{icon}.png")
    };
    let path = dir.join(name);
    if std::fs::read(&path).ok().as_deref() != Some(bytes) {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
pub async fn set_app_icon(
    app: tauri::AppHandle,
    selected: tauri::State<'_, SelectedAppIcon>,
    icon: String,
) -> Result<(), String> {
    let bytes = icon_bytes(&icon)?;
    // Before the window loop: a window error must not leave banners on the old icon.
    selected.set(&icon);
    let image = tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?;
    for window in app.webview_windows().values() {
        window.set_icon(image.clone()).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(tray) = app.tray_by_id("mailvault-tray") {
        let bytes: &[u8] = match icon.as_str() {
            "teal" => include_bytes!("../icons/alternates/teal-tray.png"),
            _ => include_bytes!("../icons/alternates/purple-tray.png"),
        };
        tray.set_icon(Some(
            tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())?,
        ))
        .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        // AppKit must run on the main thread. The bundle remains signed and intact.
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            use cocoa::appkit::NSApplication;
            use cocoa::base::{id, nil};
            use objc::{class, msg_send, sel, sel_impl};
            let result = unsafe {
                let data: id =
                    msg_send![class!(NSData), dataWithBytes:bytes.as_ptr() length:bytes.len()];
                let allocated: id = msg_send![class!(NSImage), alloc];
                let image: id = msg_send![allocated, initWithData:data];
                if image == nil {
                    Err("Could not decode app icon".to_string())
                } else {
                    let application = NSApplication::sharedApplication(nil);
                    let _: () = msg_send![application, setApplicationIconImage:image];
                    let _: () = msg_send![image, release];
                    Ok(())
                }
            };
            let _ = send.send(result);
        })
        .map_err(|e| e.to_string())?;
        receive.await.map_err(|e| e.to_string())??;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bundled_icons_are_accepted() {
        assert!(icon_bytes("purple").is_ok());
        assert!(icon_bytes("teal").is_ok());
        assert!(icon_bytes("../../file").is_err());
    }

    #[test]
    fn notifications_start_on_the_default_icon() {
        assert_eq!(SelectedAppIcon::default().get(), "purple");
    }

    #[test]
    fn notifications_follow_the_icon_chosen_in_settings() {
        let selected = SelectedAppIcon::default();
        selected.set("teal");
        assert_eq!(selected.get(), "teal");
        selected.set("purple");
        assert_eq!(selected.get(), "purple");
    }

    #[test]
    fn an_unknown_choice_leaves_notifications_on_the_default() {
        let selected = SelectedAppIcon::default();
        selected.set("../../file");
        assert_eq!(selected.get(), "purple");
        selected.set("teal");
        selected.set("../../file");
        assert_eq!(selected.get(), "purple");
    }

    #[test]
    fn the_notification_file_holds_the_chosen_icon() {
        let dir = tempfile::tempdir().unwrap();
        let path = icon_file(dir.path(), "teal", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), icon_bytes("teal").unwrap());
        let path = icon_file(dir.path(), "purple", false).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), icon_bytes("purple").unwrap());
    }

    #[test]
    fn a_shared_notification_file_is_rewritten_when_the_choice_changes() {
        let dir = tempfile::tempdir().unwrap();
        let teal = icon_file(dir.path(), "teal", false).unwrap();
        std::fs::write(&teal, b"stale").unwrap();
        let again = icon_file(dir.path(), "teal", false).unwrap();
        assert_eq!(again, teal);
        assert_eq!(std::fs::read(&again).unwrap(), icon_bytes("teal").unwrap());
    }

    #[test]
    fn each_unique_copy_gets_its_own_file() {
        // macOS moves an attached file into its own store, so one banner must
        // never share a file with the next.
        let dir = tempfile::tempdir().unwrap();
        let a = icon_file(dir.path(), "teal", true).unwrap();
        let b = icon_file(dir.path(), "teal", true).unwrap();
        assert_ne!(a, b);
        assert_eq!(std::fs::read(&b).unwrap(), icon_bytes("teal").unwrap());
    }

    #[test]
    fn an_unknown_icon_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(icon_file(dir.path(), "../../file", false).is_err());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}
