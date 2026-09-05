import SwiftUI
import AppKit

// MARK: - Palette
//
// Apple-native: series and status colours are the system palette, so they track the
// user's accent and Increase-Contrast settings. Surfaces are semantic system colours;
// most of the UI lets `Form` / `List` supply the chrome and never touches these.

enum Pal {
    /// One colour per tool, keyed to its brand mark — never reused for status.
    static func series(_ tool: String) -> Color {
        switch tool {
        case "claude_code": return Color(red: 0.84, green: 0.47, blue: 0.35)  // Anthropic coral
        case "codex":       return Color(red: 0.44, green: 0.56, blue: 1.0)  // Codex periwinkle
        case "cursor":      return .green
        case "antigravity": return .yellow
        case "opencode":    return Color(red: 0.77, green: 0.79, blue: 0.83)  // silver
        case "grok":        return .pink
        case "devin":       return .indigo
        default:            return .secondary
        }
    }

    /// SF Symbol fallback for a tool with no bundled logo (see ToolIcon).
    static func symbol(_ tool: String) -> String {
        switch tool {
        case "claude_code": return "asterisk"
        case "codex":       return "circle.hexagongrid.fill"
        case "cursor":      return "cursorarrow"
        case "antigravity": return "arrow.up.circle.fill"
        case "opencode":    return "chevron.left.forwardslash.chevron.right"
        case "grok":        return "bolt.fill"
        case "devin":       return "cpu"
        default:            return "circle.fill"
        }
    }

    static func severity(_ s: String) -> Color {
        switch s {
        case "critical": return .red
        case "warn":     return .orange
        default:         return .green
        }
    }

    /// SF Symbol per severity, for native status glyphs.
    static func severityIcon(_ s: String) -> String {
        switch s {
        case "critical": return "exclamationmark.triangle.fill"
        case "warn":     return "exclamationmark.circle.fill"
        default:         return "checkmark.circle.fill"
        }
    }

    static let good     = Color.green
    static let warning  = Color.orange
    static let critical  = Color.red

    static let surface  = Color(nsColor: .controlBackgroundColor)
    static let line     = Color(nsColor: .separatorColor)
    static let inkDim   = Color.secondary
    static let inkFaint = Color(nsColor: .tertiaryLabelColor)
}

// MARK: - Formatters  (ported from apps/dashboard/lib/format.ts)

enum Fmt {
    static func compact(_ n: Int?) -> String {
        guard let n else { return "—" }
        let a = abs(Double(n))
        if a >= 1e9 { return String(format: "%.1fB", Double(n) / 1e9) }
        if a >= 1e6 { return String(format: "%.1fM", Double(n) / 1e6) }
        if a >= 1e3 { return String(format: "%.1fK", Double(n) / 1e3) }
        return String(n)
    }
    static func money(_ n: Double?) -> String {
        guard let n else { return "—" }               // never coerced to $0
        return String(format: "$%.2f", n)
    }
    static func pct(_ n: Double?) -> String {
        guard let n else { return "—" }
        return "\(Int((n * 100).rounded()))%"
    }
    static func rel(_ ms: Int) -> String {
        let m = Int((Date().timeIntervalSince1970 * 1000 - Double(ms)) / 60_000)
        if m < 1 { return "now" }
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        let d = h / 24
        return d < 30 ? "\(d)d" : "\(d / 30)mo"
    }
    static func clock(_ ms: Int) -> String {
        let f = DateFormatter(); f.dateFormat = "HH:mm"
        return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
    }
}

/// The real vendor logo for a tool (bundled from local app icons / extension assets),
/// on a light rounded chip so dark marks stay legible in both themes. Falls back to a
/// tinted SF Symbol when no logo is bundled.
struct ToolIcon: View {
    let tool: String
    var size: CGFloat = 16

    private static let logos: [String: NSImage] = {
        var m: [String: NSImage] = [:]
        for t in ["claude_code", "codex", "cursor", "antigravity", "opencode", "grok", "devin"] {
            if let u = Bundle.module.url(forResource: t, withExtension: "png"),
               let i = NSImage(contentsOf: u) { m[t] = i }
        }
        return m
    }()

    // Bare near-black marks that would vanish on a dark sidebar — render these as a
    // tinted template instead of the raw bitmap.
    private static let monochrome: Set<String> = ["cursor", "grok"]

    var body: some View {
        if let img = Self.logos[tool] {
            if Self.monochrome.contains(tool) {
                Image(nsImage: img)
                    .resizable().renderingMode(.template).interpolation(.high).scaledToFit()
                    .foregroundStyle(.primary)
                    .frame(width: size, height: size)
            } else {
                Image(nsImage: img)
                    .resizable().interpolation(.high).scaledToFit()
                    .frame(width: size, height: size)
            }
        } else {
            Image(systemName: Pal.symbol(tool))
                .font(.system(size: size * 0.8))
                .foregroundStyle(Pal.series(tool))
                .frame(width: size)
        }
    }
}

enum Labels {
    static let order = ["claude_code", "codex", "cursor", "antigravity", "opencode", "grok", "devin"]
    static let tool: [String: String] = [
        "claude_code": "Claude Code", "codex": "Codex",
        "cursor": "Cursor", "antigravity": "Antigravity",
        "opencode": "OpenCode", "grok": "Grok", "devin": "Devin",
    ]
    static let toolShort: [String: String] = [
        "claude_code": "Claude", "codex": "Codex",
        "cursor": "Cursor", "antigravity": "Antigrav",
        "opencode": "OpenCode", "grok": "Grok", "devin": "Devin",
    ]
    static let rule: [String: String] = [
        "burn_rate_spike": "Burn spike", "loop_suspected": "Runaway loop",
        "error_storm": "Retry storm", "rate_limit_pressure": "Rate limit",
        "context_pressure": "Context pressure",
    ]
    static func confidence(_ c: String) -> String {
        c == "exact" ? "exact" : "no tokens"
    }
}

func copyToPasteboard(_ s: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
}

// MARK: - Debug self-check  (ponytail: smallest thing that fails if the maths breaks)

func runSelfCheck() {
    assert(Fmt.compact(1500) == "1.5K")
    assert(Fmt.compact(2_100_000) == "2.1M")
    assert(Fmt.compact(nil) == "—")
    assert(Fmt.money(nil) == "—")
    assert(DateRange.h24.bucketMs == 3_600_000)
    assert(DateRange.d7.bucketMs == 86_400_000)
    assert(RefreshInterval(rawValue: 5) == .live && RefreshInterval.h1.rawValue == 3600)
    assert(RefreshInterval.allCases.count == 5)
    let ms = 1_700_000_123_456
    let snapped = (ms / DateRange.h24.bucketMs) * DateRange.h24.bucketMs
    assert(snapped <= ms && ms - snapped < 3_600_000)
}
