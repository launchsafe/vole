import SwiftUI

// MARK: - Shadow AI (Tier 2 screen)
//
// The flagship: "this laptop runs N AI surfaces, and here is the evidence for
// each." Inventory, never usage — a surface row proves an artifact exists on
// disk, and the footer says so in the same breath as the counts, because reading
// inventory as spend is the exact mistake this screen exists to prevent.

struct ShadowAIPane: View {
    @Bindable var store: Store

    private var surfaces: [AiSurface] { store.aiSurfaces }
    private var byKind: [(kind: String, items: [AiSurface])] {
        Dictionary(grouping: surfaces, by: \.kind)
            .map { (kind: $0.key, items: $0.value.sorted { $0.name < $1.name }) }
            .sorted { $0.kind < $1.kind }
    }

    var body: some View {
        if surfaces.isEmpty {
            ContentUnavailableView {
                Label("No AI Surfaces Recorded", systemImage: "sparkle.magnifyingglass")
            } description: {
                Text("The census scanner has not found (or has not yet run over) any AI apps, gateways or CLIs on this Mac. It runs every 5 minutes — this list populates itself.")
            }
        } else {
            Form {
                Section {
                    let gateways = surfaces.filter { $0.kind == "gateway" }.count
                    let apps = surfaces.filter { $0.kind == "app" }.count
                    let clis = surfaces.filter { $0.kind == "cli" }.count
                    let unsanctioned = surfaces.filter { $0.sanctioned == false }.count
                    LabeledContent("AI surfaces") {
                        Text("\(surfaces.count)").font(.title2).fontWeight(.semibold).monospacedDigit()
                    }
                    LabeledContent("Installed AI apps", value: "\(apps)")
                    LabeledContent("Persistent gateways") {
                        Text("\(gateways)").foregroundStyle(gateways > 0 ? .orange : .primary)
                            .monospacedDigit()
                    }
                    LabeledContent("AI CLIs", value: "\(clis)")
                    if unsanctioned > 0 {
                        LabeledContent("Unsanctioned") {
                            Label("\(unsanctioned) not in policy", systemImage: "exclamationmark.shield")
                                .foregroundStyle(.red)
                        }
                    }
                } footer: {
                    Text(surfaces.allSatisfy { $0.sanctioned == nil }
                         ? "Inventory, never usage: a row proves an artifact exists on disk at its last-seen time — not that a prompt was sent, a token spent, or a dollar billed. No sanctioned-surfaces policy is loaded, so every row reads Unknown: 'unsanctioned' is a company decision, not a technical fact."
                         : "Inventory, never usage: a row proves an artifact exists on disk at its last-seen time — not that a prompt was sent, a token spent, or a dollar billed.")
                }

                ForEach(byKind, id: \.kind) { group in
                    Section(titleFor(group.kind)) {
                        ForEach(group.items) { s in
                            surfaceRow(s)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .sheet(item: $selectedSurface) { s in EvidenceLadderSheet(surface: s) }
        }
    }

    private func titleFor(_ kind: String) -> String {
        switch kind {
        case "app": "Installed AI Apps"
        case "gateway": "Persistent Gateways (launchd)"
        case "cli": "AI CLIs"
        case "ghost_app": "Ghost Apps — Ran Here, Since Deleted"
        case "runtime": "Local Model Runtimes (listening)"
        case "os": "The OS Itself"
        case "site": "AI Web Hosts (browser history)"
        case "extension": "AI Extensions (browser + editors)"
        case "credential": "Provider Credentials (names only, never values)"
        default: kind
        }
    }

    @ViewBuilder
    private func surfaceRow(_ s: AiSurface) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: iconFor(s.kind))
                    .foregroundStyle(
                        s.kind == "gateway" || s.kind == "ghost_app" ? .orange :
                        s.kind == "site" ? .blue : .secondary)
                Text(s.name).fontWeight(.medium)
                if let v = s.version {
                    Text("v\(v)").font(.caption).foregroundStyle(.tertiary)
                }
                // The policy verdict, or its honest absence — never a default.
                switch s.sanctioned {
                case .some(true):
                    Label("sanctioned", systemImage: "checkmark.seal")
                        .font(.caption2).foregroundStyle(.green)
                case .some(false):
                    Label("unsanctioned", systemImage: "exclamationmark.shield")
                        .font(.caption2).foregroundStyle(.red)
                case .none:
                    Label("unknown", systemImage: "questionmark.circle")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
                Text("seen \(Fmt.rel(s.lastSeen))")
                    .font(.caption2).foregroundStyle(.tertiary).monospacedDigit()
            }
            if let path = s.path {
                Text(path)
                    .font(.caption2).monospaced().foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.middle)
                    .textSelection(.enabled)
            }
            if let ev = s.evidence {
                Text(ev).font(.caption2).foregroundStyle(.quaternary)
            }
        }
        .padding(.vertical, 2)
        .onTapGesture { selectedSurface = s }
        .contextMenu {
            if let path = s.path {
                Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            }
            Button("Copy Evidence") { copyToPasteboard(s.evidence ?? s.surfaceKey) }
        }
    }

