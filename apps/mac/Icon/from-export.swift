// Turn an Icon Composer export into a macOS iconset.
//
//   swift Icon/from-export.swift Icon/exports/vole-iOS-Default-1024x1024@1x.png build/Vole.iconset
//
// Icon Composer's iOS exports are FULL-BLEED: a 1024x1024 rounded square whose
// shape and transparent corners are already drawn, because iOS masks icons itself.
// macOS does not — it draws the PNG as given — and its grid is an 824 body centred
// in a 1024 canvas with a 100px gutter. Dropping a full-bleed export in unchanged
// makes the tile ~20% larger than every system icon beside it in the Dock, which is
// exactly the defect fixed in 1.0.2; this script is what keeps that from coming back.
//
// The rounded corners are NOT re-drawn. The export's radius is ~22.4% of its body,
// and scaling 1024 -> 824 carries it to ~185, which is the macOS template radius —
// so a proportional scale lands on the right shape by itself. Masking again here
// would round already-rounded corners and eat the edge.
import Foundation
import CoreGraphics
import ImageIO
import AppKit
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write(Data("usage: from-export.swift <source-1024.png> <out.iconset>\n".utf8))
    exit(2)
}
let srcPath = args[1], outDir = args[2]

let CANVAS: CGFloat = 1024   // the icon canvas macOS composites into
let BODY: CGFloat = 824      // Apple's macOS grid body
let INSET: CGFloat = (CANVAS - BODY) / 2   // 100pt gutter on every side

guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: srcPath) as CFURL, nil),
      let art = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    FileHandle.standardError.write(Data("cannot read \(srcPath)\n".utf8)); exit(1)
}
if art.width != art.height {
    FileHandle.standardError.write(Data("source must be square, got \(art.width)x\(art.height)\n".utf8)); exit(1)
}

func render(_ size: Int) -> CGImage? {
    let px = CGFloat(size), scale = px / CANVAS
    guard let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                              bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(art, in: CGRect(x: INSET * scale, y: INSET * scale,
                             width: BODY * scale, height: BODY * scale))
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

let entries: [(Int, String)] = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
var ok = 0
for (s, name) in entries where render(s).map({ write($0, name) }) == true { ok += 1 }
print("iconset: \(ok)/\(entries.count) sizes → \(outDir)  (\(Int(BODY))/\(Int(CANVAS)) macOS grid)")
exit(ok == entries.count ? 0 : 1)
