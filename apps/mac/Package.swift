// swift-tools-version: 6.0
import PackageDescription

// Native macOS front-end for Vole. Reads the SQLite database the existing
// `pnpm collect` process writes to ~/.vole/vole.db — no sidecar yet,
// no new dependencies (SQLite3 ships with the OS).
let package = Package(
    name: "Vole",
    // macOS 26. The UI adopts Liquid Glass directly (`.glassEffect`,
    // `GlassEffectContainer`, `.buttonStyle(.glass)`), which are macOS-26 API.
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "Vole",
            path: "Sources/Vole",
            resources: [.process("Resources")]   // real tool logos
        )
    ],
    swiftLanguageModes: [.v5]
)
