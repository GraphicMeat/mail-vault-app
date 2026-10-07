// Reads a recorded clip back frame by frame and reports what is really in it.
//
//   framestats <clip.mov> [--rec clip.mov.json] [--barcode] [--actions actions.json]
//              [--png 0,30,90] [--png-events] [--png-width 1600] [--outdir dir] [--csv frames.csv]
//
// JSON on stdout:
//   size, codec, duration, frame count and the frame rate the file really has;
//   content changes (frames that differ from the one before) and distinct pictures,
//     which is the blank-capture check on the FILE side;
//   --barcode  decodes tools/testwin.swift's bar code in every frame and compares the
//              painted wall-clock time with START + t (the recorder's clock);
//   --actions  for every click / type event: the frame at the logged t, and the
//              first frame at or after it where the picture actually changed.
//   --png      writes those frame indices as PNG (downscaled to --png-width);
//   --png-events writes, per click, the last frame before the change and the first after.
import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)
func log(_ s: String) { FileHandle.standardError.write(("framestats: " + s + "\n").data(using: .utf8)!) }

var positional: [String] = []
var recPath: String?
var actionsPath: String?
var barcode = false
var pngFrames = Set<Int>()
var pngEvents = false
var pngWidth = 1600
var outDir = "."
var csvPath: String?
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--rec": recPath = it.next()
        case "--actions": actionsPath = it.next()
        case "--barcode": barcode = true
        case "--png": for p in (it.next() ?? "").split(separator: ",") { if let n = Int(p) { pngFrames.insert(n) } }
        case "--png-events": pngEvents = true
        case "--png-width": pngWidth = Int(it.next() ?? "") ?? pngWidth
        case "--outdir": outDir = it.next() ?? outDir
        case "--csv": csvPath = it.next()
        default: positional.append(a)
        }
    }
}
guard positional.count == 1 else { log("usage: framestats <clip.mov> [options]"); exit(64) }
let clipURL = URL(fileURLWithPath: positional[0])

func readJSON(_ path: String?) -> [String: Any]? {
    guard let path, let d = FileManager.default.contents(atPath: path) else { return nil }
    return (try? JSONSerialization.jsonObject(with: d)) as? [String: Any]
}
let rec = readJSON(recPath)
let actions = readJSON(actionsPath)
let startEpochMs = (rec?["startEpochMs"] as? Double) ?? (actions?["recorderStartEpochMs"] as? Double)

// ── Regions to watch, one per distinct event bbox ───────────────────────────
struct Region: Hashable { let x: Int, y: Int, w: Int, h: Int }
struct Watch { let index: Int; let type: String; let label: String; let t: Double; let raf: Double?; let region: Region? }
var watches: [Watch] = []
var regionSamples: [Region: [[UInt8]]] = [:]   // region -> per-frame dense luma samples (step 2px)
var scale = 2.0
if let actions, let events = actions["events"] as? [[String: Any]] {
    // Event boxes are in window logical px, so window px = box * scale.
    scale = (actions["window"] as? [String: Any])?["scale"] as? Double ?? 2
    for (i, e) in events.enumerated() {
        let type = e["type"] as? String ?? ""
        guard type == "click" || type == "type" else { continue }
        var region: Region?
        // Typing changes a few glyphs inside the field: watch the field. A click's
        // effect can land anywhere (a pane opens), so it is judged on the whole frame.
        if type == "type", let b = e["bbox"] as? [String: Any],
           let bx = b["x"] as? Double, let by = b["y"] as? Double, let bw = b["w"] as? Double, let bh = b["h"] as? Double {
            region = Region(x: Int(bx * scale), y: Int(by * scale), w: Int(bw * scale), h: Int(bh * scale))
        }
        watches.append(Watch(index: i, type: type, label: e["label"] as? String ?? "", t: e["t"] as? Double ?? 0,
                             raf: e["raf"] as? Double, region: region))
        if let region { regionSamples[region] = [] }
    }
}

// ── Pixel helpers ───────────────────────────────────────────────────────────
@inline(__always) func luma(_ p: UnsafePointer<UInt8>, _ o: Int) -> UInt8 {
    UInt8((Int(p[o]) + Int(p[o + 1]) * 2 + Int(p[o + 2])) / 4)   // BGRA
}

