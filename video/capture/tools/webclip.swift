// Cuts a recorded take into a small web clip: crop, scale, trim, H.264, a poster.
//
//   webclip <in.mov> <out.mp4> --spec <spec.json> [--poster out.jpg] [--frames-dir dir]
//
// For the website's feature cards (muted, looping, 960x660 stored). There is no
// ffmpeg on the runners, so this does with AVFoundation what an ffmpeg command
// would: read the HEVC take, crop each segment's rectangle out of it, Lanczos-
// scale it to the output size, keep 30 fps, write H.264 High 4:2:0 with BT.709
// tags, no audio, `moov` before `mdat` (shouldOptimizeForNetworkUse, the
// +faststart equivalent). VideoToolbox has no CRF, so the size is hit with an
// average-bitrate loop: encode, measure, scale the bitrate, up to --passes,
// keeping the best result at or under maxBytes.
//
// spec.json (window POINTS, like actions.json; the source is points x scale):
//   { "scale": 2, "size": [960, 660], "fps": 30, "maxBytes": 250000,
//     "crop": [x, y, w, h],                       // default for every segment
//     "segments": [ { "t0": 1.2, "t1": 3.0, "crop": [x, y, w, h]? }, ... ],
//     "poster": 4.2,                              // output seconds
//     "frames": [0.2, 1.5, 3.0, 4.8] }            // output seconds, JPGs to inspect
//
// stdout: one JSON report (passes, bitrate, bytes, verification of the file it
// wrote: codec, size, fps, frame count, audio tracks, top-level atom order).
import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)
func log(_ s: String) { FileHandle.standardError.write(("webclip: " + s + "\n").data(using: .utf8)!) }
func fail(_ s: String, _ code: Int32 = 1) -> Never { log(s); exit(code) }

var positional: [String] = []
var specPath: String?
var posterPath: String?
var framesDir: String?
var passes = 5
do {
    var it = CommandLine.arguments.dropFirst().makeIterator()
    while let a = it.next() {
        switch a {
        case "--spec": specPath = it.next()
        case "--poster": posterPath = it.next()
        case "--frames-dir": framesDir = it.next()
        case "--passes": passes = Int(it.next() ?? "") ?? passes
        default: positional.append(a)
        }
    }
}
guard positional.count == 2, let specPath else { fail("usage: webclip <in.mov> <out.mp4> --spec spec.json [--poster p.jpg] [--frames-dir d]", 64) }
let inURL = URL(fileURLWithPath: positional[0])
let outURL = URL(fileURLWithPath: positional[1])
guard let specData = FileManager.default.contents(atPath: specPath),
      let spec = (try? JSONSerialization.jsonObject(with: specData)) as? [String: Any] else { fail("cannot read \(specPath)") }

func num(_ v: Any?) -> Double? { (v as? NSNumber)?.doubleValue }
func rect(_ v: Any?) -> CGRect? {
    guard let a = v as? [Any], a.count == 4, let x = num(a[0]), let y = num(a[1]), let w = num(a[2]), let h = num(a[3]) else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}
let scale = num(spec["scale"]) ?? 2
let size = (spec["size"] as? [Any]).flatMap { a in a.count == 2 ? (Int(num(a[0]) ?? 960), Int(num(a[1]) ?? 660)) : nil } ?? (960, 660)
let outW = size.0, outH = size.1
let fps = num(spec["fps"]) ?? 30
let maxBytes = Int(num(spec["maxBytes"]) ?? 250_000)
let defaultCrop = rect(spec["crop"])
struct Segment { let t0: Double; let t1: Double; let crop: CGRect }
let segments: [Segment] = ((spec["segments"] as? [[String: Any]]) ?? []).compactMap { s in
    guard let t0 = num(s["t0"]), let t1 = num(s["t1"]), t1 > t0, let c = rect(s["crop"]) ?? defaultCrop else { return nil }
    return Segment(t0: t0, t1: t1, crop: c)
}
guard !segments.isEmpty else { fail("spec has no usable segment (each needs t0 < t1 and a crop)") }

let asset = AVURLAsset(url: inURL)
guard let srcTrack = asset.tracks(withMediaType: .video).first else { fail("no video track in \(inURL.path)") }
let srcSize = srcTrack.naturalSize
let ciContext = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])

/** Crop rect in source pixels (top-left origin), clamped to the frame. */
func pixelRect(_ r: CGRect) -> CGRect {
    CGRect(x: r.minX * scale, y: r.minY * scale, width: r.width * scale, height: r.height * scale)
        .intersection(CGRect(origin: .zero, size: srcSize))
}

let outDuration = segments.reduce(0) { $0 + ($1.t1 - $1.t0) }

