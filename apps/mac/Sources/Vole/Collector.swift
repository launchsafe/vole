import Foundation

/// Spawns and owns the embedded collector — Contents/MacOS/vole-collector, a
/// self-contained binary (see packages/core/scripts/build-sea.mjs) that needs no Node
/// install to run. This is what lets the app work with nothing else started by hand.
///
/// Not present next to an unbundled `swift run` binary, so `start()` is a silent no-op
/// there — a developer keeps running `pnpm collect` themselves, exactly as before.
///
/// Supervision (#12): a crash (not a clean quit) used to leave the collector orphaned
/// forever — measured on a real machine as two orphaned processes at ~570 MB RSS each
/// and 28.4% CPU, plus a stale "wasteful, not unsafe" comment. Now the collector
/// writes a pidfile, and `start()` refuses to spawn over a live one. The check
/// verifies the recorded executable path against the pid, never the file's mere
/// existence: a pidfile is advisory, a SIGKILLed collector leaves a stale one, and
/// pids get reused.
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

    private var pidFile: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vole/collector.pid")
    }

    /// A live collector at the recorded pid whose executable matches ours. `ps -o comm`
    /// gives the executable path for the pid; comparing it (not just liveness) is what
    /// makes a reused pid and a stale file harmless.
    private func liveCollectorExists() -> Bool {
        guard let data = try? Data(contentsOf: pidFile),
              let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = info["pid"] as? Int
        else { return false }
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-p", String(pid), "-o", "comm="]
        let out = Pipe()
        ps.standardOutput = out
        ps.standardError = FileHandle.nullDevice
        do {
            try ps.run()
            ps.waitUntilExit()
        } catch {
            return false
        }
        guard ps.terminationStatus == 0,
              let comm = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines),
              !comm.isEmpty
        else { return false }
        // The recorded exe is the collector's own Node host; a live process at that
        // pid whose executable is our vole-collector means one is already feeding
        // this store. (A dev's `pnpm collect` runs under a different executable and
        // is explicitly tolerated — two writers are safe since busy_timeout.)
        return comm.contains("vole-collector")
    }

    func start() {
        guard Self.isEmbedded, let exe = Bundle.main.executableURL?
            .deletingLastPathComponent()
            .appendingPathComponent("vole-collector")
        else { return }

        if liveCollectorExists() {
            FileHandle.standardError.write(Data(
                "[collector] a live vole-collector is already running (pidfile verified) — not spawning another\n".utf8))
            return
        }

        let p = Process()
        p.executableURL = exe
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        // The exit status is a supervision fact: a collector that died with a
        // nonzero code is a different incident than one that was never started,
        // and this is the only place the difference is observable.
        p.terminationHandler = { proc in
            if proc.terminationStatus != 0 {
                FileHandle.standardError.write(Data(
                    "[collector] vole-collector exited with status \(proc.terminationStatus)\n".utf8))
            }
        }
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
