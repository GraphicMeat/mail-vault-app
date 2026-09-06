// Run on macOS: swift scripts/generate-dmg-background.swift
// Finder supplies the actual app/folder icons and their labels. Keep their
// centers in sync with tauri.conf.json and build-developer-id.sh (180/480, 200).
import AppKit

let width = 660
let height = 600
let scale = 2
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * scale,
    pixelsHigh: height * scale, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
// Store 144-DPI metadata so Finder displays the 2× artwork at its logical size.
bitmap.size = NSSize(width: width, height: height)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext
// NSGraphicsContext derives its 2× transform from the bitmap's logical size.
context.translateBy(x: 0, y: CGFloat(height))
context.scaleBy(x: 1, y: -1)

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
        green: CGFloat((hex >> 8) & 255) / 255,
        blue: CGFloat(hex & 255) / 255, alpha: 1)
}
func text(_ value: String, top: CGFloat, size: CGFloat,
          weight: NSFont.Weight, ink: UInt32, left: CGFloat? = nil,
          redEmphasis: String? = nil) {
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: size, weight: weight),
        .foregroundColor: color(ink)
    ]
    let string = NSMutableAttributedString(string: value, attributes: attributes)
    if let emphasis = redEmphasis {
        let range = (value as NSString).range(of: emphasis)
        if range.location != NSNotFound {
            string.addAttribute(.foregroundColor, value: color(0xFF455C), range: range)
        }
    }
    let bounds = string.size()
    context.saveGState()
    context.translateBy(x: left ?? (CGFloat(width) - bounds.width) / 2, y: top + bounds.height)
    context.scaleBy(x: 1, y: -1)
    string.draw(at: .zero)
    context.restoreGState()
}

// A light, opaque surface keeps Finder's icon labels legible in both themes.
color(0xFAFAF8).setFill()
context.fill(CGRect(x: 0, y: 0, width: width, height: height))

// Graphic Meat's angular red seams frame the light installation surface.
func seam(_ points: [CGPoint], closeAt y: CGFloat) {
    let shape = CGMutablePath()
    shape.addLines(between: points)
    shape.addLine(to: CGPoint(x: CGFloat(width), y: y))
    shape.addLine(to: CGPoint(x: 0, y: y))
    shape.closeSubpath()
    context.setFillColor(color(0x101012).cgColor)
    context.addPath(shape)
    context.fillPath()
    context.setStrokeColor(color(0xDE1632).cgColor)
    context.setLineWidth(1)
    context.setLineJoin(.miter)
    context.addLines(between: points)
    context.strokePath()
}
seam([CGPoint(x: 0, y: 16), CGPoint(x: 100, y: 16),
      CGPoint(x: 110, y: 26), CGPoint(x: 224, y: 26),
      CGPoint(x: 234, y: 16), CGPoint(x: 440, y: 16),
      CGPoint(x: 450, y: 6), CGPoint(x: 550, y: 6),
      CGPoint(x: 560, y: 16), CGPoint(x: 660, y: 16)], closeAt: 0)
text("Install MailVault", top: 55, size: 28, weight: .semibold, ink: 0x20212C)
text("Drag MailVault to the Applications folder.", top: 95,
     size: 14, weight: .regular, ink: 0x575B69)

// The arrow bridges the real Finder icons; no baked-in or duplicate icons.
context.setStrokeColor(color(0x4F46DF).cgColor)
context.setLineWidth(2.5)
context.setLineCap(.round)
context.setLineJoin(.round)
context.move(to: CGPoint(x: 300, y: 200))
context.addLine(to: CGPoint(x: 360, y: 200))
context.move(to: CGPoint(x: 350, y: 190))
context.addLine(to: CGPoint(x: 360, y: 200))
context.addLine(to: CGPoint(x: 350, y: 210))
context.strokePath()

// Leave room for Finder's optional path/status bars as well as its title bar.
text("Then open MailVault from Applications.", top: 279,
     size: 13, weight: .regular, ink: 0x575B69)
seam([CGPoint(x: 0, y: 330), CGPoint(x: 76, y: 330),
      CGPoint(x: 86, y: 320), CGPoint(x: 174, y: 320),
      CGPoint(x: 184, y: 330), CGPoint(x: 288, y: 330),
      CGPoint(x: 306, y: 312), CGPoint(x: 410, y: 312),
      CGPoint(x: 420, y: 322), CGPoint(x: 570, y: 322),
      CGPoint(x: 578, y: 330), CGPoint(x: 660, y: 330)], closeAt: CGFloat(height))

// A quiet circuit trace echoes the supplied website transition.
context.setStrokeColor(color(0xDE1632).cgColor)
context.setLineWidth(1)
context.addLines(between: [CGPoint(x: 524, y: 302), CGPoint(x: 524, y: 322),
                          CGPoint(x: 510, y: 336), CGPoint(x: 510, y: 350)])
context.strokePath()
context.setFillColor(color(0xF26935).cgColor)
context.fillEllipse(in: CGRect(x: 522, y: 320, width: 4, height: 4))

text("Cooked over an open GPU by", top: 355,
     size: 13, weight: .medium, ink: 0xBCBCC6, redEmphasis: "open GPU")
let logo = NSImage(contentsOf: root.appendingPathComponent("website/graphicmeat-logo.png"))!
context.saveGState()
context.translateBy(x: 220, y: 577)
context.scaleBy(x: 1, y: -1)
logo.draw(in: NSRect(x: 0, y: 0, width: 220, height: 220),
          from: .zero, operation: .sourceOver, fraction: 1)
context.restoreGState()
NSGraphicsContext.restoreGraphicsState()

let output = root.appendingPathComponent("src-tauri/icons/dmg-background.png")
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
print("Generated \(output.path) (\(width * scale) × \(height * scale) pixels, 144 DPI)")
