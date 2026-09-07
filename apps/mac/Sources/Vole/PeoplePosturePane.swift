import SwiftUI

// MARK: - People (Tier 3 screen)
//
// Per-principal figures with attribution coverage. The principal is
// pseudonymous by construction: an HMAC of the username, a short label,
// never a name or an email.

struct PeoplePane: View {
    @Bindable var store: Store

    var body: some View {
        if store.principals.isEmpty {
            ContentUnavailableView {
                Label("No Principals Recorded", systemImage: "person.2")
            } description: {
                Text("Principals appear once the collector runs: each is a pseudonymous HMAC — the store never holds a name or email.")
            }
        } else {
            Form {
                Section {
                    ForEach(store.principals) { p in
                        VStack(alignment: .leading, spacing: 3) {
                            HStack {
                                Image(systemName: "person.crop.circle").foregroundStyle(.blue)
                                Text(p.display).font(.callout).monospaced()
                                Spacer()
                                Text("seen \(Fmt.rel(p.lastSeen))").font(.caption2).foregroundStyle(.tertiary)
                            }
                            Text(p.principalKey).font(.caption2).monospaced().foregroundStyle(.quaternary)
                                .textSelection(.enabled)
                        }
                    }
                } header: {
                    Text("Principals")
                } footer: {
                    Text("Pseudonymous by construction: an HMAC under a Keychain-held key. A DPO can prove no email or name is stored — verify --content checks the claim.")
                }

                Section("Devices") {
                    ForEach(store.devices) { d in
                        HStack {
                            Image(systemName: "laptopcomputer").foregroundStyle(.secondary)
                            VStack(alignment: .leading) {
                                Text(d.hostname ?? "unknown host").font(.callout)
                                Text(d.deviceKey).font(.caption2).monospaced().foregroundStyle(.quaternary)
                            }
                            Spacer()
                            Text("seen \(Fmt.rel(d.lastSeen))").font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }
}

// MARK: - Posture (Tier 6 screen)
//
// What granted the authority in the first place: every permission declaration
// in every agent's own config — the file that granted it, quoted verbatim,
// with first-seen dates.

struct PosturePane: View {
    @Bindable var store: Store

    var body: some View {
        if store.grants.isEmpty {
            ContentUnavailableView {
                Label("No Grants Recorded", systemImage: "checkmark.shield")
            } description: {
                Text("The grants sweep reads each agent's own permission settings every pass — declarations appear here as they are found.")
            }
        } else {
            Form {
                Section {
                    let allows = store.grants.filter { $0.kind == "allow" }.count
                    let denies = store.grants.filter { $0.kind == "deny" }.count
                    let hooks = store.grants.filter { $0.kind == "hook" }.count
                    let mcps = store.grants.filter { $0.kind == "mcp" }.count
                    LabeledContent("Allow declarations") {
                        Text("\(allows)").font(.title2).fontWeight(.semibold).monospacedDigit()
                    }
                    LabeledContent("Denies", value: "\(denies)")
                    LabeledContent("Hooks", value: "\(hooks)").foregroundStyle(hooks > 0 ? .orange : .secondary)
                    LabeledContent("MCP servers", value: "\(mcps)")
                } footer: {
                    Text("Every declaration, quoted verbatim from the file that granted it. A wildcard allow is standing authority — the wider it is, the more an agent can do unasked.")
                }

                ForEach(["allow", "deny", "hook", "mcp"], id: \.self) { kind in
                    let items = store.grants.filter { $0.kind == kind }
                    if !items.isEmpty {
                        Section(title(kind)) {
                            ForEach(items) { g in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(g.entry)
                                        .font(.caption.monospaced())
                                        .lineLimit(2).truncationMode(.middle)
                                        .textSelection(.enabled)
                                    Text("\(g.agent) · \(g.sourceFile as NSString).lastPathComponent · since \(Fmt.rel(g.firstSeen))")
                                        .font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    private func title(_ kind: String) -> String {
        switch kind {
        case "allow": "Allowed (standing authority)"
        case "deny": "Denied"
        case "hook": "Hooks (run on events)"
        case "mcp": "MCP Servers"
        default: kind
        }
    }
}
