import SwiftUI

// MARK: - People (Tier 3 screen)
//
// Per-principal figures with attribution coverage. The principal is
// pseudonymous by construction: an HMAC of the username, a short label,
// never a name or an email.

struct PeoplePane: View {
    @Bindable var store: Store

    var body: some View {
        if store.principalSummary.isEmpty && store.principals.isEmpty {
            ContentUnavailableView {
                Label("No Principals Recorded", systemImage: "person.2")
            } description: {
                Text("Principals appear once the collector runs: each is a pseudonymous HMAC — the store never holds a name or email.")
            }
        } else {
            Form {
                // The principal dimension (tier 3): who used which agent, with
                // attribution coverage spelled out rather than smoothed over.
                Section {
                    ForEach(store.principalSummary) { p in principalRow(p) }
                } header: {
                    Text("Principals")
                } footer: {
                    Text("Pseudonymous by construction: an HMAC under a Keychain-held key. A DPO can prove no email or name is stored — verify --content checks the claim. Tokens and cost are exact rows only; absence of an identity row is printed, never hidden.")
                }

                // The origin-unknown band: calls with no identity seam at all.
                if store.originUnknownCalls > 0 || store.originUnknownTokens != nil {
                    Section {
                        LabeledContent("Calls with no principal resolved") {
                            Text("\(store.originUnknownCalls)").monospacedDigit()
                        }
                        LabeledContent("Tokens (exact rows only)") {
                            Text(store.originUnknownTokens.map { Fmt.compact($0) } ?? "unknown")
                                .monospacedDigit().foregroundStyle(store.originUnknownTokens == nil ? .tertiary : .secondary)
                        }
                    } header: {
                        Text("Origin Unknown")
                    } footer: {
                        Text("Calls the identity seam could not attribute — counted, never dropped and never reassigned.")
                    }
                }

                if store.principalSummary.isEmpty && !store.principals.isEmpty {
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
                        Text("Principals (registry)")
                    }
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

    @ViewBuilder
    private func principalRow(_ p: PrincipalSummaryRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "person.crop.circle").foregroundStyle(.blue)
                Text(p.display).font(.callout).monospaced()
                Spacer()
            }
            HStack(spacing: 10) {
                Text("\(p.calls) call\(p.calls == 1 ? "" : "s")")
                Text("\(p.sessions) session\(p.sessions == 1 ? "" : "s")")
                Text(p.tokens.map { Fmt.compact($0) + " tok" } ?? "tokens unknown")
                    .foregroundStyle(p.tokens == nil ? AnyShapeStyle(HierarchicalShapeStyle.tertiary) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
                Text(Fmt.money(p.cost))
                    .foregroundStyle(p.cost == nil ? AnyShapeStyle(HierarchicalShapeStyle.tertiary) : AnyShapeStyle(HierarchicalShapeStyle.secondary))
            }
            .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
            // Attribution coverage: sessions that carry this principal's key.
            HStack(spacing: 8) {
                chip("sessions \(p.sessions)", p.sessions > 0 ? .green : .secondary)
            }
            Text(p.principalKey).font(.caption2).monospaced().foregroundStyle(.quaternary)
                .textSelection(.enabled)
        }
        .padding(.vertical, 2)
    }

    private func chip(_ text: String, _ tint: Color) -> some View {
        Text(text)
            .font(.caption2).monospacedDigit()
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(tint.opacity(0.12), in: Capsule())
            .foregroundStyle(tint)
    }
}

// MARK: - Posture (Tier 6 screen)
//
// What granted the authority in the first place: every permission declaration
// in every agent's own config — the file that granted it, quoted verbatim,
// with first-seen dates.

struct PosturePane: View {
    @Bindable var store: Store

    private var empty: Bool {
        store.grants.isEmpty && store.autonomyIntervals.isEmpty
            && store.bulkUploads.isEmpty && store.mcpServers.isEmpty
    }