/** One encode at `bitrate`; returns bytes written. */
func encode(bitrate: Int) -> Int {
    try? FileManager.default.removeItem(at: outURL)
    guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("cannot create writer") }
    writer.shouldOptimizeForNetworkUse = true
    let settings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: outW,
        AVVideoHeightKey: outH,
        AVVideoColorPropertiesKey: [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
            AVVideoMaxKeyFrameIntervalKey: 600,
            AVVideoMaxKeyFrameIntervalDurationKey: 20,
            AVVideoAllowFrameReorderingKey: true,
            AVVideoExpectedSourceFrameRateKey: Int(fps),
        ],
    ]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: outW,
        kCVPixelBufferHeightKey as String: outH,
    ])
    writer.add(input)
    guard writer.startWriting() else { fail("writer: \(writer.error.map { "\($0)" } ?? "?")") }
    writer.startSession(atSourceTime: .zero)
    var outIndex = 0
    for seg in segments {
        guard let reader = try? AVAssetReader(asset: asset) else { fail("cannot create reader") }
        let out = AVAssetReaderTrackOutput(track: srcTrack, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        out.alwaysCopiesSampleData = false
        reader.add(out)
        // A little before t0, so the frame on screen at t0 is among those read.
        reader.timeRange = CMTimeRange(start: CMTime(seconds: max(0, seg.t0 - 0.1), preferredTimescale: 600),
                                       end: CMTime(seconds: seg.t1 + 0.05, preferredTimescale: 600))
        guard reader.startReading() else { fail("reader: \(reader.error.map { "\($0)" } ?? "?")") }
        let px = pixelRect(seg.crop)
        let ciCrop = CGRect(x: px.minX, y: srcSize.height - px.maxY, width: px.width, height: px.height)
        let sx = Double(outW) / px.width, sy = Double(outH) / px.height
        let frames = Int((seg.t1 - seg.t0) * fps + 0.5)
        var k = 0
        var last: CVPixelBuffer?
        // Emit output frame k (local time k/fps) from the latest source frame at or before it.
        func emit(_ buf: CVPixelBuffer) {
            var image = CIImage(cvPixelBuffer: buf).cropped(to: ciCrop)
                .transformed(by: CGAffineTransform(translationX: -ciCrop.minX, y: -ciCrop.minY))
            let lz = CIFilter(name: "CILanczosScaleTransform")!
            lz.setValue(image, forKey: kCIInputImageKey)
            lz.setValue(sy, forKey: kCIInputScaleKey)
            lz.setValue(sx / sy, forKey: kCIInputAspectRatioKey)
            image = lz.outputImage!.cropped(to: CGRect(x: 0, y: 0, width: outW, height: outH))
            while !input.isReadyForMoreMediaData { usleep(1000) }
            var pb: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
            guard let pb else { fail("no pixel buffer") }
            ciContext.render(image, to: pb, bounds: CGRect(x: 0, y: 0, width: outW, height: outH), colorSpace: nil)
            adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(outIndex), timescale: CMTimeScale(fps)))
            outIndex += 1
        }
        while k < frames, let sample = out.copyNextSampleBuffer() {
            guard let buf = CMSampleBufferGetImageBuffer(sample) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            // Source frames past the next slot(s): the slots before them show `last`.
            while k < frames && pts > seg.t0 + Double(k) / fps + 0.004, let l = last { emit(l); k += 1 }
            last = buf
        }
        while k < frames, let l = last { emit(l); k += 1 }
        reader.cancelReading()
    }
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    if writer.status != .completed { fail("writer finished \(writer.status.rawValue): \(writer.error.map { "\($0)" } ?? "?")") }
    return (try? FileManager.default.attributesOfItem(atPath: outURL.path)[.size] as? Int) ?? 0
}

// ── Size loop ───────────────────────────────────────────────────────────────
let target = Double(maxBytes) * 0.9
var bitrate = Int(target * 8 / outDuration)
var tries: [[String: Any]] = []
var best: (bitrate: Int, bytes: Int)?
for _ in 0..<max(1, passes) {
    let bytes = encode(bitrate: bitrate)
    tries.append(["bitrate": bitrate, "bytes": bytes])
    log("bitrate \(bitrate) -> \(bytes) B")
    if bytes <= maxBytes, bytes > (best?.bytes ?? 0) { best = (bitrate, bytes) }
    if bytes <= maxBytes && Double(bytes) >= Double(maxBytes) * 0.8 { break }
    bitrate = Int(Double(bitrate) * target / Double(max(bytes, 1)) * (bytes > maxBytes ? 0.97 : 1.0))
}
guard let best else { fail("no pass came in under \(maxBytes) B: \(tries)", 3) }
if (tries.last?["bitrate"] as? Int) != best.bitrate { _ = encode(bitrate: best.bitrate) }

