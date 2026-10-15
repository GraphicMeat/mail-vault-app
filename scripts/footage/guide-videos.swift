// Pure app action: no title cards, subtitles, borders or end screens.
// Run on macmini: swift scripts/footage/guide-videos.swift <raw-takes-directory> <output-directory>
import AppKit
import Foundation

struct Guide { let slug: String, clip: String }
let guides = [
    Guide(slug: "backup-archived-email", clip: "manual-backup"),
    Guide(slug: "archive-delete-keep-local", clip: "archive-delete"),
    Guide(slug: "search-local-archive", clip: "search-local")
]
// Camera positions are normalized against the ORIGINAL app-window recording.
// Start wide, let the real click land, then move toward the resulting activity.
struct CameraPoint { let time: Double, zoom: Double, x: Double, y: Double }
func camera(_ clip: String, _ duration: Double, _ firstClick: Double, _ vaultClick: Double?, _ complete: Double?) -> [CameraPoint] {
    let start = CameraPoint(time: 0, zoom: 1, x: 0.5, y: 0.5)
    let clicked = CameraPoint(time: firstClick + 0.12, zoom: 1, x: 0.5, y: 0.5)
    switch clip {
    case "manual-backup": return [start, clicked,
        .init(time: firstClick + 1.02, zoom: 1.55, x: 0.575, y: 0.43),
        .init(time: max(firstClick + 1.3, duration - 2.4), zoom: 1.55, x: 0.575, y: 0.43),
        .init(time: duration - 1.25, zoom: 1.55, x: 0.575, y: 0.65),
        .init(time: duration - 0.05, zoom: 1.55, x: 0.575, y: 0.65)]
    case "archive-delete":
        let finished = complete!, vault = vaultClick!
        return [start, clicked,
            .init(time: firstClick + 1.02, zoom: 2.8, x: 0.88, y: 0.915),
            .init(time: finished - 0.1, zoom: 2.8, x: 0.88, y: 0.915),
            .init(time: finished + 0.75, zoom: 1, x: 0.5, y: 0.5),
            .init(time: vault + 0.12, zoom: 1, x: 0.5, y: 0.5),
            .init(time: vault + 1.02, zoom: 1.9, x: 0.32, y: 0.32),
            .init(time: duration - 0.05, zoom: 1.9, x: 0.32, y: 0.32)]
    default: return [start, clicked,
        .init(time: firstClick + 0.95, zoom: 2.05, x: 0.33, y: 0.28),
        .init(time: firstClick + 1.45, zoom: 2.05, x: 0.33, y: 0.28),
        .init(time: firstClick + 2.3, zoom: 1.95, x: 0.33, y: 0.43),
        .init(time: duration - 0.05, zoom: 1.95, x: 0.33, y: 0.43)]
    }
}
// Smoothstep has zero velocity at both ends, so a hold never ends with a jerk.
func expression(_ points: [CameraPoint], _ field: KeyPath<CameraPoint, Double>) -> String {
    var value = String(points.last![keyPath: field])
    for i in (0..<(points.count - 1)).reversed() {
        let a = points[i], b = points[i + 1]
        let u = "clip((on/30-\(a.time))/\(b.time-a.time),0,1)"
        let eased = "(\(u)*\(u)*(3-2*\(u)))"
        value = "if(lt(on/30,\(b.time)),\(a[keyPath: field])+(\(b[keyPath: field]-a[keyPath: field]))*\(eased),\(value))"
    }
    return value
}
func checkCamera(_ points: [CameraPoint]) {
    precondition(points.count > 1 && points[0].time == 0)
    for (i, p) in points.enumerated() {
        precondition(p.zoom >= 1 && p.zoom <= 3 && (0...1).contains(p.x) && (0...1).contains(p.y))
        if i > 0 { precondition(p.time > points[i-1].time) }
    }
}
let args = CommandLine.arguments
 guard args.count == 3 else { fatalError("usage: swift guide-videos.swift <raw-takes-directory> <output-directory>") }
let takes = URL(fileURLWithPath: args[1]), out = URL(fileURLWithPath: args[2])
let fm = FileManager.default
try fm.createDirectory(at: out, withIntermediateDirectories: true)
let scratch = fm.temporaryDirectory.appendingPathComponent("mailvault-guides-" + UUID().uuidString)
try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
let ffmpeg = "/opt/homebrew/bin/ffmpeg", ffprobe = "/opt/homebrew/bin/ffprobe"
@discardableResult func run(_ executable: String, _ arguments: [String], capture: Bool = false) throws -> String {
    let p = Process(); p.executableURL = URL(fileURLWithPath: executable); p.arguments = arguments
    let pipe = Pipe()
    if capture { p.standardOutput = pipe }
    try p.run()
    let data = capture ? pipe.fileHandleForReading.readDataToEndOfFile() : Data()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { throw NSError(domain: "GuideVideo", code: Int(p.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "Failed: \(executable) \(arguments)"]) }
    return String(data: data, encoding: .utf8) ?? ""
}
// The recorder deliberately excludes the OS pointer. Rebuild its motion from
// the harness action log so the click is visible before the camera follows it.
let cursorHotSpot = CGPoint(x: 1, y: 1)
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 48, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill(); NSRect(x: 0, y: 0, width: 48, height: 64).fill()
let arrow = NSBezierPath()
for (i, point) in [(2.0,2.0),(2,49),(14,38),(23,58),(30,54),(21,34),(39,34)].enumerated() {
    let p = NSPoint(x: point.0, y: 64 - point.1)
    if i == 0 { arrow.move(to: p) } else { arrow.line(to: p) }
}
arrow.close(); NSColor.white.setFill(); arrow.fill()
NSColor.black.setStroke(); arrow.lineWidth = 2.5; arrow.lineJoinStyle = .round; arrow.stroke()
NSGraphicsContext.restoreGraphicsState()
let cursorPNG = scratch.appendingPathComponent("cursor.png")
try bitmap.representation(using: .png, properties: [:])!.write(to: cursorPNG)