    var body: some View {
        if empty {
            ContentUnavailableView {
                Label("No Posture Recorded", systemImage: "checkmark.shield")
            } description: {
                Text("The grants sweep, autonomy ledger, upload ledger and MCP census fill as the collectors read each agent's own settings — declarations appear here as they are found.")
            }
        } else {
            Form {
                if !store.grants.isEmpty {
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

                // The posture ribbon (tier 5 #2): autonomy as a timeline.
                if !store.autonomyIntervals.isEmpty {
                    Section {
                        ForEach(Array(store.autonomyIntervals.prefix(30))) { iv in
                            HStack(spacing: 10) {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(iv.denied > 0 ? Color.orange : Color.blue)
                                    .frame(width: 8, height: 8)
                                    .help("\(iv.calls) calls, \(iv.denied) denied, \(iv.errors) errors")
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(iv.autonomy ?? "unknown").font(.callout).fontWeight(.medium)
                                        Text("session \(iv.sessionID.prefix(8))")
                                            .font(.caption2).monospaced().foregroundStyle(.tertiary)
                                    }
                                    Text("\(iv.calls) call\(iv.calls == 1 ? "" : "s") · \(iv.denied) denied · \(iv.errors) error\(iv.errors == 1 ? "" : "s") · \(Fmt.clock(iv.startedAt))–\(Fmt.clock(iv.endedAt))")
                                        .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                                }
                                Spacer()
                                Text(iv.modeRaw ?? "mode unknown")
                                    .font(.caption2).monospaced().foregroundStyle(.quaternary)
                                    .help("The vendor's raw mode string, verbatim")
                            }
                        }
                    } header: {
                        Text("Autonomy Timeline (newest first)")
                    } footer: {
                        Text("Posture as a timeline, not a session column — each interval is the autonomy in force for its own stretch. An unlabelled interval is unknown, never 'default'.")
                    }
                }

                // The Bulk Egress card (tier 5 #7): Grok's repo_state uploads.
                if !store.bulkUploads.isEmpty {
                    Section {
                        ForEach(store.bulkUploads) { b in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text(b.repoPath ?? "unknown repo root").font(.callout).lineLimit(1).truncationMode(.middle)
                                    Spacer()
                                    Text(b.sizeBytes.map { Fmt.compact($0) + " B" } ?? "never enqueued")
                                        .font(.callout).monospacedDigit()
                                        .foregroundStyle(b.sizeBytes == nil ? .tertiary : .secondary)
                                        .help(b.sizeBytes == nil
                                              ? "The upload started but no 'enqueued' line followed — its size is unknown, never zero."
                                              : "Compressed tarball size, from the 'enqueued' record.")
                                }
                                Text("turn \(b.turn.map(String.init) ?? "?") · max file \(b.maxFileBytes.map { Fmt.compact($0) + " B" } ?? "unknown") · \(b.blobs.map { "\($0) blob\($0 == 1 ? "" : "s")" } ?? "blob count unknown")\(b.gcsPath.map { " · \($0)" } ?? "")")
                                    .font(.caption2).monospacedDigit().foregroundStyle(.tertiary)
                                // The decision chain, rendered as its precedence ladder.
                                Text("uploads \(b.uploadsEnabled.map { $0 == 1 ? "enabled" : "disabled" } ?? "state unknown") · \(b.uploadReason ?? "no recorded reason") · source \(b.telemetrySource ?? "unknown")")
                                    .font(.caption2).foregroundStyle(b.uploadsEnabled == 1 ? .orange : .secondary)
                            }
                        }
                    } header: {
                        Text("Bulk Egress (repo_state uploads)")
                    } footer: {
                        Text("Each Grok repo_state upload root with its decision chain: env → config → remote, with the deciding input named. Size exists only on uploads that reached 'enqueued' — the count without one is printed, never summed as zero.")
                    }
                }

                // The MCP dimension: configured servers grouped by identity.
                if !store.mcpServers.isEmpty {
                    Section {
                        ForEach(store.mcpServers) { m in
                            HStack(spacing: 10) {
                                Image(systemName: "puzzlepiece.extension").foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(m.serverName).font(.callout)
                                    Text("\(m.mcpIdentity) · \(m.transport ?? "transport unknown")")
                                        .font(.caption2).monospaced().foregroundStyle(.tertiary)
                                }
                                Spacer()
                                Text("\(m.clients) client\(m.clients == 1 ? "" : "s")")
                                    .font(.caption2).monospacedDigit().foregroundStyle(.secondary)
                                if let on = m.enabled {
                                    Image(systemName: on == 1 ? "checkmark.circle.fill" : "xmark.circle")
                                        .foregroundStyle(on == 1 ? .green : .secondary)
                                        .help(on == 1 ? "Enabled in at least one client config" : "Disabled in every config that declares it")
                                } else {
                                    Text("state unknown").font(.caption2).foregroundStyle(.quaternary)
                                }
                            }
                        }
                    } header: {
                        Text("MCP Servers (configured, grouped by identity)")
                    } footer: {
                        Text("Servers from the local config census, grouped by endpoint identity — the same server registered by several clients is one row with a client count. Observed configuration only; calls appear on the Behaviour panel.")
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

    /// The posture-weight ladder (prompt_each < classifier_gated < accept_edits
    /// < full_auto) — one vocabulary, same colours as the bind collector.
    private func autonomyColor(_ a: String?) -> Color {
        switch a {
        case "full_auto": .red
        case "accept_edits": .orange
        case "classifier_gated": .yellow
        case "prompt_each": .green
        default: .secondary
        }
    }
}
