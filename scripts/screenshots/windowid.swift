// Prints the CGWindowID of the app's main window, for `screencapture -l`.
//
// Two traps this has already fallen into:
//   * filtering on layer 0 — `setAlwaysOnTop` moves the window to layer 5, and
//     the layer-0 match is then a stray 2560x24 helper window whose capture is
//     blank;
//   * `.optionOnScreenOnly` — that list covers the active Space only, so a
//     window on another desktop reads as gone. Ask for everything, then prefer
//     the on-screen candidates and take the largest.
//
// Modes:
//   windowid <AppName>          → window id, or exit 1
//   windowid --check-permission → "granted" / "denied" (Screen Recording)
//   windowid --info             → every candidate window, for debugging
import CoreGraphics
import Foundation

let arg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "MailVault"

if arg == "--check-permission" {
    let granted = CGPreflightScreenCaptureAccess()
    print(granted ? "granted" : "denied")
    exit(granted ? 0 : 2)
}

func windows(_ options: CGWindowListOption) -> [[String: Any]] {
    CGWindowListCopyWindowInfo([options, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
}

let all = windows(.optionAll)
let onScreen = Set(windows(.optionOnScreenOnly).compactMap { $0[kCGWindowNumber as String] as? Int })

struct Candidate {
    let id: Int
    let onScreen: Bool
    let width: Double
    let height: Double
    let layer: Int
}

let owner = arg == "--info" ? "mailvault" : arg
let candidates: [Candidate] = all.compactMap { w in
    guard let name = w[kCGWindowOwnerName as String] as? String,
          name.lowercased() == owner.lowercased(),
          let id = w[kCGWindowNumber as String] as? Int,
          let bounds = w[kCGWindowBounds as String] as? [String: Any],
          let width = bounds["Width"] as? Double,
          let height = bounds["Height"] as? Double
    else { return nil }
    return Candidate(id: id, onScreen: onScreen.contains(id), width: width, height: height,
                     layer: w[kCGWindowLayer as String] as? Int ?? -1)
}

if arg == "--info" {
    for c in candidates {
        print("id=\(c.id) onscreen=\(c.onScreen) layer=\(c.layer) size=\(Int(c.width))x\(Int(c.height))")
    }
    exit(0)
}

// A real app window is on screen and taller than any toolbar or panel; among
// those, the biggest one is the document window.
let best = candidates
    .filter { $0.onScreen && $0.height > 300 && $0.width > 400 }
    .max(by: { $0.width * $0.height < $1.width * $1.height })

if let best {
    print(best.id)
    exit(0)
}

let seen = candidates.map { "id=\($0.id) onscreen=\($0.onScreen) size=\(Int($0.width))x\(Int($0.height))" }
FileHandle.standardError.write(
    "no capturable window owned by \(owner); candidates: \(seen.joined(separator: "; "))\n".data(using: .utf8)!)
exit(1)
