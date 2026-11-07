// MailVault mobile: the system previewer, share sheet and browser for the shell (see ../../src/lib.rs).
// Called only from Rust, never from JS. `openFile` and `shareFile` answer when the previewer or the
// sheet is dismissed, so the shell knows when it may delete the staged copy.

import QuickLook
import Tauri
import UIKit
import WebKit

struct FileArgs: Decodable {
  let path: String
  let mime: String?
}

struct UrlArgs: Decodable {
  let url: String
}

class MvNativePlugin: Plugin, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  // One preview and one share sheet at a time; only touched on the main queue.
  private var previewItem: URL?
  private var previewInvoke: Invoke?
  private var sharing = false

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
}

@_cdecl("init_plugin_mv_native")
func initPlugin() -> Plugin {
  return MvNativePlugin()
}
