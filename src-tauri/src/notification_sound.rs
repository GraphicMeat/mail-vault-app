//! Named system sounds only: no bundled audio and no arbitrary file access.

pub fn sound_name(sound: Option<&str>) -> Option<&'static str> {
    match sound {
        Some("Glass") => Some("Glass"),
        Some("Ping") => Some("Ping"),
        Some("Pop") => Some("Pop"),
        Some("Purr") => Some("Purr"),
        Some("Tink") => Some("Tink"),
        _ => None,
    }
}

/// A synchronous Tauri command runs on the main thread, as AppKit expects.
/// Preview uses NSSound; incoming mail uses the notification's sound instead,
/// so the OS remains responsible for notification permissions and muting.
#[tauri::command]
pub fn preview_notification_sound(sound: String) -> Result<(), String> {
    let sound = sound_name(Some(&sound)).ok_or("Unknown notification sound")?;

    #[cfg(target_os = "macos")]
    {
        use cocoa::base::{id, nil, BOOL, NO, YES};
        use cocoa::foundation::{NSAutoreleasePool, NSString};
        use objc::{class, msg_send, sel, sel_impl};
        use std::sync::Mutex;

        // Stop an earlier preview before starting another, including when
        // switching sounds. Names are static and never cross into user paths.
        static LAST_PREVIEW: Mutex<Option<&'static str>> = Mutex::new(None);
        let mut previous = LAST_PREVIEW.lock().map_err(|e| e.to_string())?;
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            if let Some(name) = *previous {
                let name = NSString::alloc(nil).init_str(name);
                let old: id = msg_send![class!(NSSound), soundNamed: name];
                let _: () = msg_send![name, release];
                if old != nil {
                    let _: BOOL = msg_send![old, stop];
                }
            }
            let name = NSString::alloc(nil).init_str(sound);
            let audio: id = msg_send![class!(NSSound), soundNamed: name];
            let _: () = msg_send![name, release];
            let started: BOOL = if audio == nil { NO } else { msg_send![audio, play] };
            let _: () = msg_send![pool, drain];
            if started == YES {
                *previous = Some(sound);
                Ok(())
            } else {
                *previous = None;
                Err("Could not play the system sound".into())
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = sound;
        Err("System sound previews are available on macOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_and_missing_sounds_are_silent() {
        for value in [None, Some("none"), Some(""), Some("../Glass.aiff"), Some("/tmp/sound.wav")] {
            assert_eq!(sound_name(value), None);
        }
    }

    #[test]
    fn selected_system_sound_is_preserved() {
        assert_eq!(sound_name(Some("Ping")), Some("Ping"));
        assert_eq!(sound_name(Some("Tink")), Some("Tink"));
    }
}
