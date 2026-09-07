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
        case idle
        case checking
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

    private struct Release {
        let version: String
        let htmlURL: URL
        let zipAsset: URL?
        let shaAsset: URL?
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

    func check() {
        guard Self.isBundledApp else { return }
        status = .checking
        // Not /releases/latest — GitHub defines "latest" as the newest non-prerelease,
        // non-draft release, so it 404s as long as every release stays marked
        // prerelease. /releases lists all of them, newest first.
        guard let url = URL(string: ProcessInfo.processInfo.environment["VOLE_UPDATE_API"]
                  ?? "https://api.github.com/repos/launchsafe/vole/releases?per_page=1") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data,
                  let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  let json = list.first,
                  let tag = json["tag_name"] as? String,
                  let htmlURLString = json["html_url"] as? String,
                  let htmlURL = URL(string: htmlURLString)
            else {
                Task { @MainActor in self?.status = .idle }
                return
            }
            let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            let assets = (json["assets"] as? [[String: Any]]) ?? []
            let assetURL = { (ext: String) -> URL? in
                assets.first { ($0["name"] as? String ?? "").hasSuffix(ext) }
                    .flatMap { $0["browser_download_url"] as? String }
                    .flatMap(URL.init(string:)) 
            }
            let release = Release(
                version: version,
                htmlURL: htmlURL,
                zipAsset: assetURL(".zip"),
                shaAsset: assetURL(".zip.sha256"))
            Task { @MainActor in self?.apply(release) }
        }.resume()
    }

    @MainActor
    private func apply(_ release: Release) {
        latestVersion = release.version
        releaseURL = release.htmlURL
        guard let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              Self.isNewer(release.version, than: current) else {
            status = .idle
            return
        }
        zipAsset = release.zipAsset
        shaAsset = release.shaAsset
        status = .available(version: release.version)
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
                spawner.arguments = ["-c", "sleep 1; open \(running.path)"]
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

    /// The GitHub token for private-repo update checks, if the user stored one.
    private static func githubToken() -> String? {
        if let env = ProcessInfo.processInfo.environment["VOLE_GH_TOKEN"], !env.isEmpty { return env }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        p.arguments = ["find-generic-password", "-s", "vole-github-token", "-w"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        p.waitUntilExit()
        guard p.terminationStatus == 0,
              let token = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                  .trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty
        else { return nil }
        return token
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
