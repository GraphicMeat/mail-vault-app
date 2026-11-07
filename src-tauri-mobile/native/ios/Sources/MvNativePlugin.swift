// MailVault mobile: the system previewer, share sheet and browser for the shell (see ../../src/lib.rs).
// Called only from Rust, never from JS. `openFile` and `shareFile` answer when the previewer or the
// sheet is dismissed, so the shell knows when it may delete the staged copy. `pickFiles` runs the
// document picker or the photo picker and copies each pick into the directory Rust named, as
// `<dir>/<index>`; Rust names and moves the copies (../../src/files.rs `finish_pick`). It answers
// when the picker closes; cancel is an empty list. `openAuth` shows a provider's sign-in page in
// `ASWebAuthenticationSession` and answers when it closes (`closeAuth`, or the user's cancel).

import AuthenticationServices
import PhotosUI
import QuickLook
import Tauri
import UIKit
import UniformTypeIdentifiers
import WebKit

struct FileArgs: Decodable {
  let path: String
  let mime: String?
}

struct UrlArgs: Decodable {
  let url: String
}

struct PickArgs: Decodable {
  let kind: String
  let dir: String
}

/// One pick: `file` (the copy's name in the pick directory), `name` and `mime`; or `name` and
/// `error` ("UNREADABLE") when it could not be read in full. Nil fields are left out.
struct PickItem: Encodable {
  let file: String?
  let name: String
  let mime: String?
  let error: String?

  static func unreadable(_ name: String) -> PickItem {
    return PickItem(file: nil, name: name, mime: nil, error: "UNREADABLE")
  }
}

struct PickReply: Encodable {
  let items: [PickItem]
}

