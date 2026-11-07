// MailVault mobile: background refresh and new-mail notifications on iOS (plan Rulings 9 and 10).
//
// `mv_ios_background_register` is called by the shell's `run()` before UIApplicationMain (setup
// is too late: BGTaskScheduler refuses a handler registered after launch, and a cold launch's
// notification tap needs the delegate in place). It registers the `com.mailvault.app.refresh`
// handler, becomes the notification center's delegate and, each time the app goes to the
// background, asks for the next run (15 minutes at the earliest; when is up to iOS) if the user
// turned notifications on (`setBackgroundRefresh` from the plugin keeps that flag).
//
// A run calls the shell's `mv_background_fetch(25000)` on a background queue: the engine syncs
// every INBOX headers-only and the shell answers the notifications ready to post (title, body and
// the tap payload). They are posted, the next run is asked for, and the task completes. When iOS
// ends the task early the expiration handler completes it at once; the Rust call returns within
// its budget anyway. A tap hands its payload to `mv_notification_tapped`.

import BackgroundTasks
import Foundation
import UIKit
import UserNotifications

@_silgen_name("mv_background_fetch")
func mv_background_fetch(_ budgetMs: UInt32) -> UnsafeMutablePointer<CChar>?

@_silgen_name("mv_free_string")
func mv_free_string(_ s: UnsafeMutablePointer<CChar>?)

@_silgen_name("mv_notification_tapped")
func mv_notification_tapped(_ json: UnsafePointer<CChar>?)

@_silgen_name("mv_set_languages")
func mv_set_languages(_ csv: UnsafePointer<CChar>?)

/// One notification as the shell renders it.
struct BackgroundNote: Decodable {
  let id: String
  let title: String
  let body: String
  let accountId: String
  let folder: String
  let uid: UInt32?
}

struct BackgroundReply: Decodable {
  let notes: [BackgroundNote]
}

enum MvBackground {
  static let taskId = "com.mailvault.app.refresh"
  /// Set by `setBackgroundRefresh`: notifications are on, so runs are asked for.
  static let enabledKey = "mv.backgroundRefresh"
  static let budgetMs: UInt32 = 25_000
  static let earliest: TimeInterval = 15 * 60
  /// The notification center holds its delegate weakly.
  static let taps = TapDelegate()
  private static var registered = false

  static var enabled: Bool {
    get { UserDefaults.standard.bool(forKey: enabledKey) }
    set { UserDefaults.standard.set(newValue, forKey: enabledKey) }
  }

  static func register() {
    guard !registered else { return }
    registered = true
    UNUserNotificationCenter.current().delegate = taps
    BGTaskScheduler.shared.register(forTaskWithIdentifier: taskId, using: nil) { task in
      guard let refresh = task as? BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      run(refresh)
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { _ in
      schedule()
    }
  }

  /// Asks iOS for the next run, replacing a pending request; cancels when notifications are off.
  static func schedule() {
    guard enabled else {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
      return
    }
    let request = BGAppRefreshTaskRequest(identifier: taskId)
    request.earliestBeginDate = Date(timeIntervalSinceNow: earliest)
    do {
      try BGTaskScheduler.shared.submit(request)
    } catch {
      NSLog("MV_MOBILE {\"backgroundScheduleError\":\"%@\"}", String(describing: error))
    }
  }

  static func run(_ task: BGAppRefreshTask) {
    // The next run first: an expired or failed one must not end the chain.
    schedule()
    let done = Completion(task)
    task.expirationHandler = { done.finish(false) }
    DispatchQueue.global(qos: .utility).async {
      let languages = Locale.preferredLanguages.joined(separator: ",")
      languages.withCString { mv_set_languages($0) }
      let raw = mv_background_fetch(budgetMs)
      defer { mv_free_string(raw) }
      guard let raw = raw, let data = String(cString: raw).data(using: .utf8),
        let reply = try? JSONDecoder().decode(BackgroundReply.self, from: data)
      else {
        done.finish(false)
        return
      }
      post(reply.notes) { done.finish(true) }
    }
  }

  /// Posts `notes` (a repeat id replaces, never doubles), then calls `finished`.
  static func post(_ notes: [BackgroundNote], finished: @escaping () -> Void) {
    guard !notes.isEmpty else {
      finished()
      return
    }
    let center = UNUserNotificationCenter.current()
    let group = DispatchGroup()
    let counts = NSLock()
    var posted = 0
    var refused = 0
    for note in notes {
      let content = UNMutableNotificationContent()
      content.title = note.title
      content.body = note.body
      content.sound = .default
      content.threadIdentifier = note.accountId
      var payload: [String: Any] = ["accountId": note.accountId, "folder": note.folder]
      if let uid = note.uid { payload["uid"] = uid }
      content.userInfo = ["mv": payload]
      group.enter()
      center.add(UNNotificationRequest(identifier: note.id, content: content, trigger: nil)) { error in
        counts.lock()
        if error == nil { posted += 1 } else { refused += 1 }
        counts.unlock()
        group.leave()
      }
    }
    group.notify(queue: .global(qos: .utility)) {
      // Counts only (never a sender or subject), for the platform log.
      NSLog("MV_MOBILE {\"notifications\":{\"posted\":%d,\"refused\":%d}}", posted, refused)
      finished()
    }
  }
}

/// Completes a task once, whichever of the run and the expiration handler gets there first.
final class Completion {
  private let task: BGTask
  private var done = false
  private let lock = NSLock()

  init(_ task: BGTask) { self.task = task }

  func finish(_ success: Bool) {
    lock.lock()
    defer { lock.unlock() }
    guard !done else { return }
    done = true
    task.setTaskCompleted(success: success)
  }
}

final class TapDelegate: NSObject, UNUserNotificationCenterDelegate {
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    if let payload = response.notification.request.content.userInfo["mv"] as? [String: Any],
      let data = try? JSONSerialization.data(withJSONObject: payload),
      let json = String(data: data, encoding: .utf8)
    {
      json.withCString { mv_notification_tapped($0) }
    }
    completionHandler()
  }

  // In front, the list shows new mail live: no banner.
  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([])
  }
}

/// The run without a `BGTask` (the device check calls it from lldb where the simulator does not
/// launch background tasks): the same fetch and posting.
@_cdecl("mv_ios_background_run_now")
public func mvIosBackgroundRunNow() {
  DispatchQueue.global(qos: .utility).async {
    let languages = Locale.preferredLanguages.joined(separator: ",")
    languages.withCString { mv_set_languages($0) }
    let raw = mv_background_fetch(MvBackground.budgetMs)
    defer { mv_free_string(raw) }
    guard let raw = raw, let data = String(cString: raw).data(using: .utf8),
      let reply = try? JSONDecoder().decode(BackgroundReply.self, from: data)
    else { return }
    MvBackground.post(reply.notes) {}
  }
}

@_cdecl("mv_ios_background_register")
public func mvIosBackgroundRegister() {
  MvBackground.register()
}
