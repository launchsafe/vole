// Renders the menu-bar glyph from the source artwork (apps/mac/Icon/logo.png):
// the FULL wordmark at its natural aspect ratio, vertically centred, as a black
// template PNG whose ALPHA carries the mark. No region cropping — every crop
// was a blind guess at letter boundaries that do not exist in a connected
// wordmark, and a square-forced wide mark squashes into distortion.
//
//   swift Icon/menu-glyph.swift Icon/logo.png ../Sources/Vole/Resources/MenuBarGlyph.png
//
// The output canvas is WIDE (72px tall, aspect-proportional width) and the app
// sizes it proportionally (19pt tall, width by aspect) — the shape you see is
// the shape in the logo, at menu-bar height.
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write(Data("usage: swift menu-glyph.swift <input.png> <out.png>\n".utf8))
    exit(2)
}

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("could not read \(args[1])\n".utf8))
    exit(1)
}

// 1. Tight bounding box of the artwork (census rows top-down, y=0 is the top).
let w = image.width, h = image.height
var minX = w, minY = h, maxX = 0, maxY = 0
if let cfdata = image.dataProvider?.data {
    let bytes = CFDataGetBytePtr(cfdata)!
    let bpr = image.bytesPerRow, bpp = image.bitsPerPixel / 8
    for y in stride(from: 0, to: h, by: 8) {
        for x in stride(from: 0, to: w, by: 8) where bytes[y * bpr + x * bpp + 3] > 24 {
            minX = min(minX, x); maxX = max(maxX, x)
            minY = min(minY, y); maxY = max(maxY, y)
        }
    }
}
guard maxX > minX, maxY > minY else {
    FileHandle.standardError.write(Data("no opaque pixels — not a transparency-based artwork\n".utf8))
    exit(1)
}

// 2. Render the FULL mark into a canvas 72px tall, wide as the aspect needs,
//    with a 2% margin. Orientation is preserved by construction: the crop rect
//    converts the top-down census box to CG's bottom-left origin exactly once.
let HEIGHT = 72
let pad = 8
let markW = maxX - minX + pad * 2, markH = maxY - minY + pad * 2
let scale = Double(HEIGHT) / Double(markH)
let outW = max(16, Int((Double(markW) * scale).rounded()))
let fit = min(Double(outW) / Double(markW), Double(HEIGHT) / Double(markH))
let dw = Double(markW) * fit, dh = Double(markH) * fit
let dx = (Double(outW) - dw) / 2, dy = (Double(HEIGHT) - dh) / 2

guard let ctx = CGContext(
    data: nil, width: outW, height: HEIGHT, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write(Data("could not create context\n".utf8))
    exit(1)
}
ctx.clear(CGRect(x: 0, y: 0, width: outW, height: HEIGHT))
let cropRect = CGRect(x: minX - pad, y: h - maxY - pad, width: markW, height: markH)
guard let cropped = image.cropping(to: cropRect) else {
    FileHandle.standardError.write(Data("crop failed\n".utf8))
    exit(1)
}
ctx.interpolationQuality = .high
ctx.draw(cropped, in: CGRect(x: dx, y: dy, width: dw, height: dh))
// Blacken, keep alpha: .sourceAtop paints only where the artwork already is.
ctx.setBlendMode(.sourceAtop)
ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: outW, height: HEIGHT))

// 3. Write, then VERIFY orientation: the written PNG's top-third ink share must
//    match the source crop's top-third ink share (within tolerance) — a vertical
//    flip inverts that ratio, so a flipped glyph cannot pass this gate.
guard let out = ctx.makeImage() else { exit(1) }
let data = NSMutableData()
guard let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { exit(1) }
CGImageDestinationAddImage(dest, out, nil)
guard CGImageDestinationFinalize(dest) else { exit(1) }
try! (data as Data).write(to: URL(fileURLWithPath: args[2]))

func topInkShare(_ img: CGImage) -> Double {
    guard let d = img.dataProvider?.data else { return 0 }
    let b = CFDataGetBytePtr(d)!
    let bpr = img.bytesPerRow, bpp = img.bitsPerPixel / 8
    var top = 0, bottom = 0
    for y in 0..<img.height {
        for x in stride(from: 0, to: img.width, by: 2) where b[y * bpr + x * bpp + 3] > 100 {
            if y < img.height / 2 { top += 1 } else { bottom += 1 }
        }
    }
    return Double(top) / Double(max(top + bottom, 1))
}
let sourceShare = topInkShare(cropped)
let writtenShare = topInkShare(out)
if abs(sourceShare - writtenShare) > 0.12 {
    FileHandle.standardError.write(Data(
        "ORIENTATION CHECK FAILED: source top-share \(sourceShare) vs written \(writtenShare) — the glyph would be flipped\n".utf8))
    exit(1)
}
print("menu glyph → \(args[2]) (\(outW)x\(HEIGHT), black template, full wordmark, aspect \(String(format: "%.2f", Double(outW) / Double(HEIGHT))):1, orientation verified)")
