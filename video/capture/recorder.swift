// Records one window at a constant frame rate, without the cursor.
//
//   recorder <CGWindowID> <out.mov> [--fps 60] [--codec hevc|h264] [--bitrate 80]
//            [--mode app|window|display|screen] [--start-timeout 8] [--max-seconds 300]
//
// stdout carries exactly two lines, for the harness:
//   START <unix epoch ms of the first recorded frame>   (video t=0 is this instant)
//   STOP <frames written> <dropped>
// Everything else goes to stderr. On stop it also writes <out.mov>.json with the
// geometry and the frame accounting (see video/capture/README.md).
//
// ScreenCaptureKit only delivers a frame when the window's pixels change, so a
// static window produces no frames at all. The writer turns that into constant
// frame rate: frame n of the file has PTS n/fps, and a slot nobody delivered
// repeats the previous picture ("padded"). A delivered frame goes into the slot
// nearest its display time, so file time and wall time agree to half a frame.
//
// Build: swiftc -O video/capture/recorder.swift -o recorder
import AppKit
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import VideoToolbox

setvbuf(stdout, nil, _IOLBF, 0)

func log(_ s: String) { FileHandle.standardError.write(("recorder: " + s + "\n").data(using: .utf8)!) }
func die(_ s: String, _ code: Int32 = 1) -> Never { log("error: " + s); exit(code) }

// ── Arguments ───────────────────────────────────────────────────────────────
var positional: [String] = []
var fps: Int32 = 60
var codec = "hevc"
var bitrateMbps: Double = 80
var startTimeout: Double = 8
var maxSeconds: Double = 300
var captureMode = "app"
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--mode": captureMode = it.next() ?? captureMode
        case "--fps": fps = Int32(it.next() ?? "") ?? fps
        case "--codec": codec = it.next() ?? codec
        case "--bitrate": bitrateMbps = Double(it.next() ?? "") ?? bitrateMbps
        case "--start-timeout": startTimeout = Double(it.next() ?? "") ?? startTimeout
        case "--max-seconds": maxSeconds = Double(it.next() ?? "") ?? maxSeconds
        default: positional.append(a)
        }
    }
}
// A top-level `let` (not a guard binding) so the class below can read it.
let windowID: UInt32 = positional.count == 2 ? UInt32(positional[0]) ?? 0 : 0
if windowID == 0 {
    die("usage: recorder <CGWindowID> <out.mov> [--fps 60] [--codec hevc|h264] [--bitrate 80]", 64)
}
guard codec == "hevc" || codec == "h264" else { die("--codec must be hevc or h264", 64) }
guard ["window", "display", "app", "screen"].contains(captureMode) else { die("--mode must be window, display, app or screen", 64) }
let outURL = URL(fileURLWithPath: positional[1])
try? FileManager.default.removeItem(at: outURL)

func hostSeconds() -> Double { CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())) }

