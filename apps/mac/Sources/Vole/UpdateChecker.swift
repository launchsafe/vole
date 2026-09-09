import Foundation
import Observation
import AppKit

/// The auto-updater: checks GitHub's latest release, and — when the release
/// carries a checksummed zip — installs it in place. Click, verify, swap,
/// relaunch: no browser, no DMG drag.
///
/// Trust model (the same discipline as the pinned SEA Node): an update is
/// installed ONLY when its sha256 is published beside it (`Vole-x.y.z.zip.sha256`).
/// No checksum → no silent install; the button falls back to opening the release
/// page, because shipping unverifiable code to a running app is the one
/// shortcut this codebase refuses.
///
/// The swap itself is the standard macOS dance: the running bundle is MOVED
/// away (a running app's files can be moved — the inode stays alive), the
/// verified new bundle takes its exact path, the new one is launched, and the
/// old process terminates.
@Observable
final class UpdateChecker {
    private(set) var latestVersion: String?
    private(set) var releaseURL: URL?
    private(set) var status: Status = .idle
    private(set) var progress: Double = 0

    enum Status: Equatable {
        /// Never checked, or this build cannot self-update (`swift run`).
        case idle
        case checking
        /// Checked, reached GitHub, already current. Distinct from `idle` on
        /// purpose: a check that never left the machine must not be able to
        /// render as "you're up to date".
        case upToDate
        case available(version: String)
        case downloading(version: String)
        case verifying
        case installing
        case failed(String)
    }

    var updateAvailable: Bool {
        guard case .available = status else { return false }
        return true
    }

