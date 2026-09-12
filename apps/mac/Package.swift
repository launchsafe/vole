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
        ),
        // The app was 3,200 lines with no tests at all, and CI only compiled it —
        // so every app-side bug so far (a 55-second freeze, a corrupt store reported
        // healthy, a schema constant that blanked every panel) was found by running
        // it by hand. These are regression tests for exactly those.
        .testTarget(
            name: "VoleTests",
            dependencies: ["Vole"],
            path: "Tests/VoleTests"
        )
    ],
    swiftLanguageModes: [.v5]
)
