import Foundation
import Observation
import AppKit
import Security

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
    /// Whether the in-flight check was asked for by the user (see check(userInitiated:)).
    private var userInitiated = false

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
    /// Asset URLs are CONSTRUCTED, not looked up. bundle.sh names them
    /// Vole-<version>.zip and Vole-<version>.zip.sha256, and GitHub serves every
    /// release asset at a stable path, so the last api.github.com call disappears
    /// from the update path — it is now zero-API end to end.
    private static func assets(tag: String, version: String) -> (zip: URL?, sha: URL?) {
        let base = "https://github.com/launchsafe/vole/releases/download/\(tag)"
        return (URL(string: "\(base)/Vole-\(version).zip"),
                URL(string: "\(base)/Vole-\(version).zip.sha256"))
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

    /// How long a background check waits before bothering GitHub again. Sparkle
    /// defaults to 24h (1h floor), Chrome 4.5h, Firefox 6h, Microsoft AutoUpdate 13h
    /// — nobody checks on every launch, which is what this used to do.
    private static let backgroundInterval: TimeInterval = 24 * 60 * 60
    private static let lastCheckKey = "vole.lastUpdateCheck"

    /// `userInitiated` is the whole difference between the two behaviours Sparkle
    /// separates: a scheduled check is silent when it fails (SPUScheduledUpdateDriver
    /// passes showErrorToUser:NO) and skipped when it ran recently; a check the user
    /// asked for always runs and always reports. This app used to treat both alike,
    /// which is why one transient failure left a red error sitting in Settings until
    /// the next relaunch.
    func check(userInitiated: Bool = false) {
        guard Self.isBundledApp else { return }
        if !userInitiated {
            let last = UserDefaults.standard.double(forKey: Self.lastCheckKey)
            if last > 0, Date().timeIntervalSince1970 - last < Self.backgroundInterval { return }
        }
        self.userInitiated = userInitiated
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
                    report("could not read GitHub's response")
                    return
                }
                guard http.statusCode == 200 else {
                    report(Self.failureReason(http))
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
                report("could not reach GitHub — \(error.localizedDescription)")
            }
        }
    }

    /// Decide on the version alone. Being current is the common case and ends here,
    /// having spent no API quota at all.
    @MainActor
    private func consider(version: String, page: URL) {
        // Stamp the successful check, so a background check honours the interval.
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: Self.lastCheckKey)
        latestVersion = version
        releaseURL = page
        guard let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              Self.isNewer(version, than: current) else {
            status = .upToDate
            return
        }
        // The tag is the last path component of the page we were redirected to.
        let tag = page.lastPathComponent
        let (zip, sha) = Self.assets(tag: tag, version: version)
        zipAsset = zip
        shaAsset = sha
        status = .available(version: version)
    }

    private var zipAsset: URL?
    private var shaAsset: URL?

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
            // 4. The payload must be signed by whoever signed what is running.
            //    The checksum above proves only that the bytes are what the release
            //    published — and the .zip and the .zip.sha256 are two assets of the
            //    SAME release, so anyone who can write that release writes both. The
            //    Developer ID signature is the one thing an attacker with release
            //    access does not have; bundle.sh spends three steps producing it and
            //    this path used to download it and throw it away. Sparkle's
            //    SUCodeSigningVerifier makes exactly this check.
            guard let requirement = Self.runningAppRequirement() else {
                Task { @MainActor in self?.fail("this build is not signed, so an update cannot be verified") }
                return
            }
            guard Self.bundle(newApp, satisfies: requirement) else {
                Task { @MainActor in self?.fail("the update is not signed by the same developer as this app") }
                return
            }
            // 5. Only now does quarantine come off — the signature, not the
            //    checksum, is what earns that.
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

    /// A failed BACKGROUND check goes quiet — `.idle` renders as nothing in the
    /// pane, which is what every reference implementation does (Firefox tolerates ten
    /// consecutive silent background failures before surfacing anything). It is still
    /// NOT `.upToDate`: the rule this file already had — that a check which never
    /// reached GitHub must never render as "you are up to date" — still holds.
    @MainActor
    private func report(_ reason: String) {
        status = userInitiated ? .failed(reason) : .idle
    }

    @MainActor
    private func fail(_ reason: String) {
        status = .failed(reason)
    }

    /// The requirement the running app itself satisfies — its designated
    /// requirement, which for a Developer ID build pins the bundle identifier, the
    /// Apple anchor and the signing team. An update has to satisfy the same thing.
    private static func runningAppRequirement() -> SecRequirement? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(Bundle.main.bundleURL as CFURL, [], &code) == errSecSuccess,
              let code else { return nil }
        var req: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(code, [], &req) == errSecSuccess else { return nil }
        return req
    }

    /// Fails closed: anything we cannot fully validate is not installed.
    private static func bundle(_ url: URL, satisfies requirement: SecRequirement) -> Bool {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
              let code else { return false }
        // Nested code too — the embedded collector is signed separately, and a
        // payload could otherwise carry a valid outer signature over a tampered one.
        // kSecCSStrictValidate is load-bearing, not belt-and-braces: without it a
        // byte appended to the signed collector binary is ACCEPTED (measured — the
        // Mach-O loader ignores trailing bytes past the signature blob, so only
        // strict validation notices). It is what `codesign --strict` turns on.
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures
                               | kSecCSCheckNestedCode
                               | kSecCSStrictValidate)
        return SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess
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
    /// Semver-ish comparison. Each component compares on its numeric prefix, and a
    /// prerelease suffix ranks BELOW its absence, so 1.1.0 > 1.1.0-beta.2.
    ///
    /// The old form was `compactMap { Int($0) }`, which DROPPED a component it could
    /// not parse instead of stopping at it, shifting the rest left: "1.0.1-rc1" became
    /// [1, 0] and so never counted as newer than 1.0.0, and "1.1.0-beta.2" became
    /// [1, 1, 2] — i.e. 1.1.2 — so anyone on that beta would never be offered the real
    /// 1.1.0, which parses lower.
    static func isNewer(_ a: String, than b: String) -> Bool {
        func parse(_ s: String) -> (nums: [Int], prerelease: Bool) {
            let core = s.split(separator: "-", maxSplits: 1).first.map(String.init) ?? s
            return (core.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 },
                    s.contains("-"))
        }
        let (an, apre) = parse(a)
        let (bn, bpre) = parse(b)
        for i in 0..<max(an.count, bn.count) {
            let x = i < an.count ? an[i] : 0
            let y = i < bn.count ? bn[i] : 0
            if x != y { return x > y }
        }
        // Same numbers: a final release outranks a prerelease of it.
        if apre != bpre { return bpre }
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
