import Foundation
import Observation

/// Checks GitHub's latest release once per launch and exposes whether it's newer than
/// this build. Notify-only, by design: no download, no install — just a toolbar icon
/// pointing at the release page. Silent on any failure (offline, rate-limited, parse
/// error) since a version check is never worth surfacing an error for.
@Observable
final class UpdateChecker {
    private(set) var latestVersion: String?
    private(set) var releaseURL: URL?

    var updateAvailable: Bool {
        guard let latest = latestVersion,
              let current = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        else { return false }
        return Self.isNewer(latest, than: current)
    }

    init() { check() }

    func check() {
        // Not /releases/latest — GitHub defines "latest" as the newest non-prerelease,
        // non-draft release, so it 404s as long as every release stays marked
        // prerelease (true for every one shipped so far). /releases lists all of them,
        // newest first, regardless of that flag.
        guard let url = URL(string: "https://api.github.com/repos/launchsafe/vole/releases?per_page=1") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data,
                  let list = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  let json = list.first,
                  let tag = json["tag_name"] as? String,
                  let htmlURLString = json["html_url"] as? String,
                  let htmlURL = URL(string: htmlURLString)
            else { return }
            let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            Task { @MainActor in
                self?.latestVersion = version
                self?.releaseURL = htmlURL
            }
        }.resume()
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
