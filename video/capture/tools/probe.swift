// Prints the displays as JSON: logical frame, the frame left over by the menu
// bar and Dock (what a window may occupy), the backing scale and the mode's
// pixel size. Used to choose the footage window size.
//
//   probe            -> JSON on stdout
import AppKit
import CoreGraphics

var screens: [[String: Any]] = []
for s in NSScreen.screens {
    let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    let mode = CGDisplayCopyDisplayMode(id)
    screens.append([
        "name": s.localizedName,
        "displayID": Int(id),
        "main": s == NSScreen.main,
        "frame": [s.frame.origin.x, s.frame.origin.y, s.frame.width, s.frame.height],
        "visibleFrame": [s.visibleFrame.origin.x, s.visibleFrame.origin.y, s.visibleFrame.width, s.visibleFrame.height],
        "backingScale": s.backingScaleFactor,
        "modePixels": [mode?.pixelWidth ?? 0, mode?.pixelHeight ?? 0],
        "modePoints": [mode?.width ?? 0, mode?.height ?? 0],
        "refreshHz": mode?.refreshRate ?? 0,
        "maxFps": s.maximumFramesPerSecond,
    ])
}
let out: [String: Any] = ["screens": screens, "screenCapturePreflight": CGPreflightScreenCaptureAccess()]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
print(String(data: data, encoding: .utf8)!)
