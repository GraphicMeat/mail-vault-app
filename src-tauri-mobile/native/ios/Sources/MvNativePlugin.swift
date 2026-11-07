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
  // One preview at a time; only touched on the main queue.
  private var previewItem: URL?
  private var previewInvoke: Invoke?

  /// The controller to present from: the root's topmost presented controller.
  private func presenter() -> UIViewController? {
    var top = manager.viewController
    while let next = top?.presentedViewController, !next.isBeingDismissed {
      top = next
    }
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
      guard let from = self.presenter() else {
        invoke.reject("no view controller", code: "INTERNAL")
        return
      }
      guard QLPreviewController.canPreview(url as NSURL) else {
        invoke.reject("no previewer for this file", code: "NO_APP")
        return
      }
      self.previewItem = url
      self.previewInvoke = invoke
      let preview = QLPreviewController()
      preview.dataSource = self
      preview.delegate = self
      from.present(preview, animated: true)
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
      guard let from = self.presenter() else {
        invoke.reject("no view controller", code: "INTERNAL")
        return
      }
      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      var answered = false
      sheet.completionWithItemsHandler = { _, _, _, _ in
        // Called once when the sheet goes away (after the chosen activity, if any).
        if answered { return }
        answered = true
        invoke.resolve()
      }
      // iPad presents the sheet as a popover, which needs an anchor or it raises.
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = from.view
        popover.sourceRect = CGRect(
          x: from.view.bounds.midX, y: from.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
      }
      from.present(sheet, animated: true)
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
