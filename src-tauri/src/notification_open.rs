//! Clicking a new-mail banner opens the message it announced.
//!
//! tauri-plugin-notification's desktop `show()` hands the banner to notify-rust
//! and drops the result, so a click on it reaches nobody. On macOS the banner is
//! posted through UNUserNotificationCenter instead, carrying where the message
//! lives in `userInfo`; the delegate queues that target and wakes the frontend.
//!
//! A queue, not an event payload, for the same reason as `mailto::PendingMailto`:
//! a banner still sitting in Notification Center after the app quit *launches*
//! the app when clicked, and that response lands before the webview exists.
//!
//! Other platforms keep the plugin path, so their banners still open nothing.
//! On Windows that means tauri-plugin-notification's WinRT toast: it shows —
//! title, body, sound all work — but a click on it reaches nobody, because the
//! plugin drops the result exactly as it does everywhere it isn't macOS.
//! Click-to-open is a macOS-only capability here; nothing is wired up on
//! Windows to receive it.

use std::sync::Mutex;

/// Where a notified message lives. No `uid` when the banner named no message
/// (previews off): the click opens the folder.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationTarget {
    pub account_id: String,
    pub mailbox: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<u64>,
}

/// The last clicked banner the frontend has not taken yet. One slot: a second
/// click before the frontend drains means the user wants the second message.
#[derive(Default)]
pub struct PendingNotificationOpen(Mutex<Option<NotificationTarget>>);

impl PendingNotificationOpen {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn set(&self, target: NotificationTarget) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(target);
        }
    }

    pub fn take(&self) -> Option<NotificationTarget> {
        self.0.lock().ok().and_then(|mut slot| slot.take())
    }
}

#[tauri::command]
pub fn take_notification_open(
    state: tauri::State<PendingNotificationOpen>,
) -> Option<NotificationTarget> {
    state.take()
}

#[cfg(target_os = "macos")]
pub mod mac {
    use super::{NotificationTarget, PendingNotificationOpen};
    use std::sync::OnceLock;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSBundle, NSDictionary, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
        UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use tauri::{Emitter, Manager};
    use tracing::warn;

    const TARGET_KEY: &str = "mvTarget";

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MVNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive_response(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                opened(response);
                completion_handler.call(());
            }
        }
    );

    /// UNUserNotificationCenter throws for a process that is not an `.app`
    /// bundle (`tauri dev` runs the bare binary), so those keep the plugin.
    pub fn available() -> bool {
        NSBundle::mainBundle().bundlePath().to_string().ends_with(".app")
    }

    /// Before the app finishes launching, or a click that launched it is lost.
    pub fn install(app: &tauri::AppHandle) {
        if !available() || APP.set(app.clone()).is_err() {
            return;
        }
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The property is weak; the delegate must live as long as the process.
        std::mem::forget(delegate);
    }

    pub fn show(
        title: &str,
        body: &str,
        sound: Option<&str>,
        target: Option<&NotificationTarget>,
    ) -> Result<(), String> {
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        if let Some(name) = sound {
            content.setSound(Some(&UNNotificationSound::soundNamed(&NSString::from_str(name))));
        }
        if let Some(target) = target {
            let json = serde_json::to_string(target).map_err(|e| e.to_string())?;
            let key = NSString::from_str(TARGET_KEY);
            let value = NSString::from_str(&json);
            let info = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*value]);
            // SAFETY: an NSDictionary of NSString is an NSDictionary of objects.
            let info: &NSDictionary = unsafe { &*(Retained::as_ptr(&info) as *const NSDictionary) };
            unsafe { content.setUserInfo(info) };
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&uuid::Uuid::new_v4().to_string()),
            &content,
            None,
        );

        // Prompts only while the answer is undetermined; otherwise it replies at
        // once with the stored choice. A denied banner was never shown before
        // either, so it is logged, not failed.
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let deliver = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            if granted.as_bool() {
                UNUserNotificationCenter::currentNotificationCenter()
                    .addNotificationRequest_withCompletionHandler(&request, None);
            } else {
                warn!("[notification] not authorized; banner dropped");
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &deliver,
        );
        Ok(())
    }

    fn opened(response: &UNNotificationResponse) {
        let Some(app) = APP.get() else { return };
        let info = response.notification().request().content().userInfo();
        let key = NSString::from_str(TARGET_KEY);
        let target = info
            .objectForKey(AsRef::<AnyObject>::as_ref(&*key))
            .and_then(|value| value.downcast::<NSString>().ok())
            .and_then(|json| serde_json::from_str::<NotificationTarget>(&json.to_string()).ok());

        if let Some(window) = app.get_webview_window("main") {
            crate::show_main_window(&window);
        }
        // A banner that named nothing (focus-session summary, backup result)
        // still brings the window forward; it just opens no message.
        if let Some(target) = target {
            app.state::<PendingNotificationOpen>().set(target);
            let _ = app.emit("notification-open", ());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_round_trips_the_camel_case_the_frontend_sends() {
        let t: NotificationTarget =
            serde_json::from_str(r#"{"accountId":"a1","mailbox":"INBOX","uid":42}"#).unwrap();
        assert_eq!(t.uid, Some(42));
        let folder_only: NotificationTarget =
            serde_json::from_str(r#"{"accountId":"a1","mailbox":"INBOX"}"#).unwrap();
        assert_eq!(folder_only.uid, None);
        assert_eq!(
            serde_json::to_string(&t).unwrap(),
            r#"{"accountId":"a1","mailbox":"INBOX","uid":42}"#
        );
    }

    #[test]
    fn take_empties_the_slot_and_a_later_click_wins() {
        let q = PendingNotificationOpen::default();
        let t = |uid| NotificationTarget { account_id: "a".into(), mailbox: "INBOX".into(), uid: Some(uid) };
        q.set(t(1));
        q.set(t(2));
        assert_eq!(q.take(), Some(t(2)));
        assert_eq!(q.take(), None);
    }
}