class MvNativePlugin: Plugin, QLPreviewControllerDataSource, QLPreviewControllerDelegate,
  UIDocumentPickerDelegate, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate,
  ASWebAuthenticationPresentationContextProviding
{
  // One preview, one share sheet and one picker at a time; only touched on the main queue.
  private var previewItem: URL?
  private var previewInvoke: Invoke?
  private var sharing = false
  private var pickInvoke: Invoke?
  private var pickDir: URL?
  // Set once the picker has handed over its result and the copies run: a late dismissal must not
  // answer the pick a second time (or before the copies are done).
  private var pickAnswering = false
  // The picker on screen for the running pick: callbacks from any other controller are ignored.
  private var pickController: UIViewController?

  // The running sign-in sheet and its invoke; only touched on the main queue. Kept strongly: a
  // session nothing holds is deallocated and its sheet goes away unanswered.
  private var authSession: ASWebAuthenticationSession?
  private var authInvoke: Invoke?

  /// The hosts `openAuth` opens; the shell has already checked the whole URL (links.rs
  /// `auth_url_ok`), this is the native side's own floor.
  private static let authHosts: Set<String> = ["accounts.google.com", "login.microsoftonline.com"]

  /// The controller to present from: the root's topmost presented controller. Nil while anything
  /// is still animating in or out, since UIKit then refuses a presentation with only a console
  /// warning and the call would never be answered.
  private func presenter() -> UIViewController? {
    var top = manager.viewController
    while let next = top?.presentedViewController {
      if next.isBeingDismissed || next.isBeingPresented { return nil }
      top = next
    }
    if let top = top, top.isBeingPresented || top.isBeingDismissed { return nil }
    return top
  }

  private func fileURL(_ invoke: Invoke) -> URL? {
    guard let args = try? invoke.parseArgs(FileArgs.self), args.path.hasPrefix("/") else {
      invoke.reject("bad arguments", code: "INTERNAL")
      return nil
    }
    let url = URL(fileURLWithPath: args.path)
    guard FileManager.default.isReadableFile(atPath: url.path) else {
      invoke.reject("file not readable", code: "INTERNAL")
      return nil
    }
    return url
  }

  @objc public func openFile(_ invoke: Invoke) throws {
    guard let url = fileURL(invoke) else { return }
    DispatchQueue.main.async {
      guard self.previewInvoke == nil else {
        invoke.reject("a preview is already open", code: "BUSY")
        return
      }
      guard QLPreviewController.canPreview(url as NSURL) else {
        invoke.reject("no previewer for this file", code: "NO_APP")
        return
      }
      guard let from = self.presenter() else {
        invoke.reject("another screen is opening or closing", code: "BUSY")
        return
      }
      self.previewItem = url
      self.previewInvoke = invoke
      let preview = QLPreviewController()
      preview.dataSource = self
      preview.delegate = self
      from.present(preview, animated: true) {
        // A refused presentation calls this too, with nothing presented: answer and reset.
        if preview.presentingViewController == nil, let pending = self.previewInvoke {
          self.previewInvoke = nil
          self.previewItem = nil
          pending.reject("the previewer could not be shown", code: "BUSY")
        }
      }
    }
  }

  public func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
    return previewItem == nil ? 0 : 1
  }

  public func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
    -> QLPreviewItem
  {
    return (previewItem ?? URL(fileURLWithPath: "/")) as NSURL
  }

  // Read-only: no markup, so the staged copy (a hard link to the cache file) is never written.
  @available(iOS 13.0, *)
  public func previewController(
    _ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem
  ) -> QLPreviewItemEditingMode {
    return .disabled
  }

  public func previewControllerDidDismiss(_ controller: QLPreviewController) {
    let invoke = previewInvoke
    previewInvoke = nil
    previewItem = nil
    invoke?.resolve()
  }

  @objc public func shareFile(_ invoke: Invoke) throws {
    guard let url = fileURL(invoke) else { return }
    DispatchQueue.main.async {
      guard !self.sharing, let from = self.presenter() else {
        invoke.reject("another screen is opening or closing", code: "BUSY")
        return
      }
      self.sharing = true
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      var answered = false
      let answer: (String?) -> Void = { error in
        if answered { return }
        answered = true
        self.sharing = false
        if let error = error { invoke.reject(error, code: "BUSY") } else { invoke.resolve() }
      }
      sheet.completionWithItemsHandler = { _, _, _, _ in
        // Called once when the sheet goes away (after the chosen activity, if any).
        answer(nil)
      }
      // iPad presents the sheet as a popover, which needs an anchor or it raises.
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = from.view
        popover.sourceRect = CGRect(
          x: from.view.bounds.midX, y: from.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      from.present(sheet, animated: true) {
        if sheet.presentingViewController == nil { answer("the share sheet could not be shown") }
      }
    }
  }

  @objc public func openUrl(_ invoke: Invoke) throws {
    guard let args = try? invoke.parseArgs(UrlArgs.self), let url = URL(string: args.url),
      let scheme = url.scheme?.lowercased(), ["http", "https", "mailto"].contains(scheme)
    else {
      invoke.reject("not an http, https or mailto URL", code: "INTERNAL")
      return
    }
    DispatchQueue.main.async {
      UIApplication.shared.open(url, options: [:]) { opened in
        if opened {
          invoke.resolve()
        } else {
          invoke.reject("no app opens this link", code: "NO_APP")
        }
      }
    }
  }

  @objc public func pickFiles(_ invoke: Invoke) throws {
    guard let args = try? invoke.parseArgs(PickArgs.self), args.dir.hasPrefix("/"),
      args.kind == "files" || args.kind == "photos"
    else {
      invoke.reject("bad arguments", code: "INTERNAL")
      return
    }
    let dir = URL(fileURLWithPath: args.dir, isDirectory: true)
    DispatchQueue.main.async {
      guard self.pickInvoke == nil, let from = self.presenter() else {
        invoke.reject("a picker is already open", code: "BUSY")
        return
      }
      let picker: UIViewController
      if args.kind == "photos" {
        // No photo library access: the picker runs out of process and hands over copies only.
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 0
        // JPEG rather than HEIC where the photo is HEIC: the recipient may not read HEIC.
        config.preferredAssetRepresentationMode = .compatible
        if #available(iOS 15.0, *) { config.selection = .ordered }
        let photos = PHPickerViewController(configuration: config)
        photos.delegate = self
        picker = photos
      } else {
        // asCopy: the picker downloads a cloud file and hands over a copy in our sandbox.
        let documents = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        documents.allowsMultipleSelection = true
        documents.delegate = self
        picker = documents
      }
      self.pickInvoke = invoke
      self.pickDir = dir
      self.pickAnswering = false
      self.pickController = picker
      // A swipe down can close a sheet without its picker delegate hearing of it.
      picker.presentationController?.delegate = self
      from.present(picker, animated: true) {
        if picker.presentingViewController == nil, let pending = self.pickInvoke {
          self.pickInvoke = nil
          self.pickDir = nil
          self.pickController = nil
          pending.reject("the picker could not be shown", code: "BUSY")
        }
      }
    }
  }

  /// Answers the running pick (main queue).
  private func answerPick(_ items: [PickItem]) {
    let invoke = pickInvoke
    pickInvoke = nil
    pickDir = nil
    pickAnswering = false
    pickController = nil
    invoke?.resolve(PickReply(items: items))
  }

  /// The picker sheet was swiped away: a cancel, unless its delegate already took the result.
  public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    guard presentationController.presentedViewController === pickController else { return }
    if pickInvoke != nil && !pickAnswering { answerPick([]) }
  }

  /// Puts `src` at `<dir>/<index>`: moved when it is already our own copy, else copied.
  private static func place(
    _ src: URL, name: String, mime: String?, index: Int, dir: URL, move: Bool
  ) -> PickItem {
    let target = dir.appendingPathComponent(String(index), isDirectory: false)
    let fm = FileManager.default
    do {
      if move {
        do { try fm.moveItem(at: src, to: target) } catch { try fm.copyItem(at: src, to: target) }
      } else {
        try fm.copyItem(at: src, to: target)
      }
    } catch {
      try? fm.removeItem(at: target)
      return PickItem.unreadable(name)
    }
    let type = mime ?? UTType(filenameExtension: src.pathExtension)?.preferredMIMEType
    return PickItem(
      file: String(index), name: name, mime: type ?? "application/octet-stream", error: nil)
  }

  public func documentPicker(
    _ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]
  ) {
    guard controller === pickController, let dir = pickDir, !pickAnswering else { return }
    pickAnswering = true
    // Moving a large file is quick, but a copy across volumes is not: off the main queue.
    DispatchQueue.global(qos: .userInitiated).async {
      var items: [PickItem] = []
      for (i, url) in urls.enumerated() {
        let scoped = url.startAccessingSecurityScopedResource()
        items.append(
          MvNativePlugin.place(
            url, name: url.lastPathComponent, mime: nil, index: i, dir: dir, move: true))
        if scoped { url.stopAccessingSecurityScopedResource() }
      }
      DispatchQueue.main.async { self.answerPick(items) }
    }
  }

  public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    if controller === pickController && !pickAnswering { answerPick([]) }
  }

  public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    // The photo picker does not close itself. Cancel (or a swipe down) is an empty result.
    picker.dismiss(animated: true)
    guard picker === pickController, !pickAnswering else { return }
    guard let dir = pickDir, !results.isEmpty else { return answerPick([]) }
    pickAnswering = true
    var items = [PickItem?](repeating: nil, count: results.count)
    let lock = NSLock()
    let group = DispatchGroup()
    for (i, result) in results.enumerated() {
      let provider = result.itemProvider
      let suggested = provider.suggestedName ?? ""
      let typeId =
        provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) ?? false }
        ?? provider.registeredTypeIdentifiers.first
      guard let typeId = typeId else {
        lock.lock()
        items[i] = PickItem.unreadable(suggested)
        lock.unlock()
        continue
      }
      group.enter()
      // The URL lives only until this handler returns: copy inside it.
      provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, _ in
        let item: PickItem
        if let url = url {
          let type = UTType(typeId)
          var name = suggested.isEmpty ? url.deletingPathExtension().lastPathComponent : suggested
          if let ext = type?.preferredFilenameExtension ?? (url.pathExtension.isEmpty ? nil : url.pathExtension),
            !name.lowercased().hasSuffix("." + ext.lowercased())
          {
            name += "." + ext
          }
          item = MvNativePlugin.place(
            url, name: name, mime: type?.preferredMIMEType, index: i, dir: dir, move: false)
        } else {
          item = PickItem.unreadable(suggested)
        }
        lock.lock()
        items[i] = item
        lock.unlock()
        group.leave()
      }
    }
    group.notify(queue: .main) { self.answerPick(items.compactMap { $0 }) }
  }
}