func writePNG(_ pb: CVPixelBuffer, _ name: String) {
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    guard let base = CVPixelBufferGetBaseAddress(pb),
          let src = CGContext(data: base, width: w, height: h, bitsPerComponent: 8,
                              bytesPerRow: CVPixelBufferGetBytesPerRow(pb), space: space, bitmapInfo: info),
          let full = src.makeImage() else { log("png: cannot wrap frame for \(name)"); return }
    var image = full
    if pngWidth > 0 && pngWidth < w {
        let th = Int((Double(h) * Double(pngWidth) / Double(w)).rounded())
        if let ctx = CGContext(data: nil, width: pngWidth, height: th, bitsPerComponent: 8, bytesPerRow: 0,
                               space: space, bitmapInfo: info) {
            ctx.interpolationQuality = .high
            ctx.draw(full, in: CGRect(x: 0, y: 0, width: pngWidth, height: th))
            if let scaled = ctx.makeImage() { image = scaled }
        }
    }
    try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    let url = URL(fileURLWithPath: outDir).appendingPathComponent(name)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
}

func percentile(_ xs: [Double], _ p: Double) -> Double {
    guard !xs.isEmpty else { return .nan }
    let s = xs.sorted()
    return s[min(s.count - 1, max(0, Int((Double(s.count - 1) * p).rounded())))]
}

/// JSONSerialization refuses NaN; an empty statistic is null.
func num(_ d: Double?) -> Any { guard let d, d.isFinite else { return NSNull() }; return d }

