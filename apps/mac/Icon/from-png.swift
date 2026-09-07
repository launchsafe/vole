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
let CARD: CGFloat = 1000        // near full-bleed: matches modern app icons (Raycast/Arc sizing)
let INSET: CGFloat = (S - CARD) / 2
let R: CGFloat = 224            // corner radius — Apple squircle proportion (~22.4% of body)

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
    // The tile background: near-black #080808 behind the letterforms, so the
    // mark reads on both light and dark Dock backgrounds.
    ctx.setFillColor(CGColor(red: 8 / 255, green: 8 / 255, blue: 8 / 255, alpha: 1))
    ctx.fill(cardRect)
    // Aspect-fill the source into the card (centre-cropped, never stretched).
    let iw = CGFloat(image.width), ih = CGFloat(image.height)
    let fill = max((CARD * scale) / iw, (CARD * scale) / ih)
    let dw = iw * fill, dh = ih * fill
    ctx.draw(image, in: CGRect(x: cardRect.midX - dw / 2, y: cardRect.midY - dh / 2, width: dw, height: dh))
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
