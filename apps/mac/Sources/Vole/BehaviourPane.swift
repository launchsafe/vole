import SwiftUI

// MARK: - Behaviour (Tier 5 screen)
//
// The tool-call ledger's window: recent invocations with their outcome
// (status + provenance), authority, and measured duration. This is the
// "what did the agent actually run" view that usage_events could never give.

struct BehaviourPane: View {
    @Bindable var store: Store
    @State private var filter: String = "all"

    var body: some View {
        if store.toolCalls.isEmpty {
            ContentUnavailableView {
                Label("No Tool Calls Recorded", systemImage: "waveform.path")
            } description: {
                Text("The ledger fills as the collectors read tool_use/result pairs, exec_done lines and tool parts.")
            }
        } else {
            VStack(spacing: 0) {
                Picker("Filter", selection: $filter) {
                    Text("All").tag("all")
                    Text("Errors").tag("error")
                    Text("Denied").tag("denied")
                    Text("Remote").tag("remote")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14).padding(.vertical, 8)

                List {
                    ForEach(filtered) { c in
                        callRow(c)
                    }
                }
                .listStyle(.inset)
            }
        }
    }

    private var filtered: [ToolCallEntry] {
        switch filter {
        case "error": return store.toolCalls.filter { $0.status == "error" }
        case "denied": return store.toolCalls.filter { $0.status == "denied" || $0.authority == "denied" }
        case "remote": return store.toolCalls.filter { c in
            c.shape.map { s in s.hasPrefix("ssh") || s.hasPrefix("scp") || s.hasPrefix("rsync") || s.hasPrefix("docker") || s.hasPrefix("kubectl") } ?? false
        }
        default: return store.toolCalls
        }
    }

    @ViewBuilder
    private func callRow(_ c: ToolCallEntry) -> some View {
        HStack(spacing: 10) {
            Image(systemName: statusIcon(c.status))
                .foregroundStyle(statusColor(c.status))
                .help(c.statusSource.map { "provenance: \($0)" } ?? "outcome unknown")
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(c.name.isEmpty ? (c.shape ?? "?") : c.name)
                        .fontWeight(.medium)
                    if let shape = c.shape, shape != c.name, shape.count > c.name.count {
                        Text(shape).font(.caption2).monospaced().foregroundStyle(.tertiary)
                    }
                    if c.authority == "denied" {
                        Label("denied", systemImage: "hand.raised").font(.caption2).foregroundStyle(.red)
                    }
                }
                HStack(spacing: 8) {
                    Text(Labels.toolShort[c.tool] ?? c.tool).font(.caption2).foregroundStyle(.secondary)
                    if let s = c.sessionID { Text(s.prefix(8)).font(.caption2).monospaced().foregroundStyle(.tertiary) }
                    if let d = c.durationMs {
                        Text(d >= 60000 ? "\(d / 60000)m" : "\(d / 1000)s")
                            .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                        if c.durationKind == "measured" {
                            Image(systemName: "checkmark.seal.fill").font(.caption2).foregroundStyle(.green)
                                .help("measured duration")
                        }
                    }
                }
            }
            Spacer()
            Text(Fmt.rel(c.ts)).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 1)
    }

    private func statusIcon(_ s: String?) -> String {
        switch s {
        case "success": "checkmark.circle.fill"
        case "error": "xmark.circle.fill"
        case "denied": "hand.raised.fill"
        default: "questionmark.circle"
        }
    }
    private func statusColor(_ s: String?) -> Color {
        switch s {
        case "success": .green
        case "error": .red
        case "denied": .orange
        default: .secondary
        }
    }
}

// MARK: - Blast Radius (Tier 5 screen)
//
// Every destination the agents touched, from command shapes — ssh, docker,
// kubectl, curl to endpoints. Shapes, never command strings: this screen shows
// WHERE the work went, not what was typed.

struct BlastRadiusPane: View {
    @Bindable var store: Store

    var body: some View {
        if store.blastRadius.isEmpty {
            ContentUnavailableView {
                Label("Nothing Left This Laptop", systemImage: "circle.dashed")
            } description: {
                Text("No remote-execution shapes (ssh, docker, kubectl, curl) recorded in the ledger. When agents run remote commands, they appear here.")
            }
        } else {
            Form {
                Section {
                    LabeledContent("Destinations touched") {
                        Text("\(store.blastRadius.count)").font(.title2).fontWeight(.semibold).monospacedDigit()
                    }
                    LabeledContent("Remote commands", value: "\(store.blastRadius.reduce(0) { $0 + $1.calls })")
                } footer: {
                    Text("Command shapes, never command strings — WHERE the work went, not what was typed.")
                }

                Section("By Destination Shape") {
                    ForEach(store.blastRadius) { b in
                        HStack(spacing: 10) {
                            Image(systemName: icon(b.shape))
                                .foregroundStyle(tint(b.shape))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(b.shape).font(.callout.monospaced())
                                Text("last \(Fmt.rel(b.last))").font(.caption2).foregroundStyle(.tertiary)
                            }
                            Spacer()
                            Text("\(b.calls) calls").monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private func icon(_ shape: String) -> String {
        if shape.hasPrefix("ssh") || shape.hasPrefix("scp") { return "terminal" }
        if shape.hasPrefix("docker") { return "cube" }
        if shape.hasPrefix("kubectl") { return "helm.2" }
        if shape.hasPrefix("curl") { return "globe" }
        return "arrow.up.right"
    }
    private func tint(_ shape: String) -> Color {
        if shape.hasPrefix("curl") { return .blue }
        if shape.hasPrefix("kubectl") || shape.hasPrefix("docker") { return .indigo }
        return .orange
    }
}
