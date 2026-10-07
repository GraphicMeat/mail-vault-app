// Where the pointer is, and (for the no-cursor proof) putting it somewhere.
//
//   cursor              -> "cursor <x> <y>"   global points, origin top-left of the main display
//   cursor set <x> <y>  -> moves the pointer there (no click, no event), then prints as above
//
// The recorder is configured with showsCursor = false; parking the pointer over
// the captured window before a take is what turns "no cursor in the frames" from
// luck into evidence.
import AppKit

setvbuf(stdout, nil, _IOLBF, 0)
NSApplication.shared.setActivationPolicy(.prohibited)

func location() -> CGPoint { CGEvent(source: nil)?.location ?? CGPoint(x: -1, y: -1) }

let args = CommandLine.arguments
var note = ""
if args.count >= 4, args[1] == "set", let x = Double(args[2]), let y = Double(args[3]) {
    let err = CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    note = " warp=\(err.rawValue)"
    usleep(150_000)
}
let p = location()
print("cursor \(p.x) \(p.y)\(note)")