// ── Verify what was written (no ffprobe on the runners) ─────────────────────
func atoms(_ url: URL) -> [String] {
    guard let h = try? FileHandle(forReadingFrom: url) else { return [] }
    defer { try? h.close() }
    var names: [String] = []
    var off: UInt64 = 0
    let end = (try? h.seekToEnd()) ?? 0
    while off + 8 <= end {
        try? h.seek(toOffset: off)
        guard let d = try? h.read(upToCount: 16), d.count >= 8 else { break }
        var sz = UInt64(d[0]) << 24 | UInt64(d[1]) << 16 | UInt64(d[2]) << 8 | UInt64(d[3])
        let name = String(bytes: d[4..<8], encoding: .ascii) ?? "?"
        if sz == 1, d.count >= 16 { sz = d[8..<16].reduce(0) { $0 << 8 | UInt64($1) } }
        if sz == 0 { sz = end - off }
        names.append(name)
        if sz < 8 { break }
        off += sz
    }
    return names
}
let outAsset = AVURLAsset(url: outURL)
let vt = outAsset.tracks(withMediaType: .video)
var frameCount = 0
if let t = vt.first, let r = try? AVAssetReader(asset: outAsset) {
    let o = AVAssetReaderTrackOutput(track: t, outputSettings: nil)
    r.add(o); r.startReading()
    while o.copyNextSampleBuffer() != nil { frameCount += 1 }
}
let codec: String = {
    guard let f = vt.first?.formatDescriptions.first else { return "?" }
    let c = CMFormatDescriptionGetMediaSubType(f as! CMFormatDescription)
    return String(bytes: [UInt8(c >> 24 & 255), UInt8(c >> 16 & 255), UInt8(c >> 8 & 255), UInt8(c & 255)], encoding: .ascii) ?? "?"
}()
let top = atoms(outURL)
let moovFirst = (top.firstIndex(of: "moov") ?? Int.max) < (top.firstIndex(of: "mdat") ?? Int.max)

// ── Poster and inspection frames, from the file just written ────────────────
func writeJPEG(_ img: CGImage, _ path: String, quality: Double) -> Int {
    let url = URL(fileURLWithPath: path)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return 0 }
    CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    CGImageDestinationFinalize(dest)
    return (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? Int) ?? 0
}
let gen = AVAssetImageGenerator(asset: outAsset)
gen.requestedTimeToleranceBefore = .zero
gen.requestedTimeToleranceAfter = .zero
gen.appliesPreferredTrackTransform = true
func frame(at t: Double) -> CGImage? { try? gen.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil) }
var posterReport: [String: Any] = [:]
if let posterPath, let t = num(spec["poster"]) ?? Optional(outDuration / 2), let img = frame(at: min(t, outDuration - 0.05)) {
    var q = 0.85
    var bytes = writeJPEG(img, posterPath, quality: q)
    while bytes > 80_000 && q > 0.3 { q -= 0.08; bytes = writeJPEG(img, posterPath, quality: q) }
    posterReport = ["t": t, "quality": q, "bytes": bytes]
}
var frameFiles: [String] = []
if let framesDir {
    try? FileManager.default.createDirectory(atPath: framesDir, withIntermediateDirectories: true)
    for v in (spec["frames"] as? [Any]) ?? [] {
        guard let t = num(v), let img = frame(at: min(t, outDuration - 0.05)) else { continue }
        let p = "\(framesDir)/\(outURL.deletingPathExtension().lastPathComponent)-\(String(format: "%05.2f", t)).jpg"
        _ = writeJPEG(img, p, quality: 0.92)
        frameFiles.append(p)
    }
}

let report: [String: Any] = [
    "out": outURL.lastPathComponent,
    "bytes": best.bytes, "maxBytes": maxBytes, "bitrate": best.bitrate, "tries": tries,
    "durationSeconds": outAsset.duration.seconds, "plannedSeconds": outDuration,
    "codec": codec, "size": [vt.first?.naturalSize.width ?? 0, vt.first?.naturalSize.height ?? 0],
    "fps": vt.first?.nominalFrameRate ?? 0, "frames": frameCount,
    "audioTracks": outAsset.tracks(withMediaType: .audio).count,
    "topLevelAtoms": top, "moovBeforeMdat": moovFirst,
    "segments": segments.map { ["t0": $0.t0, "t1": $0.t1, "crop": [$0.crop.minX, $0.crop.minY, $0.crop.width, $0.crop.height]] },
    "poster": posterReport, "frameFiles": frameFiles.map { ($0 as NSString).lastPathComponent },
]
let json = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(data: json, encoding: .utf8)!)