    /// The tapped surface, presented through the evidence ladder.
    @State private var selectedSurface: AiSurface?

    private func iconFor(_ kind: String) -> String {
        switch kind {
        case "app": "app.badge"
        case "gateway": "arrow.triangle.branch"
        case "cli": "terminal"
        case "ghost_app": "ghost"
        case "runtime": "server.rack"
        case "os": "cpu"
        case "site": "safari"
        case "extension": "puzzlepiece.extension"
        case "credential": "key"
        case "dependency": "shippingbox"
        case "context": "lock.shield"
        case "ghost_ext": "puzzlepiece"
        default: "questionmark"
        }
    }
}

/// The evidence ladder (#35): every surface states exactly what kind of fact it
/// is and what it can NEVER mean — a surface with inventory but no telemetry can
/// never be misread as spend.
struct EvidenceLadderSheet: View {
    let surface: AiSurface
    @Environment(\.dismiss) private var dismiss

    /// Where this surface's evidence sits on the ladder, weakest to strongest.
    private var rank: (step: Int, label: String) {
        switch surface.kind {
        case "app", "os", "dependency", "context": return (0, "installed / present")
        case "ghost_app", "ghost_ext": return (1, "ran here once (leftovers)")
        case "gateway", "cli", "store": return (2, "configured to run")
        case "runtime": return (3, "listening right now")
        case "extension", "credential", "site": return (2, "reachable / granted")
        default: return (0, "present")
        }
    }

    private let ladder = [
        "0 · present — an artifact exists on disk",
        "1 · ran here — leftovers prove past execution",
        "2 · active — configured, granted, or reachable",
        "3 · listening — a server bound to a port",
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "checkmark.shield.lefthalf.filled")
                    .foregroundStyle(.blue)
                Text(surface.name).font(.title3).fontWeight(.semibold)
                Spacer()
                Button("Done") { dismiss() }
            }
            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Evidence rank: \(rank.label)").font(.callout).fontWeight(.medium)
                    ForEach(Array(ladder.enumerated()), id: \.offset) { i, line in
                        HStack(spacing: 6) {
                            Image(systemName: i == rank.step ? "circle.fill" : "circle")
                                .font(.caption2)
                                .foregroundStyle(i == rank.step ? .blue : .secondary)
                            Text(line).font(.caption)
                                .foregroundStyle(i <= rank.step ? .primary : .secondary)
                        }
                    }
                }
            }
            if let ev = surface.evidence {
                GroupBox("What was observed") {
                    Text(ev).font(.callout).textSelection(.enabled)
                }
            }
            GroupBox {
                Label("This row is inventory, never spend: it does not prove a prompt was sent, a token counted, or a dollar billed.", systemImage: "exclamationmark.bubble")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(20)
        .frame(width: 460, height: 420)
    }
}

// MARK: - Triage (Tier 7 screen)
//
// The incidents screen the app never had: a queue with dispositions. Writes go
// through the ~/.vole/inbox spool — the app never writes the store — and the
// collector drains them into finding_actions on its next pass.

struct TriagePane: View {
    @Bindable var store: Store
    @State private var selected: Set<String> = []
    @State private var showHandled = false

    private var actionsByKey: [String: FindingAction] {
        Dictionary(uniqueKeysWithValues: store.findingActions.map { ($0.anomalyKey, $0) })
    }

    private func isActive(_ a: FindingAction) -> Bool {
        if a.action == "muted", let until = a.until, until < Int(Date.now.timeIntervalSince1970 * 1000) {
            return false // expired mute: back in the queue
        }
        return a.action == "acknowledged" || a.action == "muted"
    }

    private var queue: [Incident] {
        let byKey = actionsByKey
        return store.allIncidents.filter { i in
            guard let a = byKey[i.anomalyKey] else { return true }
            return showHandled || !isActive(a)
        }
    }