    /// Only a real .app bundle can self-update — `swift run` builds have no
    /// bundle to swap, and trying would be a spectacular way to lose work.
    private static var isBundledApp: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
            && Bundle.main.infoDictionary?["CFBundleShortVersionString"] != nil
    }

    /// The single choke point for this app's network calls. VOLE_NO_EGRESS is
    /// read at CALL time (a test and a running app can both toggle it) and the
    /// switch always blocks — fail-closed on the opt-out. The update check is
    /// the one disclosed always-on call the app makes. Internal (not private)
    /// so the CLI harness exercises the real gate.
    static func egress(caller: String, destination: String, purpose: String) -> Bool {
        ProcessInfo.processInfo.environment["VOLE_NO_EGRESS"] != "1"
    }

    /// Testability: point the checker at a local file:// "API" and/or
    /// auto-install without a click. Not a settings surface — a test seam.
    init() {
        check()
        if ProcessInfo.processInfo.environment["VOLE_AUTO_INSTALL"] == "1" {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                self.installOrUpdate()
            }
        }
    }

    /// Where the VERSION comes from: github.com, not api.github.com.
    /// `/releases/latest` answers a 302 to `/releases/tag/vX.Y.Z`.
    private static var latestPageURL: String {
        ProcessInfo.processInfo.environment["VOLE_UPDATE_LATEST"]
            ?? "https://github.com/launchsafe/vole/releases/latest"
    }
    /// Where the ASSETS come from. Only consulted when an update actually exists.
    private static var assetAPIURL: String {
        ProcessInfo.processInfo.environment["VOLE_UPDATE_API"]
            ?? "https://api.github.com/repos/launchsafe/vole/releases?per_page=1"
    }

    /// GitHub answers 403 for several unrelated conditions — a spent rate limit,
    /// a missing User-Agent, secondary abuse limits, a blocked address. This used
    /// to label EVERY 403 "rate limit reached — try again later", which sends the
    /// user off to wait an hour for something waiting will not fix. Only say it
    /// when the response itself says the budget is gone.
    private static func failureReason(_ http: HTTPURLResponse) -> String {
        let remaining = http.value(forHTTPHeaderField: "x-ratelimit-remaining")
        if http.statusCode == 429 || (http.statusCode == 403 && remaining == "0") {
            return "GitHub rate limit reached — try again later"
        }
        return "GitHub returned HTTP \(http.statusCode)"
    }

    func check() {
        guard Self.isBundledApp else { return }
        status = .checking
        // The version check deliberately does NOT touch api.github.com. That API
        // meters unauthenticated callers at 60 requests per hour PER IP — a budget
        // shared by everyone behind the same address, so one office, VPN or campus
        // NAT exhausts it for every Vole on it, and a per-launch API check spends it
        // for nothing in the overwhelmingly common case of already being current.
        // github.com does not meter against that budget (measured: 10 redirects cost
        // 0 of 60, while 3 API calls cost exactly 3), so the routine path is free and
        // the API is consulted only once a newer version genuinely exists.
        //
        // Using /releases/latest also means prereleases are not offered for silent
        // install — GitHub's "latest" skips them — which is the right default for an
        // app that swaps its own bundle.
        guard let url = URL(string: Self.latestPageURL) else { return }
        // The choke point: the attempt is ledgered whether or not it is allowed,
        // and VOLE_NO_EGRESS skips the network call entirely.
        guard Self.egress(caller: "UpdateChecker.swift",
                          destination: url.host.map { "\($0)\(url.path)" } ?? url.absoluteString,
                          purpose: "version check on launch") else {
            status = .idle
            return
        }
        // Every failure below reports itself. Collapsing them into `.idle` — as
        // this did — renders a check that never reached GitHub identically to
        // "you are up to date", which is how a 404 from a private repo went
        // unnoticed through several releases.
        // async/await rather than a completion handler: the handler is @Sendable and
        // this class is not, so every such closure costs a concurrency warning for a
        // capture that is immediately hopped back to the main actor anyway.
        Task { @MainActor in
            do {
                // HEAD: only the redirect target is wanted, never the page body.
                var req = URLRequest(url: url)
                req.httpMethod = "HEAD"
                let (_, response) = try await URLSession.shared.data(for: req)
                guard let http = response as? HTTPURLResponse else {
                    status = .failed("could not read GitHub's response")
                    return
                }
                guard http.statusCode == 200 else {
                    status = .failed(Self.failureReason(http))
                    return
                }
                // URLSession followed the redirect, so the landing URL names the tag.
                // A repo with nothing published lands on /releases instead, with no
                // "tag" component — a successful check whose answer is "nothing to
                // move to", not a failure.
                let page = http.url ?? url
                let parts = page.pathComponents
                guard let i = parts.firstIndex(of: "tag"), i + 1 < parts.count else {
                    status = .upToDate
                    return
                }
                let tag = parts[i + 1]
                consider(version: tag.hasPrefix("v") ? String(tag.dropFirst()) : tag, page: page)
            } catch {
                status = .failed("could not reach GitHub — \(error.localizedDescription)")
            }
        }
    }

    /// Decide on the version alone. Being current is the common case and ends here,
    /// having spent no API quota at all.
    @MainActor
    private func consider(version: String, page: URL) {
        latestVersion = version
        releaseURL = page
        guard let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              Self.isNewer(version, than: current) else {
            status = .upToDate
            return
        }
        fetchAssets(version: version, page: page)
    }

    /// Only reached when an update exists: resolve the download URLs. Failing here
    /// still surfaces the update — the button falls back to opening the release page.
    @MainActor
    private func fetchAssets(version: String, page: URL) {
        guard let url = URL(string: Self.assetAPIURL) else {
            status = .available(version: version)
            return
        }
        guard Self.egress(caller: "UpdateChecker.swift",
                          destination: url.host.map { "\($0)\(url.path)" } ?? url.absoluteString,
                          purpose: "resolve update download URLs") else {
            status = .available(version: version)
            return
        }
        Task { @MainActor in
            var zip: URL?
            var sha: URL?
            if let data = try? await URLSession.shared.data(from: url).0,
               let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
               let json = list.first,
               let assets = json["assets"] as? [[String: Any]] {
                let assetURL = { (ext: String) -> URL? in
                    assets.first { ($0["name"] as? String ?? "").hasSuffix(ext) }
                        .flatMap { $0["browser_download_url"] as? String }
                        .flatMap(URL.init(string:))
                }
                zip = assetURL(".zip")
                sha = assetURL(".zip.sha256")
            }
            zipAsset = zip
            shaAsset = sha
            status = .available(version: version)
        }
    }

    private var zipAsset: URL?
    private var shaAsset: URL?

    /// The one-click path: verify → download → swap → relaunch. Falls back to
    /// the release page when the release predates checksummed assets.
    @MainActor
    func installOrUpdate() {
        switch status {
        case .available(let v):
            guard let zip = zipAsset, let sha = shaAsset else {
                // No checksum published: never silent-install unverifiable code.
                if let url = releaseURL { NSWorkspace.shared.open(url) }
                return
            }
            install(version: v, zip: zip, sha: sha)
        default:
            check()
        }
    }

    @MainActor
    private func install(version: String, zip: URL, sha: URL) {
        status = .downloading(version: version)
        progress = 0
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vole-update-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let shaFile = dir.appendingPathComponent("zip.sha256")
        let zipFile = dir.appendingPathComponent("update.zip")

        // The checksum first — a small file, no progress needed.
        URLSession.shared.downloadTask(with: sha) { [weak self] local, _, error in
            guard let local, error == nil,
                  (try? Data(contentsOf: local).write(to: shaFile)) != nil else {
                Task { @MainActor in self?.fail("could not download the checksum") }
                return
            }
            guard let self else { return }
            // Then the payload, with progress.
            let delegate = ProgressDelegate { [weak self] p in
                Task { @MainActor in self?.progress = p }
            }
            let task = URLSession.shared.downloadTask(with: zip) { [weak self] local, _, error in
                guard let local, error == nil,
                      (try? FileManager.default.moveItem(at: local, to: zipFile)) != nil else {
                    Task { @MainActor in self?.fail("download failed") }
                    return
                }
                Task { @MainActor in self?.verifyAndSwap(version: version, dir: dir, shaFile: shaFile, zipFile: zipFile) }
            }
            task.delegate = delegate
            delegate.task = task
            task.resume()
        }.resume()
    }

    @MainActor
    private func verifyAndSwap(version: String, dir: URL, shaFile: URL, zipFile: URL) {
        status = .verifying
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // 1. sha256(update.zip) must equal the published digest.
            guard let shaText = try? String(contentsOf: shaFile, encoding: .utf8),
                  let digest = shaText.split(separator: " ").first.map(String.init),
                  let actual = Self.sha256(of: zipFile),
                  digest.lowercased() == actual.lowercased() else {
                Task { @MainActor in self?.fail("checksum mismatch — the download is not what was published") }
                return
            }
            // 2. Unzip.
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
            proc.arguments = ["-x", "-k", zipFile.path, dir.path]
            guard (try? proc.run()) != nil, proc.waitUntilExitAndGet() == 0 else {
                Task { @MainActor in self?.fail("could not extract the update") }
                return
            }
            let newApp = dir.appendingPathComponent("Vole.app")
            // 3. The payload must be what it claims: our bundle id and the
            //    advertised version — never swap in a different app.
            guard let info = Bundle(url: newApp)?.infoDictionary,
                  (info["CFBundleIdentifier"] as? String) == Bundle.main.bundleIdentifier,
                  (info["CFBundleShortVersionString"] as? String) == version else {
                Task { @MainActor in self?.fail("the payload is not Vole \(version)") }
                return
            }
            // 4. A locally downloaded payload carries quarantine; the checksum
            //    is the trust anchor here, so the flag goes.
            let strip = Process()
            strip.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
            strip.arguments = ["-dr", "com.apple.quarantine", newApp.path]
            try? strip.run(); strip.waitUntilExit()
            // 5. The swap: move the RUNNING bundle aside, move the new one into
            //    its exact path, launch it, terminate this process.
            let running = Bundle.main.bundleURL
            let backup = dir.appendingPathComponent("Vole-previous.app")
            do {
                try FileManager.default.moveItem(at: running, to: backup)
                try FileManager.default.moveItem(at: newApp, to: running)
            } catch {
                // Put the old one back if the second move failed — never leave
                // the slot empty.
                try? FileManager.default.moveItem(at: backup, to: running)
                Task { @MainActor in self?.fail("could not replace the app: \(error.localizedDescription)") }
                return
            }
            Task { @MainActor in
                self?.status = .installing
                // Relaunch via a detached helper: it waits for THIS process to
                // exit, then opens the new bundle. openApplication-from-a-dying-
                // process is a race the helper removes by construction.
                let spawner = Process()
                spawner.executableURL = URL(fileURLWithPath: "/bin/sh")
                // The path goes in as $0, not interpolated into the script: an app
                // installed under a path with a space (/Users/x/My Apps/Vole.app)
                // would otherwise split into two arguments and the update would
                // never relaunch.
                spawner.arguments = ["-c", "sleep 1; open \"$0\"", running.path]
                spawner.standardOutput = FileHandle.nullDevice
                spawner.standardError = FileHandle.nullDevice
                try? spawner.run()
                Task { @MainActor in NSApp.terminate(nil) }
            }
        }
    }

    @MainActor
    private func fail(_ reason: String) {
        status = .failed(reason)
    }

    private static func sha256(of file: URL) -> String? {
        guard let stream = InputStream(fileAtPath: file.path) else { return nil }
        stream.open()
        var hasher = SHA256()
        let bufSize = 1 << 20
        let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: bufSize)
        defer { buf.deallocate() }
        while stream.hasBytesAvailable {
            let n = stream.read(buf, maxLength: bufSize)
            guard n > 0 else { break }
            hasher.update(data: Data(bytes: buf, count: n))
        }
        stream.close()
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// Dotted numeric comparison ("0.1.10" > "0.1.9") — deliberately not
    /// String.compare(options: .numeric), which this project's own standards
    /// (never approximate, always exact) don't need to trust for something this
    /// easy to make unambiguous.
    static func isNewer(_ a: String, than b: String) -> Bool {
        let av = a.split(separator: ".").compactMap { Int($0) }
        let bv = b.split(separator: ".").compactMap { Int($0) }
        for i in 0..<max(av.count, bv.count) {
            let x = i < av.count ? av[i] : 0
            let y = i < bv.count ? bv[i] : 0
            if x != y { return x > y }
        }
        return false
    }
}

import CryptoKit

private extension Process {
    func waitUntilExitAndGet() -> Int32 {
        waitUntilExit()
        return terminationStatus
    }
}

private final class ProgressDelegate: NSObject, URLSessionDownloadDelegate {
    let onProgress: @Sendable (Double) -> Void
    var task: URLSessionTask?
    init(onProgress: @escaping @Sendable (Double) -> Void) { self.onProgress = onProgress }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        onProgress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite))
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {}
}
