import Foundation

/// Spawns and owns the embedded collector — Contents/MacOS/vole-collector, a
/// self-contained binary (see packages/core/scripts/build-sea.mjs) that needs no Node
/// install to run. This is what lets the app work with nothing else started by hand.
///
/// Not present next to an unbundled `swift run` binary, so `start()` is a silent no-op
/// there — a developer keeps running `pnpm collect` themselves, exactly as before.
///
/// ponytail: a crash (not a clean quit) leaves this orphaned rather than relaunching it
/// — collect.ts is idempotent and two instances polling the same WAL-mode database is
/// wasteful, not unsafe, so this doesn't check for a stale one before spawning. Add a
/// pidfile check on start() if orphan buildup across crashes ever actually matters.
final class Collector {
    private var process: Process?

    /// True for a real .app built by bundle.sh, false for an unbundled `swift run`
    /// binary. Also what the empty-state UI checks so a bundled app never tells a
    /// user to run `pnpm collect` themselves — they have no Node, no pnpm, and
    /// nothing to run; the collector is already running for them.
    static let isEmbedded: Bool = {
        guard let exe = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .appendingPathComponent("vole-collector")
        else { return false }
        return FileManager.default.isExecutableFile(atPath: exe.path)
    }()

    func start() {
        guard Self.isEmbedded, let exe = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .appendingPathComponent("vole-collector")
        else { return }

        let p = Process()
        p.executableURL = exe
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do {
            try p.run()
            process = p
        } catch {
            FileHandle.standardError.write(Data("vole-collector failed to launch: \(error)\n".utf8))
        }
    }

    /// SIGTERM — collect.ts has no handler for it, and each poll's writes are already
    /// one transaction, so Node's default immediate exit mid-poll is safe to interrupt.
    func stop() {
        guard let p = process, p.isRunning else { return }
        p.terminate()
        process = nil
    }
}
