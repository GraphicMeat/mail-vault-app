// MailVault mobile: background refresh and new-mail notifications on iOS (plan Rulings 9 and 10).
//
// `mv_ios_background_register` is called by the shell's `run()` before UIApplicationMain (setup
// is too late: BGTaskScheduler refuses a handler registered after launch, and a cold launch's
// notification tap needs the delegate in place). It registers the `com.mailvault.app.refresh`
// handler, becomes the notification center's delegate and, each time the app goes to the
// background, asks for the next run (15 minutes at the earliest; when is up to iOS) if the user
// turned notifications on (`setBackgroundRefresh` from the plugin keeps that flag).
//
// A run calls the shell's `mv_background_fetch` on a background queue with a budget counted from
// that call (opening the engine on a cold launch included), short of the ~30 s iOS gives a refresh
// task so posting fits after it: the engine syncs every INBOX headers-only and the shell answers
// the notifications ready to post (title, body and the tap payload) and a commit token. They are
// posted, then the token is handed to `mv_background_commit`, which counts the mail as notified;
// then the task completes. When iOS ends the task first, the expiration handler completes it at
// once and nothing is committed: the next run returns the same mail (a repost replaces, the ids
// are per message). A tap hands its payload to `mv_notification_tapped`.
//
// The shell's exports are declared in C (`ShellC/include/mv_shell.h`), so they are called with the
// C calling convention.

import BackgroundTasks
import Foundation
import MvShellC
import UIKit
import UserNotifications

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
  /// Handed back once the notes are posted.
  let commit: String?
}

enum MvBackground {
  static let taskId = "com.mailvault.app.refresh"
  /// Set by `setBackgroundRefresh`: notifications are on, so runs are asked for.
  static let enabledKey = "mv.backgroundRefresh"
  /// Counted from the Rust call; iOS gives a refresh task about 30 s, and posting follows.
  static let budgetMs: UInt32 = 22_000
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
    // Kept only by perf-gate builds of the shell (the device check); dropped by shipping ones.
    mv_set_device_check_runner(mvDeviceCheckRun)
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
      guard let reply = fetch() else {
        done.finish(false)
        return
      }
      post(reply.notes) {
        // Counted as notified only once posted, and only while the task is still ours.
        if let token = reply.commit { done.commitIfRunning(token) }
        done.finish(true)
      }
    }
  }

  /// One Rust run: the reply, or nil when it could not be read.
  static func fetch() -> BackgroundReply? {
    let languages = Locale.preferredLanguages.joined(separator: ",")
    languages.withCString { mv_set_languages($0) }
    let raw = mv_background_fetch(budgetMs)
    defer { mv_free_string(raw) }
    guard let raw = raw, let data = String(cString: raw).data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(BackgroundReply.self, from: data)
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

  /// Commits the run's notified mail unless the task already ended (iOS may suspend the process
  /// right after): the expiration handler waits for a commit that started.
  func commitIfRunning(_ token: String) {
    lock.lock()
    defer { lock.unlock() }
    guard !done else { return }
    token.withCString { mv_background_commit($0) }
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

/// The run without a `BGTask`, for the device check of a perf-gate build (the simulator launches
/// no background task): the same fetch, posting and commit. Not exported; the shell keeps it only
/// in perf-gate builds (`mv_set_device_check_runner`).
private let mvDeviceCheckRun: @convention(c) () -> Void = {
  DispatchQueue.global(qos: .utility).async {
    guard let reply = MvBackground.fetch() else { return }
    MvBackground.post(reply.notes) {
      if let token = reply.commit { token.withCString { mv_background_commit($0) } }
    }
  }
}

@_cdecl("mv_ios_background_register")
public func mvIosBackgroundRegister() {
  MvBackground.register()
}
