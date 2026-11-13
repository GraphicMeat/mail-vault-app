// MailVault mobile: background download, refresh and new-mail notifications on iOS (plan Rulings
// 9 and 10).
//
// `mv_ios_background_register` is called by the shell's `run()` before UIApplicationMain (setup
// is too late: BGTaskScheduler refuses a handler registered after launch, and a cold launch's
// notification tap needs the delegate in place). It registers two task handlers and becomes the
// notification center's delegate. Each time the app goes to the background, while the engine
// wants runs (`setBackgroundRefresh` from the plugin keeps that flag: notifications, background
// download, a scheduled send or a reminder), it asks for the next ones; when they run is up to
// iOS (it learns from how the app is used, Low Power Mode and the user's Background App Refresh
// switch can hold them back for hours):
// - `com.mailvault.app.refresh`, a BGAppRefreshTask (15 minutes at the earliest, ~30 s of time);
// - `com.mailvault.app.sync`, a BGProcessingTask with network required: the longer catch-up
//   download, usually overnight on power; minutes rather than seconds.
// Leaving the front also asks iOS for the ~30 s an app may finish its work in
// (`beginBackgroundTask`), and spends it on one run, so a sync or download in flight finishes
// and the mail that just came is downloaded before the app is suspended.
//
// A run calls the shell's `mv_background_fetch` (or `mv_background_continue` on leaving the
// front) on a background queue with a budget counted from that call (opening the engine on a cold
// launch included), short of what iOS gives so posting fits after it: the engine fetches new
// headers and the bodies of recent INBOX mail, and the shell answers the notifications ready to
// post (title, body and the tap payload) and a commit token. They are posted, then the token is
// handed to `mv_background_commit`, which counts the mail as notified; then the task completes.
// When iOS ends the task first, the expiration handler tells the engine to stop
// (`mv_background_stop`: the download stops before its next body; what it wrote stays) and
// completes the task at once; nothing is committed: the next run returns the same mail (a repost
// replaces, the ids are per message). A tap hands its payload to `mv_notification_tapped`.
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
  static let processingId = "com.mailvault.app.sync"
  /// Set by `setBackgroundRefresh`: the engine wants background runs, so they are asked for.
  static let enabledKey = "mv.backgroundRefresh"
  /// Counted from the Rust call; iOS gives a refresh task about 30 s, and posting follows.
  static let budgetMs: UInt32 = 22_000
  /// A processing task runs for minutes; the expiration handler stops it early if iOS wants.
  static let processingBudgetMs: UInt32 = 240_000
  static let earliest: TimeInterval = 15 * 60
  static let processingEarliest: TimeInterval = 60 * 60
  /// Kept short of what iOS grants on leaving the front (~30 s), so posting fits.
  static let continueBudgetMs: UInt32 = 20_000
  /// The run on leaving the front, while it lasts (main thread only).
  private static var continuing: UIBackgroundTaskIdentifier = .invalid
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
      guard task is BGAppRefreshTask else {
        task.setTaskCompleted(success: false)
        return
      }
      run(task, budgetMs: budgetMs)
    }
    BGTaskScheduler.shared.register(forTaskWithIdentifier: processingId, using: nil) { task in
      guard task is BGProcessingTask else {
        task.setTaskCompleted(success: false)
        return
      }
      run(task, budgetMs: processingBudgetMs)
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { _ in
      schedule()
      continueInBackground()
    }
  }

  /// Asks iOS for the next runs, replacing pending requests; cancels them when the engine wants
  /// none.
  static func schedule() {
    guard enabled else {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskId)
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: processingId)
      return
    }
    let refresh = BGAppRefreshTaskRequest(identifier: taskId)
    refresh.earliestBeginDate = Date(timeIntervalSinceNow: earliest)
    let processing = BGProcessingTaskRequest(identifier: processingId)
    processing.requiresNetworkConnectivity = true
    processing.requiresExternalPower = false
    processing.earliestBeginDate = Date(timeIntervalSinceNow: processingEarliest)
    for request in [refresh, processing] as [BGTaskRequest] {
      do {
        try BGTaskScheduler.shared.submit(request)
      } catch {
        NSLog("MV_MOBILE {\"backgroundScheduleError\":\"%@\"}", String(describing: error))
      }
    }
  }

  static func run(_ task: BGTask, budgetMs: UInt32) {
    // The next runs first: an expired or failed one must not end the chain.
    schedule()
    let done = Completion(task)
    task.expirationHandler = {
      // The download stops before its next body; then the task is handed back at once.
      mv_background_stop()
      done.finish(false)
    }
    DispatchQueue.global(qos: .utility).async {
      guard let reply = fetch(budgetMs: budgetMs) else {
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

  /// The app left the front: the time iOS grants to finish work is spent on one run, so a sync
  /// in flight completes and new mail is downloaded before the app is suspended. Main thread.
  static func continueInBackground() {
    guard enabled, continuing == .invalid else { return }
    let ended = NSLock()
    var over = false
    // Ends the grant once, whichever of the run and the expiration gets there first.
    let end = {
      ended.lock()
      let first = !over
      over = true
      ended.unlock()
      guard first else { return }
      let release = {
        UIApplication.shared.endBackgroundTask(continuing)
        continuing = .invalid
      }
      // The expiration handler runs on the main thread and must end the grant before returning.
      if Thread.isMainThread { release() } else { DispatchQueue.main.async(execute: release) }
    }
    continuing = UIApplication.shared.beginBackgroundTask(withName: "mv-continue") {
      mv_background_stop()
      end()
    }
    guard continuing != .invalid else { return }
    DispatchQueue.global(qos: .utility).async {
      guard let reply = fetch(budgetMs: continueBudgetMs, leaving: true) else {
        end()
        return
      }
      post(reply.notes) {
        ended.lock()
        let still = !over
        ended.unlock()
        if still, let token = reply.commit { token.withCString { mv_background_commit($0) } }
        end()
      }
    }
  }

  /// One Rust run: the reply, or nil when it could not be read. `leaving`: the app just left
  /// the front (the engine marks it so before the run, whatever order the OS events arrive in).
  static func fetch(budgetMs: UInt32 = MvBackground.budgetMs, leaving: Bool = false) -> BackgroundReply? {
    let languages = Locale.preferredLanguages.joined(separator: ",")
    languages.withCString { mv_set_languages($0) }
    let raw = leaving ? mv_background_continue(budgetMs) : mv_background_fetch(budgetMs)
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
