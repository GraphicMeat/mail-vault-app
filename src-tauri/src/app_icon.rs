use tauri::Manager;

fn icon_bytes(icon: &str) -> Result<&'static [u8], String> {
    match icon {
        "purple" => Ok(include_bytes!("../icons/alternates/purple.png")),
        "teal" => Ok(include_bytes!("../icons/alternates/teal.png")),
        _ => Err("Unknown app icon".into()),
    }
}

#[tauri::command]
pub async fn set_app_icon(app: tauri::AppHandle, icon: String) -> Result<(), String> {
    let bytes = icon_bytes(&icon)?;
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
}