// ── Read ────────────────────────────────────────────────────────────────────
func run() async {
    let asset = AVURLAsset(url: clipURL)
    let tracks: [AVAssetTrack]
    let duration: CMTime
    do {
        tracks = try await asset.loadTracks(withMediaType: .video)
        duration = try await asset.load(.duration)
    } catch { log("cannot load \(clipURL.path): \(error)"); exit(2) }
    guard let track = tracks.first else { log("no video track"); exit(2) }
    var natural = CGSize.zero
    var nominal: Float = 0
    var minDur = CMTime.invalid
    var formats: [CMFormatDescription] = []
    if let r = try? await track.load(.naturalSize, .nominalFrameRate, .minFrameDuration, .formatDescriptions) {
        (natural, nominal, minDur, formats) = r
    }
    var codec = "?"
    if let f = formats.first {
        let c = CMFormatDescriptionGetMediaSubType(f)
        codec = String(bytes: [UInt8(c >> 24 & 0xff), UInt8(c >> 16 & 0xff), UInt8(c >> 8 & 0xff), UInt8(c & 0xff)], encoding: .ascii) ?? "?"
    }

    guard let reader = try? AVAssetReader(asset: asset) else { log("AVAssetReader failed"); exit(2) }
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    ])
    out.alwaysCopiesSampleData = false
    reader.add(out)
    reader.startReading()

    let fps = Double(nominal > 0 ? nominal : 60)
    var times: [Double] = []
    var diffs: [Double] = []
    var hashes: [UInt64] = []
    var decoded: [Int64?] = []
    var prevGrid: [UInt8] = []
    var firstCorner: [UInt8] = []
    var cornerChangedFrames = 0, firstCornerChange = -1
    var maxCornerDiff = 0.0
    var i = 0
    var width = 0, height = 0
    var pngWanted = pngFrames

    while let sb = out.copyNextSampleBuffer() {
        guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }
        let t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        width = w; height = h
        let row = CVPixelBufferGetBytesPerRow(pb)
        let p = UnsafePointer(CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self))

        // Whole-frame grid: 160x100 samples.
        var grid = [UInt8](repeating: 0, count: 160 * 100)
        var hash: UInt64 = 0xcbf29ce484222325
        for gy in 0..<100 {
            let y = (h - 1) * gy / 99
            for gx in 0..<160 {
                let x = (w - 1) * gx / 159
                let v = luma(p, y * row + x * 4)
                grid[gy * 160 + gx] = v
                hash = (hash ^ UInt64(v)) &* 0x100000001b3
            }
        }
        var diff = 0.0
        if !prevGrid.isEmpty {
            var sum = 0
            for k in 0..<grid.count { sum += abs(Int(grid[k]) - Int(prevGrid[k])) }
            diff = Double(sum) / Double(grid.count)
        }
        prevGrid = grid

        // Title bar corner (traffic lights): macOS 26 replaces them with a
        // "window is being shared" badge under some capture modes. Compare every
        // frame's corner with the first frame's.
        var corner: [UInt8] = []
        var cy = 0
        while cy < min(h, 64) { var cx = 0; while cx < min(w, 300) { corner.append(luma(p, cy * row + cx * 4)); cx += 2 }; cy += 2 }
        if firstCorner.isEmpty { firstCorner = corner } else {
            var sum = 0
            for k in 0..<min(corner.count, firstCorner.count) { sum += abs(Int(corner[k]) - Int(firstCorner[k])) }
            let d = Double(sum) / Double(max(1, corner.count))
            if d > 2 { cornerChangedFrames += 1; if firstCornerChange < 0 { firstCornerChange = i } }
            maxCornerDiff = max(maxCornerDiff, d)
        }

        for region in Array(regionSamples.keys) {
            var s: [UInt8] = []
            let x0 = max(0, min(w - 1, region.x)), y0 = max(0, min(h - 1, region.y))
            let x1 = max(x0, min(w, region.x + region.w)), y1 = max(y0, min(h, region.y + region.h))
            s.reserveCapacity(((x1 - x0) / 2 + 1) * ((y1 - y0) / 2 + 1))
            var y = y0
            while y < y1 { var x = x0; while x < x1 { s.append(luma(p, y * row + x * 4)); x += 2 }; y += 2 }
            regionSamples[region]!.append(s)
        }

        if barcode {
            // testwin.swift layout, in points; the frame is the window at `sc` px/pt.
            let sc = Double(w) / 960
            func bit(_ xPt: Double) -> Int? {
                let cx = Int(xPt * sc), cy = Int(60 * sc)
                var sum = 0
                for dy in -2...2 { for dx in -2...2 { sum += Int(luma(p, (cy + dy) * row + (cx + dx) * 4)) } }
                let v = sum / 25
                return v > 170 ? 1 : v < 85 ? 0 : nil
            }
            var value: Int64? = nil
            if bit(10) == 1 && bit(30) == 0 {
                var acc: Int64 = 0
                var ok = true
                for k in 0..<44 {
                    guard let b = bit(50 + 20 * Double(k)) else { ok = false; break }
                    acc = acc << 1 | Int64(b)
                }
                if ok { value = acc }
            }
            decoded.append(value)
        }
        CVPixelBufferUnlockBaseAddress(pb, .readOnly)

        if pngWanted.contains(i) { writePNG(pb, String(format: "frame-%05d.png", i)); pngWanted.remove(i) }
        times.append(t); diffs.append(diff); hashes.append(hash)
        i += 1
    }
    if reader.status == .failed { log("reader failed: \(String(describing: reader.error))") }

    // ── Summary ─────────────────────────────────────────────────────────────
    let n = times.count
    let seconds = CMTimeGetSeconds(duration)
    var ptsJitter = 0.0
    for (k, t) in times.enumerated() { ptsJitter = max(ptsJitter, abs(t - Double(k) / fps)) }
    let changes = diffs.enumerated().filter { $0.offset > 0 && $0.element > 0.05 }.count
    var summary: [String: Any] = [
        "file": clipURL.lastPathComponent,
        "width": width, "height": height,
        "naturalSize": [Double(natural.width), Double(natural.height)],
        "codec": codec,
        "durationSeconds": num(seconds),
        "frames": n,
        "nominalFps": Double(nominal),
        "measuredFps": seconds > 0 ? Double(n) / seconds : 0,
        "minFrameDurationSeconds": num(CMTimeGetSeconds(minDur)),
        "maxPtsDeviationFromCfrMs": ptsJitter * 1000,
        "contentChanges": changes,
        "distinctPictures": Set(hashes).count,
        "blankSuspect": n > 1 && Set(hashes).count <= 1,
        "titleBarCorner": ["framesDifferentFromFirst": cornerChangedFrames, "firstDifferentFrame": firstCornerChange,
                           "maxMeanDiff": maxCornerDiff] as [String: Any],
        "fileBytes": ((try? FileManager.default.attributesOfItem(atPath: clipURL.path))?[.size] as? Int) ?? 0,
    ]
    if let startEpochMs { summary["startEpochMs"] = startEpochMs }

    if barcode {
        let valid = decoded.compactMap { $0 }
        var offsets: [Double] = []
        var fresh = 0
        var last: Int64? = nil
        for (k, v) in decoded.enumerated() {
            guard let v else { continue }
            if v != last { fresh += 1 }
            last = v
            if let s = startEpochMs { offsets.append(Double(v) - (s + times[k] * 1000)) }
        }
        // Offsets only for frames that carry a NEW picture: a padded repeat shows an
        // older time by construction.
        var freshOffsets: [Double] = []
        last = nil
        for (k, v) in decoded.enumerated() {
            guard let v else { continue }
            if v != last, let s = startEpochMs { freshOffsets.append(Double(v) - (s + times[k] * 1000)) }
            last = v
        }
        summary["barcode"] = [
            "decoded": valid.count,
            "undecodable": n - valid.count,
            "freshPictures": fresh,
            "freshPicturesPerSecond": seconds > 0 ? Double(fresh) / seconds : 0,
            "offsetMsFresh": ["min": num(freshOffsets.min()), "p05": num(percentile(freshOffsets, 0.05)),
                              "p50": num(percentile(freshOffsets, 0.5)),
                              "p95": num(percentile(freshOffsets, 0.95)), "max": num(freshOffsets.max())],
            "offsetMsAll": ["min": num(offsets.min()), "p50": num(percentile(offsets, 0.5)), "max": num(offsets.max())],
            "note": "offset = painted target-display epoch - (START + frame t); negative means the frame shows an earlier time than its slot",
        ] as [String: Any]
    }

    if !watches.isEmpty {
        let fullBaseline = percentile(diffs.filter { $0 > 0 }, 0.5)
        var rows: [[String: Any]] = []
        var eventPngs: [Int: String] = [:]
        for wch in watches {
            let fLog = Int((wch.t * fps).rounded())
            var first: Int? = nil
            var mag = 0.0
            // The first frame after the dispatch instant: nothing the event causes
            // can be on screen earlier, and starting any earlier lets fast typing
            // pick up the previous key's paint.
            let from = max(1, Int((wch.t * fps).rounded(.down)) + 1)
            if let region = wch.region, let samples = regionSamples[region] {
                for f in from..<max(from, min(n, fLog + 30)) {
                    let a = samples[f], b = samples[f - 1]
                    var sum = 0
                    for k in 0..<min(a.count, b.count) { sum += abs(Int(a[k]) - Int(b[k])) }
                    let d = a.isEmpty ? 0 : Double(sum) / Double(a.count)
                    if d > 0.3 { first = f; mag = d; break }
                }
            } else {
                // A click that opens or swaps a pane moves a lot of pixels.
                let threshold = max(1.0, (fullBaseline.isNaN ? 0 : fullBaseline) * 4)
                for f in from..<max(from, min(n, fLog + 60)) where diffs[f] > threshold { first = f; mag = diffs[f]; break }
            }
            var r: [String: Any] = ["event": wch.index, "type": wch.type, "label": wch.label, "t": wch.t, "frameAtT": fLog]
            if let raf = wch.raf { r["raf"] = raf; r["frameAtRaf"] = Int((raf * fps).rounded()) }
            if let first {
                r["firstChangedFrame"] = first
                r["framesAfterT"] = first - fLog
                r["changeMagnitude"] = mag
                if pngEvents && wch.type == "click" {
                    eventPngs[first - 1] = "click-\(wch.label)-f\(first - 1)-before.png"
                    eventPngs[first] = "click-\(wch.label)-f\(first)-after.png"
                }
            } else {
                r["firstChangedFrame"] = NSNull()
            }
            rows.append(r)
        }
        summary["events"] = rows
        let lags = rows.compactMap { $0["framesAfterT"] as? Int }
        summary["eventLagFrames"] = ["count": lags.count, "min": num(lags.min().map(Double.init)),
                                     "max": num(lags.max().map(Double.init)),
                                     "p50": num(percentile(lags.map(Double.init), 0.5))]
        // Second pass for the event frames: cheaper than holding every frame.
        if !eventPngs.isEmpty, let r2 = try? AVAssetReader(asset: asset) {
            let o2 = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            o2.alwaysCopiesSampleData = false
            r2.add(o2); r2.startReading()
            var k = 0
            while let sb = o2.copyNextSampleBuffer() {
                if let name = eventPngs[k], let pb = CMSampleBufferGetImageBuffer(sb) { writePNG(pb, name) }
                k += 1
            }
        }
    }

    if let csvPath {
        var csv = "frame,t,diff,hash\n"
        for k in 0..<n { csv += String(format: "%d,%.5f,%.3f,%016llx\n", k, times[k], diffs[k], hashes[k]) }
        try? csv.write(toFile: csvPath, atomically: true, encoding: .utf8)
    }

    let data = try! JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    exit(0)
}

Task { await run() }
dispatchMain()
