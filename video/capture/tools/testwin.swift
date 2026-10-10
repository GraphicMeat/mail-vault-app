// A calibration window for the recorder: redraws every display frame and
// paints the wall-clock time that frame is meant to reach the screen as a bar
// code, so a recording can be checked against its own START epoch.
//
//   testwin [seconds=12]      prints "WINDOW <CGWindowID>" once it is on screen
//
// Layout (points, origin top-left, window 960x540, borderless):
//   guard bars   x 0..20 white, 20..40 black          y 0..120
//   44 data bars x 40+20i .. 60+20i, i = 0 (MSB) ... 43  y 0..120
//     white = 1, black = 0, value = unix epoch ms of the frame's target display time
//   below: frame counter, a moving block, and a background whose hue follows the frame
import AppKit
import QuartzCore

setvbuf(stdout, nil, _IOLBF, 0)
let seconds = Double(CommandLine.arguments.dropFirst().first ?? "") ?? 12

final class BarView: NSView {
    var frameNo = 0
    var epochMs: UInt64 = 0

    override var isFlipped: Bool { true }

    @objc func tick(_ link: CADisplayLink) {
        // Target display time on the host clock -> wall clock.
        let ahead = link.targetTimestamp - CACurrentMediaTime()
        epochMs = UInt64(((Date().timeIntervalSince1970 + ahead) * 1000).rounded())
        frameNo += 1
        needsDisplay = true
    }

    override func draw(_ dirty: NSRect) {
        let hue = CGFloat(frameNo % 120) / 120
        NSColor(hue: hue, saturation: 0.55, brightness: 0.55, alpha: 1).setFill()
        bounds.fill()
        NSColor.white.setFill(); NSRect(x: 0, y: 0, width: 20, height: 120).fill()
        NSColor.black.setFill(); NSRect(x: 20, y: 0, width: 20, height: 120).fill()
        for i in 0..<44 {
            let bit = (epochMs >> UInt64(43 - i)) & 1
            (bit == 1 ? NSColor.white : NSColor.black).setFill()
            NSRect(x: 40 + 20 * i, y: 0, width: 20, height: 120).fill()
        }
        let x = CGFloat(frameNo % 60) / 60 * (bounds.width - 80)
        NSColor.white.setFill(); NSRect(x: x, y: 150, width: 80, height: 80).fill()
        let text = "frame \(frameNo)   \(epochMs)"
        text.draw(at: NSPoint(x: 40, y: 280), withAttributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 44, weight: .bold),
            .foregroundColor: NSColor.white,
        ])
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let rect = NSRect(x: 0, y: 0, width: 960, height: 540)
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
window.level = .floating
window.isOpaque = true
window.hasShadow = false
let view = BarView(frame: rect)
window.contentView = view
window.center()
window.orderFrontRegardless()
let link = view.displayLink(target: view, selector: #selector(BarView.tick(_:)))
link.add(to: .main, forMode: .common)
DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
    print("WINDOW \(window.windowNumber)")
}
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
app.run()
