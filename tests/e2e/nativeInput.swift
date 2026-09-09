// Native input for macOS WebKit E2E tests. tauri-wd 0.1.3's Actions endpoint
// dispatches MouseEvents (no pointer capture) and does not decode special keys.
import AppKit
import CoreGraphics

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count == 8 else { fail("Expected app path, action, from x/y, to x/y, release") }
guard CGPreflightPostEventAccess() else { fail("Native mouse input requires existing Accessibility permission") }
let appPath = URL(fileURLWithPath: args[1]).standardizedFileURL.path
let apps = NSWorkspace.shared.runningApplications.filter {
    $0.executableURL?.standardizedFileURL.path == appPath
}
guard apps.count == 1, let app = apps.first else { fail("Expected exactly one running test app at \(appPath)") }
guard let fromX = Double(args[3]), let fromY = Double(args[4]),
      let toX = Double(args[5]), let toY = Double(args[6]) else { fail("Invalid mouse coordinates") }
let from = CGPoint(x: fromX, y: fromY)
let to = CGPoint(x: toX, y: toY)
let source = CGEventSource(stateID: .hidSystemState)

func post(_ type: CGEventType, _ point: CGPoint) {
    guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                              mouseCursorPosition: point, mouseButton: .left) else { fail("Cannot create mouse event") }
    event.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.025)
}

if args[2] == "release" {
    post(.leftMouseUp, to)
    exit(0)
}

app.activate(options: [])
for _ in 0..<20 {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { break }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
}
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else {
    fail("The test app could not take focus")
}
if args[2] == "key" {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(fromX), keyDown: down) else {
            fail("Cannot create keyboard event")
        }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
    }
    exit(0)
}
post(.mouseMoved, from)
post(.leftMouseDown, from)
for step in 1...16 {
    let progress = Double(step) / 16
    post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * progress,
                                    y: from.y + (to.y - from.y) * progress))
}
if args[7] == "true" { post(.leftMouseUp, to) }