    var body: some View {
        if store.allIncidents.isEmpty {
            ContentUnavailableView("Queue Empty", systemImage: "checklist",
                                   description: Text("No incidents to triage."))
        } else {
            VStack(spacing: 0) {
                // The action bar: what happens to the selected set.
                HStack(spacing: 10) {
                    Label("\(selected.count) selected", systemImage: "checkmark.circle.folder")
                        .font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Acknowledge") { dispose("acknowledged") }
                        .disabled(selected.isEmpty)
                    Button("Mute 1h") { dispose("muted", until: Date.now.addingTimeInterval(3600)) }
                        .disabled(selected.isEmpty)
                    Button("Escalate") { dispose("escalated") }
                        .disabled(selected.isEmpty)
                    Divider().frame(height: 14)
                    Toggle("Show handled", isOn: $showHandled).toggleStyle(.checkbox)
                        .font(.caption)
                }
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(.bar)

                List {
                    ForEach(queue) { i in
                        triageRow(i)
                    }
                }
                .listStyle(.inset)
            }
        }
    }

    @ViewBuilder
    private func triageRow(_ i: Incident) -> some View {
        let action = actionsByKey[i.anomalyKey]
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle")
                .foregroundStyle(selected.contains(i.anomalyKey) ? Color.accentColor : Color.secondary.opacity(0.35))
                .onTapGesture { toggle(i.anomalyKey) }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Image(systemName: Pal.severityIcon(i.severity))
                        .foregroundStyle(Pal.severity(i.severity))
                    Text(Labels.rule[i.rule] ?? i.rule).fontWeight(.medium)
                    Text(Labels.tool[i.tool] ?? i.tool).foregroundStyle(.secondary)
                    if let a = action, isActive(a) {
                        Label(a.action, systemImage: a.action == "muted" ? "speaker.slash" : "checkmark")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.14), in: Capsule())
                    }
                }
                Text(i.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer()
            Text(Fmt.rel(i.windowStart))
                .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { toggle(i.anomalyKey) }
    }

    private func toggle(_ key: String) {
        withAnimation(.snappy(duration: 0.15)) {
            if selected.contains(key) { selected.remove(key) } else { selected.insert(key) }
        }
    }

    /// Writes the spool files — the store stays untouched by the app; the
    /// collector applies the intent on its next pass.
    private func dispose(_ action: String, until: Date? = nil) {
        let dir = (store.dbPath as NSString).deletingLastPathComponent + "/inbox"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let now = Int(Date.now.timeIntervalSince1970 * 1000)
        for key in selected {
            let name = "\(now)-\(key.hashValue & 0x7fffffff).json"
            let item: [String: Any?] = [
                "anomaly_key": key,
                "action": action,
                "until": until.map { Int($0.timeIntervalSince1970 * 1000) },
                "actor": "app",
                "created_at": now,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: item.compactMapValues { $0 as Any? ?? NSNull() }) {
                try? data.write(to: URL(fileURLWithPath: dir + "/" + name))
            }
        }
        withAnimation { selected.removeAll() }
    }
}

// MARK: - Privacy Center (Tier 3 screen, scoped)
//
// What Vole stores is exactly this list — no more. The no-content claim, the
// field dictionary, and the store facts, in one place a DPO can read.

struct PrivacyPane: View {
    @Bindable var store: Store

    var body: some View {
        Form {
            Section {
                Label("No prompt or tool content is stored", systemImage: "hand.raised.fill")
                    .font(.headline)
                Text("The collector's raw readers use a branded content type that only digest, classify or measure can consume, and `verify --content` checks the store against the claim: no column exists that could hold content, and every free-text value matches its writer's shape.")
                    .font(.caption).foregroundStyle(.secondary)
            } footer: {
                Text("Prevention (the type boundary) plus detection (verify --content) — the claim is a check, not a promise.")
            }

            Section("The Store") {
                LabeledContent("Path") {
                    Text(store.dbPath).font(.caption).monospaced().textSelection(.enabled)
                }
                LabeledContent("Schema") {
                    Text(store.storeSchemaVersion == 0 ? "pre-ledger" : "v\(store.storeSchemaVersion)")
                        .monospacedDigit()
                }
                LabeledContent("Collector") {
                    Text(store.collectorStatus == .live ? "live" : "not live").foregroundStyle(store.collectorStatus == .live ? .green : .orange)
                }
            }

            Section("Field Dictionary") {
                Text("Every table and column in the store — the complete answer to \"what is stored on this machine\".")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(store.fieldDictionary, id: \.table) { t in
                    DisclosureGroup {
                        ForEach(t.columns, id: \.name) { c in
                            HStack {
                                Text(c.name).font(.caption).monospaced()
                                Spacer()
                                Text(c.type).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    } label: {
                        Text(t.table).font(.callout).monospaced()
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}
