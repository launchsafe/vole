// Renders the app icon from a source PNG (apps/mac/Icon/logo.png) into a
// macOS .iconset, using the same geometry the previous generated icon used:
// the artwork fitted into an 824×824 rounded card (rx 185) centred on a 1024
// canvas with a transparent shadow gutter — so the dock shape stays consistent.
//
//   swift Icon/from-png.swift Icon/logo.png Icon/Vole.iconset
//   iconutil -c icns Icon/Vole.iconset -o Icon/Vole.icns
//
// Pure CoreGraphics/ImageIO: no sharp, no network, no dependencies — this is
// the blessed way to regenerate Vole.icns from arbitrary artwork.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write(Data("usage: swift from-png.swift <input.png> <out.iconset-dir>\n".utf8))
    exit(2)
}
let inputURL = URL(fileURLWithPath: args[1])
let outDir = args[2]

guard let src = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("could not read \(args[1])\n".utf8))
    exit(1)
}

let S: CGFloat = 1024          // canvas
let CARD: CGFloat = 824         // Apple's macOS grid: 824 body in a 1024 canvas, 100px gutter
let INSET: CGFloat = (S - CARD) / 2
let R: CGFloat = 185            // corner radius at the 824 body — matches the macOS template
// The artwork ships with ~26% transparent padding baked in, so we trim to the
// mark and size it ourselves: MARK_W of the card wide, never taller than MARK_H.
//
// Sizing history, because the obvious number is the wrong one here. These were
// 0.82/0.72, then cut to 0.66/0.58 on the reasoning that "Chrome and VS Code sit
// around 60-65%". That reasoning does not transfer: those are roughly SQUARE
// glyphs, where 65% of the width is also 65% of the height. The Vole mouse is
// 1.65:1 — wide and flat — so 66% of width put it at just 40% of the tile's
// HEIGHT, floating in black. Measured against macOS 26 system icons, Music's
// glyph fills 79% of its tile height and Reminders' 95%; Vole's filled 40%, which
// is exactly why it read as a small mouse in a big square.
//
// Percent-of-width is the wrong knob for a mark that is not square: fill the
// width generously and let the aspect ratio decide the height.
let MARK_W: CGFloat = 0.77
let MARK_H: CGFloat = 0.67

/// Tightest rect (image coordinates, origin top-left) containing every non-transparent pixel.
func alphaBounds(_ img: CGImage) -> CGRect {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    guard let c = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                            space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return CGRect(x: 0, y: 0, width: w, height: h) }
    c.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    var x0 = w, y0 = h, x1 = -1, y1 = -1
    for y in 0..<h {
        for x in 0..<w where px[(y * w + x) * 4 + 3] > 8 {
            if x < x0 { x0 = x }; if x > x1 { x1 = x }
            if y < y0 { y0 = y }; if y > y1 { y1 = y }
        }
    }
    guard x1 >= x0, y1 >= y0 else { return CGRect(x: 0, y: 0, width: w, height: h) }
    // the scan is bottom-left origin, cropping(to:) wants top-left
    return CGRect(x: x0, y: h - 1 - y1, width: x1 - x0 + 1, height: y1 - y0 + 1)
}

let mark = image.cropping(to: alphaBounds(image)) ?? image

func render(_ size: Int) -> CGImage? {
    let px = CGFloat(size)
    let scale = px / S
    guard let ctx = CGContext(
        data: nil, width: size, height: size,
        bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: px, height: px))
    let cardRect = CGRect(x: INSET * scale, y: INSET * scale,
                          width: CARD * scale, height: CARD * scale)
    let path = CGPath(roundedRect: cardRect, cornerWidth: R * scale, cornerHeight: R * scale, transform: nil)
    ctx.addPath(path)
    ctx.clip()
    // The tile background: near-black #080808. Note that macOS 26 paints a ~17px light
    // glass rim on every app icon, which is invisible on a light tile but shows on a
    // dark one as a grey ramp into the edge, so this reads marginally smaller in the
    // Dock than a white-tiled neighbour. That is a known, accepted trade for the look.
    ctx.setFillColor(CGColor(red: 8 / 255, green: 8 / 255, blue: 8 / 255, alpha: 1))
    ctx.fill(cardRect)
    // Fit the trimmed mark into the card, centred, never stretched or cropped.
    let mw = CGFloat(mark.width), mh = CGFloat(mark.height)
    let fit = min(CARD * MARK_W / mw, CARD * MARK_H / mh) * scale
    let dw = mw * fit, dh = mh * fit
    // The mouse is drawn as a mask filled pure white rather than blitted: logo.png's
    // own off-white (#F5F4EF) goes grey under the system's glass pass, #FFF survives it.
    let markRect = CGRect(x: cardRect.midX - dw / 2, y: cardRect.midY - dh / 2, width: dw, height: dh)
    ctx.saveGState()
    ctx.clip(to: markRect, mask: mark)
    ctx.setFillColor(CGColor(gray: 1, alpha: 1))
    ctx.fill(markRect)
    ctx.restoreGState()
    return ctx.makeImage()
}

func write(_ img: CGImage, _ name: String) -> Bool {
    let data = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return false }
    CGImageDestinationAddImage(dest, img, nil)
    guard CGImageDestinationFinalize(dest) else { return false }
    try? (data as Data).write(to: URL(fileURLWithPath: outDir + "/" + name))
    return true
}

// The standard macOS iconset (same set the old build.mjs emitted).
let entries: [(Int, String)] = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
var ok = 0
for (s, name) in entries {
    if let img = render(s), write(img, name) { ok += 1 } else {
        FileHandle.standardError.write(Data("failed to render \(name)\n".utf8))
    }
}
print("iconset: \(ok)/\(entries.count) sizes → \(outDir)")
exit(ok == entries.count ? 0 : 1)