extension MvNativePlugin {
  /// Answers the running sheet once (main queue) and forgets it.
  private func answerAuth(cancelled: Bool) {
    let invoke = authInvoke
    authInvoke = nil
    authSession = nil
    invoke?.resolve(["cancelled": cancelled])
  }

  /// `openAuth {url}`: the provider's sign-in page. The callback scheme never matches (the provider
  /// redirects to the engine's loopback listener), so the session ends only by the user's cancel
  /// (`{cancelled: true}`) or by `closeAuth` (`{cancelled: false}`). Shares Safari's cookies
  /// (`prefersEphemeralWebBrowserSession = false`), so a signed-in Google or Microsoft user just
  /// picks the account.
  @objc public func openAuth(_ invoke: Invoke) throws {
    guard let args = try? invoke.parseArgs(UrlArgs.self), let url = URL(string: args.url),
      url.scheme?.lowercased() == "https", let host = url.host?.lowercased(),
      MvNativePlugin.authHosts.contains(host)
    else {
      invoke.reject("not a sign-in page", code: "INTERNAL")
      return
    }
    DispatchQueue.main.async {
      guard self.authInvoke == nil else {
        invoke.reject("a sign-in sheet is already open", code: "BUSY")
        return
      }
      var session: ASWebAuthenticationSession?
      session = ASWebAuthenticationSession(url: url, callbackURLScheme: "mailvault-auth") {
        _, _ in
        DispatchQueue.main.async {
          // Only the running session answers: one `closeAuth` already answered, or a newer one,
          // changes nothing. Any end that `closeAuth` did not cause is the user's cancel.
          guard let current = self.authSession, current === session else { return }
          self.answerAuth(cancelled: true)
        }
      }
      guard let started = session else { return }
      started.presentationContextProvider = self
      started.prefersEphemeralWebBrowserSession = false
      self.authSession = started
      self.authInvoke = invoke
      if !started.start() {
        self.authSession = nil
        self.authInvoke = nil
        // Not another sheet (that is `BUSY` above): the session refused to start.
        invoke.reject("the sign-in sheet could not be shown", code: "INTERNAL")
      }
    }
  }

  /// `closeAuth`: closes the running sheet, whose `openAuth` answers `{cancelled: false}`. Answers
  /// at once; nothing to close is not an error.
  @objc public func closeAuth(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      if let session = self.authSession {
        // Answer first: `cancel()` calls the completion, which must find nothing left to answer.
        self.answerAuth(cancelled: false)
        session.cancel()
      }
      invoke.resolve()
    }
  }

  /// The key window of the app's foreground scene: the sheet's anchor.
  public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
    return windows.first { $0.isKeyWindow } ?? manager.viewController?.view.window ?? windows.first
      ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_mv_native")
func initPlugin() -> Plugin {
  return MvNativePlugin()
}