var manifest: [[String: Any]] = []
for g in guides {
    let source = takes.appendingPathComponent("\(g.clip).mov")
    let actions = try JSONSerialization.jsonObject(with: Data(contentsOf: takes.appendingPathComponent("\(g.clip).actions.json"))) as! [String: Any]
    let spec = try JSONSerialization.jsonObject(with: Data(contentsOf: takes.appendingPathComponent("\(g.clip).webclip.json"))) as! [String: Any]
    let events = actions["events"] as! [[String: Any]]
    let segments = spec["segments"] as! [[String: Any]]
    let trimStart = min(0.4, segments[0]["t0"] as! Double)
    func click(_ label: String) -> Double {
        let e = events.first { ($0["type"] as? String) == "click" && ($0["label"] as? String) == label }!
        return (e["shown"] as? Double ?? e["t"] as! Double) - trimStart
    }
    let firstClick = click(g.clip == "manual-backup" ? "back-up-all" : g.clip == "archive-delete" ? "confirm" : "search-box")
    let raw = try run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", source.path], capture: true)
    let sourceDuration = Double(raw.trimmingCharacters(in: .whitespacesAndNewlines))!
    let duration = min(sourceDuration, segments.last!["t1"] as! Double) - trimStart
    let vaultClick = g.clip == "archive-delete" ? click("source-vault") : nil
    let complete = g.clip == "archive-delete" ? ((segments.first { ($0["label"] as? String) == "count-before" }!["t0"] as! Double) + 0.8 - trimStart) : nil
    let points = camera(g.clip, duration, firstClick, vaultClick, complete)
    checkCamera(points)
    precondition(points[0].zoom == 1 && points[1].zoom == 1 && points[1].time > firstClick)
    let z = expression(points, \.zoom), cx = expression(points, \.x), cy = expression(points, \.y)
    let zoom = "fps=30,pad=iw*2:ih*2:iw/2:ih/2:color=0x111111,zoompan=z='2*(\(z))':x='iw*((\(cx))+0.5)/2-iw/zoom/2':y='ih*((\(cy))+0.5)/2-ih/zoom/2':d=1:s=1440x900:fps=30"
    let window = actions["window"] as! [String: Any]
    let scale = window["scale"] as! Double
    var pointer = [CameraPoint(time: 0, zoom: 1, x: (window["logicalW"] as! Double) / 2, y: (window["logicalH"] as! Double) / 2)]
    for event in events where (event["type"] as? String) == "move" {
        let t = max(0, (event["t"] as! Double) - trimStart)
        let last = pointer.last!
        if t > last.time { pointer.append(.init(time: t, zoom: 1, x: last.x, y: last.y)) }
        let arrival = t + (event["dur"] as? Double ?? 0.4)
        pointer.append(.init(time: arrival, zoom: 1, x: event["x"] as! Double, y: event["y"] as! Double))
    }
    let px = expression(pointer, \.x).replacingOccurrences(of: "on/30", with: "t")
    let py = expression(pointer, \.y).replacingOccurrences(of: "on/30", with: "t")
    let composite = "[1:v]scale=iw*\(scale)/2:ih*\(scale)/2[cursor];[0:v]fps=30,setpts=PTS-STARTPTS[raw];[raw][cursor]overlay=x='(\(px)-\(cursorHotSpot.x))*\(scale)':y='(\(py)-\(cursorHotSpot.y))*\(scale)':eval=frame:format=auto,\(zoom),format=yuv420p[v]"
    let destination = out.appendingPathComponent(g.slug + "-full-window-v4.mp4")
    try run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(trimStart), "-i", source.path, "-loop", "1", "-i", cursorPNG.path, "-t", String(duration), "-filter_complex", composite, "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", "-movflags", "+faststart", destination.path])
    let durationRaw = try run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", destination.path], capture: true)
    let measuredDuration = Double(durationRaw.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    precondition(abs(measuredDuration - duration) < 0.1, "Duration mismatch: \(measuredDuration) vs \(duration)")
    let poster = 0.1
    try run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(poster), "-i", destination.path, "-frames:v", "1", "-q:v", "2", out.appendingPathComponent(g.slug + "-full-window-v4.jpg").path])
    try run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", destination.path, "-f", "null", "-"])
    manifest.append(["slug":g.slug,"file":destination.lastPathComponent,"source":"takes/\(g.clip).mov","sourceDuration":sourceDuration,"duration":measuredDuration,"width":1440,"height":900,"host":ProcessInfo.processInfo.hostName,"fictionalMail":true,"edits":"Original full app-window recording. Pointer follows the action log. Click shown at full scale; smoothstep zoom follows the click. No added text or captions.","firstClickAt":firstClick,"zoomStartsAt":points[1].time,"motionVersion":4])
    print("Encoded, timed and decoded \(destination.lastPathComponent)")
}
let data = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted,.sortedKeys])
try data.write(to: out.appendingPathComponent("manifest.json"))
