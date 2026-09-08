import SwiftUI

// MARK: - Behaviour (Tier 5 screen)
//
// The tool-call ledger's window: recent invocations with their outcome
// (status + provenance), authority, and measured duration. This is the
// "what did the agent actually run" view that usage_events could never give.

struct BehaviourPane: View {
    @Bindable var store: Store
    @State private var filter: String = "all"
    @State private var tab: String = "calls"

    var body: some View {
        if store.toolCalls.isEmpty {
            ContentUnavailableView {
                Label("No Tool Calls Recorded", systemImage: "waveform.path")
            } description: {
                Text("The ledger fills as the collectors read tool_use/result pairs, exec_done lines and tool parts.")
            }
        } else {
            VStack(spacing: 0) {
                // Acting now (#26): the last 5 minutes of the ledger, per agent.
                let recent = store.toolCalls.filter { Date.now.timeIntervalSince1970 * 1000 - Double($0.ts) < 300_000 }
                if !recent.isEmpty {
                    HStack(spacing: 10) {
                        Circle().fill(.green).frame(width: 8, height: 8)
                        Text("Acting now — \(recent.count) call\(recent.count == 1 ? "" : "s") in the last 5 min")
                            .font(.caption).fontWeight(.medium)
                        let counts = Dictionary(grouping: recent.map(\.name), by: { $0 }).mapValues(\.count)
                        if let top = counts.max(by: { $0.value < $1.value }), top.value >= 2 {
                            Text("· mostly \(top.key)").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if recent.contains(where: { $0.status == "denied" }) {
                            Label("denials in play", systemImage: "hand.raised.fill")
                                .font(.caption2).foregroundStyle(.orange)
                        }
                    }
                    .padding(.horizontal, 14).padding(.top, 10)
                }

                Picker("Tab", selection: $tab) {
                    Text("Calls").tag("calls")
                    Text("Files").tag("files")
                    Text("Ingress").tag("ingress")
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14).padding(.top, 8)

                switch tab {
                case "files": filesTab
                case "ingress": ingressTab
                default: callsTab
                }
            }
        }
    }

    private func fetchLine(_ h: IngressHostRow) -> String {
        let calls = "\(h.calls) fetch\(h.calls == 1 ? "" : "es")"
        return h.statusUnknown > 0 ? "\(calls) · \(h.statusUnknown) with unknown status" : calls
    }

    private var callsTab: some View {
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

            // The subagent tree (#14): who did what, per session/agent.
            if !store.agentEdges.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Agent tree — top sessions by activity")
                        .font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                    ForEach(store.agentEdges.prefix(6)) { e in
                        HStack(spacing: 8) {
                            Image(systemName: e.agent == "main" ? "person.fill" : "arrow.triangle.branch")
                                .font(.caption2)
                                .foregroundStyle(e.agent == "main" ? AnyShapeStyle(HierarchicalShapeStyle.secondary) : AnyShapeStyle(Color.blue))
                            Text(e.session.prefix(8)).font(.caption2).monospaced().foregroundStyle(.tertiary)
                            Text(e.agent == "main" ? "main" : e.agent)
                                .font(.caption2).foregroundStyle(e.agent == "main" ? AnyShapeStyle(HierarchicalShapeStyle.secondary) : AnyShapeStyle(Color.blue))
                            Spacer()
                            Text("\(e.calls) calls").font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                            if e.errors > 0 {
                                Text("\(e.errors) err").font(.caption2).foregroundStyle(.red)
                            }
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
            }
        }
    }

    /// The Files tab (tier 5 #16): writes split by method, unresolved paths
    /// counted, never dropped.
    private var filesTab: some View {
        List {
            if store.writeClasses.isEmpty {
                Text("No file writes recorded in this range.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(store.writeClasses) { w in
                    HStack(spacing: 10) {
                        Image(systemName: "doc.badge.plus").foregroundStyle(.secondary)
                        Text(w.writeClass).font(.callout.monospaced())
                        Spacer()
                        Text("\(w.writes) write\(w.writes == 1 ? "" : "s")")
                            .monospacedDigit().foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.inset)
        .safeAreaInset(edge: .bottom) {
            if let unresolved = store.writeClasses.first?.unresolved, unresolved > 0 {
                Text("\(unresolved) write\(unresolved == 1 ? "" : "s") have no resolved path — counted here, never dropped.")
                    .font(.caption2).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.bottom, 6)
            }
        }
    }

    /// The ingress band (tier 5 #22): hosts ranked by bytes, with call count and
    /// the unknown-status count. Received bytes, never claimed as context-entered.
    private var ingressTab: some View {
        List {
            if store.ingressHosts.isEmpty {
                Text("No fetch ingress recorded in this range.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(ingressRanked) { h in
                    ingressRow(h)
                }
            }
        }
        .listStyle(.inset)
    }

    /// Hosts ranked by bytes (the tier-5 #22 spec); unknown sizes last, then by calls.
    private var ingressRanked: [IngressHostRow] {
        store.ingressHosts.sorted {
            let a = $0.bytes ?? -1, b = $1.bytes ?? -1
            return a == b ? $0.calls > $1.calls : a > b
        }
    }

    private func ingressRow(_ h: IngressHostRow) -> some View {
        let sizeText: String
        let sizeHelp: String
        if let bytes = h.bytes {
            sizeText = Fmt.compact(bytes) + " B"
            sizeHelp = "Bytes the fetcher received; how much entered the model's context is unknown (the tool truncates first)."
        } else {
            sizeText = "size unknown"
            sizeHelp = "The fetcher never stated a size — unknown, never zero."
        }
        return HStack(spacing: 10) {
            Image(systemName: "globe").foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text(h.urlHost ?? "no host recorded").font(.callout)
                Text(fetchLine(h))
                    .font(.caption2)
                    .foregroundStyle(h.statusUnknown > 0 ? AnyShapeStyle(Color.orange) : AnyShapeStyle(HierarchicalShapeStyle.tertiary))
            }
            Spacer()
            Text(sizeText)
                .font(.callout).monospacedDigit()
                .foregroundStyle(h.bytes == nil ? AnyShapeStyle(HierarchicalShapeStyle.tertiary) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
                .help(sizeHelp)
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

// MARK: - Blast Radius (Tier 5 screen, #17)
//
// Every system outside this laptop that agents touched: action_targets joined
// to the child ledgers' scope reach. Targets Vole could name from local
// evidence — this is not an inventory of the company's systems and must not
// be read as one.

struct BlastRadiusPane: View {
    @Bindable var store: Store

    var body: some View {
        if store.blastTargets.isEmpty {
            ContentUnavailableView {
                Label("Nothing Left This Laptop", systemImage: "circle.dashed")
            } description: {
                Text("No named action targets recorded in the ledger. When agents act on systems beyond this filesystem, they appear here.")
            }
        } else {
            Form {
                Section {
                    LabeledContent("Targets touched") {
                        Text("\(store.blastTargets.count)").font(.title2).fontWeight(.semibold).monospacedDigit()
                    }
                    LabeledContent("Calls on those targets", value: "\(store.blastTargets.reduce(0) { $0 + $1.calls })")
                } footer: {
                    Text("Every system outside this filesystem the agents acted on, from action_targets with locality and declared environment. A resolved label is what the local evidence says — not what a credential proves.")
                }

                Section {
                    ForEach(store.blastTargets) { t in targetRow(t) }
                } header: {
                    Text("By Target")
                } footer: {
                    Text("Child-ledger corroboration (writes, VCS actions, package executions) is the range total across the same window, not a per-target figure — it says the ledgers that witness scope were live, never that this target saw each one.")
                }
            }
            .formStyle(.grouped)
        }
    }

    @ViewBuilder
    private func targetRow(_ t: BlastTargetRow) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon(t.targetKind)).foregroundStyle(tint(t.locality))
            VStack(alignment: .leading, spacing: 2) {
                Text(t.targetLabel ?? "no target named")
                    .font(.callout).lineLimit(1).truncationMode(.middle)
                // 'remote, env undeclared, 139 calls' — the ground-truth row shape.
                Text("\(t.locality ?? "locality unknown") · \(t.envClass.map { "env \($0)" } ?? "env undeclared") · \(t.calls) call\(t.calls == 1 ? "" : "s")")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer()
            Text(t.targetKind).font(.caption2).monospaced().foregroundStyle(.secondary)
        }
        .padding(.vertical, 1)
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "database": return "cylinder"
        case "vcs_repo": return "arrow.triangle.branch"
        case "url", "web_host": return "globe"
        case "package_registry": return "shippingbox"
        default: return "arrow.up.right"
        }
    }
    private func tint(_ locality: String?) -> Color {
        locality == "remote" ? .orange : .indigo
    }
}