// ── Recorder ────────────────────────────────────────────────────────────────
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "recorder.frames", qos: .userInteractive)
    var stream: SCStream?
    var writer: AVAssetWriter!
    var input: AVAssetWriterInput!
    var adaptor: AVAssetWriterInputPixelBufferAdaptor!
    var padTimer: DispatchSourceTimer?

    var geometry: [String: Any] = [:]
    var pixelW = 0, pixelH = 0

    var firstHost: Double?          // host-clock seconds of the first recorded frame
    var startEpochMs: Double = 0
    var startCorrectionMs: Double = 0
    var lastSlot: Int64 = -1
    var lastBuffer: CVPixelBuffer?
    var stopping = false
    let launchedHost = hostSeconds()

    // Accounting (README: "Frame accounting").
    var written = 0        // slots in the file
    var delivered = 0      // complete frames ScreenCaptureKit handed us
    var padded = 0         // slots filled by repeating the previous picture
    var dropped = 0        // a picture was due but the writer was not ready
    var late = 0           // a delivered frame whose slot had already been padded
    var merged = 0         // two delivered frames in one slot (the later one is kept for the next slot)
    var idle = 0, blank = 0, otherStatus = 0
    var sizeMismatch = 0
    var uniform = 0        // delivered frames that are one flat colour
    var hashes = Set<UInt64>()
    var deliveredSlots: [Int64] = []
    var maxGapSlots: Int64 = 0

    func start() async {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        } catch {
            let ns = error as NSError
            die("SCShareableContent refused: domain=\(ns.domain) code=\(ns.code) \(ns.localizedDescription)", 2)
        }
        guard let win = content.windows.first(where: { $0.windowID == windowID }) else {
            die("window \(windowID) is not in SCShareableContent (\(content.windows.count) windows listed)", 2)
        }
        // Every mode records the window's frame at backing resolution; they
        // differ in what the system believes is being captured.
        //   window:  the window's own image (desktopIndependentWindow).
        //   display: the display composite with only this window in it.
        //   app:     the display composite minus every OTHER application, cropped
        //            to the window (other apps, the Dock and the wallpaper are left out).
        //   screen:  the whole display composite, cropped to the window.
        // On macOS 26 a filter that names the window (window, display) makes the
        // system swap the window's traffic lights for a "being shared" badge,
        // which then sits in every frame.
        let filter: SCContentFilter
        var sourceRect: CGRect? = nil
        let logical = win.frame.size
        if captureMode == "window" {
            filter = SCContentFilter(desktopIndependentWindow: win)
        } else {
            let center = CGPoint(x: win.frame.midX, y: win.frame.midY)
            guard let display = content.displays.first(where: { $0.frame.contains(center) }) ?? content.displays.first else {
                die("no display holds window \(windowID)", 2)
            }
            switch captureMode {
            case "display":
                filter = SCContentFilter(display: display, including: [win])
            case "app":
                let pid = win.owningApplication?.processID
                let others = content.applications.filter { $0.processID != pid }
                filter = SCContentFilter(display: display, excludingApplications: others, exceptingWindows: [])
            default:
                filter = SCContentFilter(display: display, excludingWindows: [])
            }
            sourceRect = CGRect(x: win.frame.minX - display.frame.minX, y: win.frame.minY - display.frame.minY,
                                width: win.frame.width, height: win.frame.height)
            // A display stream stamps a picture one refresh after the moment it
            // reached the screen (measured with tools/testwin.swift: -17.3 ms at
            // 60 Hz, steady to under a millisecond; a window stream is within
            // +-2.5 ms). START is moved back by that refresh so it names the
            // moment the first picture was on screen, which is what the harness's
            // Date.now() stamps are compared with.
            let hz = CGDisplayCopyDisplayMode(display.displayID)?.refreshRate ?? 60
            startCorrectionMs = 1000 / (hz > 0 ? hz : 60)
        }
        let info = SCShareableContent.info(for: filter)
        let scale = Double(info.pointPixelScale)
        pixelW = Int((Double(logical.width) * scale).rounded())
        pixelH = Int((Double(logical.height) * scale).rounded())
        geometry = [
            "mode": captureMode,
            "windowID": Int(windowID),
            "title": win.title ?? "",
            "owner": win.owningApplication?.applicationName ?? "",
            "pid": Int(win.owningApplication?.processID ?? -1),
            "onScreen": win.isOnScreen,
            "logicalW": Double(logical.width), "logicalH": Double(logical.height),
            "scale": scale, "pixelW": pixelW, "pixelH": pixelH,
            "screenFrame": [Double(win.frame.origin.x), Double(win.frame.origin.y), Double(win.frame.width), Double(win.frame.height)],
        ]
        log("window \(windowID) \"\(win.title ?? "")\" owner=\(win.owningApplication?.applicationName ?? "?") pid=\(win.owningApplication?.processID ?? -1) onScreen=\(win.isOnScreen) frame=\(win.frame) scale=\(scale) pixels=\(pixelW)x\(pixelH)")

        let cfg = SCStreamConfiguration()
        cfg.width = pixelW
        cfg.height = pixelH
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: fps)
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.showsCursor = false
        cfg.queueDepth = 8
        cfg.capturesAudio = false
        cfg.captureResolution = .best
        cfg.ignoreShadowsSingleWindow = true
        cfg.ignoreShadowsDisplay = true
        cfg.scalesToFit = false
        if let sourceRect { cfg.sourceRect = sourceRect }

        do {
            writer = try AVAssetWriter(outputURL: outURL, fileType: .mov)
        } catch {
            die("AVAssetWriter: \(error)", 3)
        }
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: Int(bitrateMbps * 1_000_000),
            AVVideoExpectedSourceFrameRateKey: Int(fps),
            AVVideoMaxKeyFrameIntervalKey: Int(fps), // a keyframe a second keeps seeking cheap for the compositor
        ]
        compression[AVVideoProfileLevelKey] = codec == "h264"
            ? AVVideoProfileLevelH264HighAutoLevel
            : kVTProfileLevel_HEVC_Main_AutoLevel as String
        let settings: [String: Any] = [
            AVVideoCodecKey: codec == "h264" ? AVVideoCodecType.h264 : AVVideoCodecType.hevc,
            AVVideoWidthKey: pixelW,
            AVVideoHeightKey: pixelH,
            AVVideoCompressionPropertiesKey: compression,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else { die("writer cannot add the video input (\(codec) \(pixelW)x\(pixelH))", 3) }
        writer.add(input)
        guard writer.startWriting() else { die("startWriting: \(String(describing: writer.error))", 3) }

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        do {
            try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
            try await s.startCapture()
        } catch {
            let ns = error as NSError
            die("startCapture refused: domain=\(ns.domain) code=\(ns.code) \(ns.localizedDescription)", 2)
        }
        stream = s
        log("capturing at \(fps) fps, \(codec) \(bitrateMbps) Mbps -> \(outURL.path)")

        // No complete frame means the window is not being composited (display
        // asleep, the virtual display not viewed, window on another Space). Say so
        // instead of letting the harness wait forever for START.
        queue.asyncAfter(deadline: .now() + startTimeout) { [self] in
            if firstHost == nil && !stopping {
                log("error: no complete frame within \(startTimeout)s (idle=\(idle) blank=\(blank) other=\(otherStatus)); the window is not being drawn")
                exit(4)
            }
        }
        queue.asyncAfter(deadline: .now() + maxSeconds) { [self] in
            if !stopping { log("max-seconds \(maxSeconds) reached, stopping"); stop() }
        }
    }

    // MARK: frames

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, !stopping else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw) else { return }
        switch status {
        case .complete: break
        case .idle: idle += 1; return
        case .blank: blank += 1; return
        default: otherStatus += 1; return
        }
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        delivered += 1
        fingerprint(pb)
        if CVPixelBufferGetWidth(pb) != pixelW || CVPixelBufferGetHeight(pb) != pixelH { sizeMismatch += 1 }

        if firstHost == nil {
            // The frame's PTS is on the host clock; map it to wall time once.
            let lag = hostSeconds() - pts
            startEpochMs = (Date().timeIntervalSince1970 - lag) * 1000 - startCorrectionMs
            firstHost = pts
            writer.startSession(atSourceTime: .zero)
            print(String(format: "START %.1f", startEpochMs))
            log(String(format: "first frame %.1f ms after launch, delivery lag %.1f ms, START moved back %.1f ms (%@ mode)",
                       (pts - launchedHost) * 1000, lag * 1000, startCorrectionMs, captureMode))
            startPadTimer()
        }
        let slot = Int64(((pts - firstHost!) * Double(fps)).rounded())
        if slot <= lastSlot {
            if deliveredSlots.last == slot { merged += 1 } else { late += 1 }
            lastBuffer = pb
            return
        }
        pad(through: slot - 1)
        if append(pb, slot) {
            maxGapSlots = max(maxGapSlots, slot - (deliveredSlots.last ?? slot))
            deliveredSlots.append(slot)
        }
        lastSlot = slot
        lastBuffer = pb
    }

    @discardableResult
    func append(_ pb: CVPixelBuffer, _ slot: Int64) -> Bool {
        guard input.isReadyForMoreMediaData else { dropped += 1; return false }
        if adaptor.append(pb, withPresentationTime: CMTime(value: slot, timescale: fps)) {
            written += 1
            return true
        }
        dropped += 1
        log("append failed at slot \(slot): \(String(describing: writer.error))")
        return false
    }

    /// Repeat the previous picture into every slot up to `slot`.
    func pad(through slot: Int64) {
        guard let pb = lastBuffer else { return }
        var s = lastSlot + 1
        while s <= slot {
            if append(pb, s) { padded += 1 }
            s += 1
        }
        if slot > lastSlot { lastSlot = slot }
    }

    /// Slots whose time has passed with no new picture get the previous one,
    /// three frames behind real time so a slightly late delivery still lands in
    /// its own slot.
    func startPadTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0 / Double(fps), leeway: .milliseconds(2))
        t.setEventHandler { [self] in
            guard let first = firstHost, !stopping else { return }
            let due = Int64(((hostSeconds() - first) * Double(fps)).rounded(.down)) - 3
            if due > lastSlot { pad(through: due) }
        }
        t.resume()
        padTimer = t
    }

    /// Sparse hash + flatness of a delivered frame: blank capture detection runs
    /// on DELIVERED pictures only (padded slots are identical by design).
    func fingerprint(_ pb: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let row = CVPixelBufferGetBytesPerRow(pb)
        let p = base.assumingMemoryBound(to: UInt8.self)
        var hash: UInt64 = 0xcbf29ce484222325
        var lo = 255, hi = 0
        for gy in 0..<48 {
            let y = (h - 1) * gy / 47
            for gx in 0..<64 {
                let x = (w - 1) * gx / 63
                let o = y * row + x * 4
                for c in 0..<3 {
                    hash = (hash ^ UInt64(p[o + c])) &* 0x100000001b3
                }
                let l = (Int(p[o]) + Int(p[o + 1]) * 2 + Int(p[o + 2])) / 4
                lo = min(lo, l); hi = max(hi, l)
            }
        }
        hashes.insert(hash)
        if hi - lo < 4 { uniform += 1 }
    }

    // MARK: stop

    func stop() {
        queue.async { [self] in
            guard !stopping else { return }
            stopping = true
            padTimer?.cancel()
            guard let first = firstHost else {
                log("stopped before the first frame")
                writer?.cancelWriting()
                print("STOP 0 0")
                exit(4)
            }
            // The file runs to the moment the stop was asked for.
            let endSlot = Int64(((hostSeconds() - first) * Double(fps)).rounded(.down))
            pad(through: endSlot)
            let s = stream
            Task { try? await s?.stopCapture() }
            input.markAsFinished()
            writer.endSession(atSourceTime: CMTime(value: lastSlot + 1, timescale: fps))
            writer.finishWriting { [self] in
                if writer.status != .completed {
                    log("finishWriting failed: \(String(describing: writer.error))")
                }
                writeStats()
                print("STOP \(written) \(dropped)")
                exit(writer.status == .completed ? 0 : 5)
            }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let ns = error as NSError
        log("stream stopped with error: domain=\(ns.domain) code=\(ns.code) \(ns.localizedDescription)")
        stop()
    }

    func writeStats() {
        var ru = rusage()
        getrusage(RUSAGE_SELF, &ru)
        let cpu = Double(ru.ru_utime.tv_sec) + Double(ru.ru_utime.tv_usec) / 1e6
            + Double(ru.ru_stime.tv_sec) + Double(ru.ru_stime.tv_usec) / 1e6
        let wall = hostSeconds() - launchedHost
        let seconds = Double(lastSlot + 1) / Double(fps)
        var stats: [String: Any] = geometry
        stats["file"] = outURL.lastPathComponent
        stats["fps"] = Int(fps)
        stats["codec"] = codec
        stats["bitrateMbps"] = bitrateMbps
        stats["startEpochMs"] = startEpochMs
        stats["startCorrectionMs"] = startCorrectionMs
        stats["seconds"] = seconds
        stats["framesWritten"] = written
        stats["delivered"] = delivered
        stats["deliveredFps"] = seconds > 0 ? Double(delivered) / seconds : 0
        stats["padded"] = padded
        stats["dropped"] = dropped
        stats["late"] = late
        stats["merged"] = merged
        stats["maxGapSlots"] = maxGapSlots
        stats["statusIdle"] = idle
        stats["statusBlank"] = blank
        stats["statusOther"] = otherStatus
        stats["sizeMismatch"] = sizeMismatch
        stats["uniqueDelivered"] = hashes.count
        stats["uniformDelivered"] = uniform
        stats["blankSuspect"] = delivered > 1 && (hashes.count <= 1 || uniform == delivered)
        stats["cpuSeconds"] = cpu
        stats["cpuPercent"] = wall > 0 ? cpu / wall * 100 : 0
        stats["deliveredSlots"] = deliveredSlots
        if let data = try? JSONSerialization.data(withJSONObject: stats, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: outURL.path + ".json"))
        }
        log(String(format: "written=%d delivered=%d (%.1f/s) padded=%d dropped=%d late=%d merged=%d unique=%d uniform=%d cpu=%.0f%%",
                   written, delivered, seconds > 0 ? Double(delivered) / seconds : 0, padded, dropped, late, merged,
                   hashes.count, uniform, wall > 0 ? cpu / wall * 100 : 0))
        if delivered > 1 && (hashes.count <= 1 || uniform == delivered) {
            log("error: BLANK CAPTURE suspected: \(delivered) delivered frames, \(hashes.count) distinct, \(uniform) flat")
        }
    }
}

// A bare command-line tool has no window-server connection, and ScreenCaptureKit
// then aborts in CoreGraphics ("Assertion failed: (did_initialize), function
// CGS_REQUIRE_INIT"). Creating the shared application opens that connection;
// it never shows a Dock icon or a menu bar with .prohibited.
NSApplication.shared.setActivationPolicy(.prohibited)
_ = CGMainDisplayID()

let recorder = Recorder()
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { recorder.stop() }
    src.resume()
    signalSources.append(src)
}
Task { await recorder.start() }
// A real run loop (not dispatchMain): it also drains the main queue, and some
// system frameworks deliver through main-thread run loop sources.
RunLoop.main.run()
