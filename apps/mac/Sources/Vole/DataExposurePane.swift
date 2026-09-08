import SwiftUI

// MARK: - Data Exposure (Tier 4 screen)
//
// The Leak Ledger: what sensitive data reached which sink — fingerprints and
// locations only. The VALUE is never in the store; the viewer re-reads the
// source file at view time (just-in-time evidence), so "no content stored"
// survives a secret scanner living inside the product.

struct SecretSighting: Identifiable {
    let id: Int
    let fingerprint: String
    let detector: String
    let sinkKey: String
    let path: String
    let byteOffset: Int
    let byteLength: Int
    let direction: String
    let status: String
    let firstSeen: Int
    let lastSeen: Int
}

struct ScanStateRow: Identifiable {
    let sinkKey: String
    let bytesScanned: Int
    let bytesUnreadable: Int
    let completed: Bool
    let lastSeenAt: Int?
    var id: String { sinkKey }
}

struct DataExposurePane: View {
    @Bindable var store: Store
    @State private var selected: SecretSighting?

    var body: some View {
        if store.secretSightings.isEmpty {
            ContentUnavailableView {
                Label("No Exposure Recorded", systemImage: "shield.checkered")
            } description: {
                Text(store.scanDenominator > 0
                     ? "The scan engine has read \(store.scanDenominator) bytes of at-rest sinks and found no credential shapes. 'Not seen' is an answer here — the denominator is on the record."
                     : "The DLP scanner has not run yet (10-minute cadence) or found no sinks on this Mac.")
            }
        } else {
            Form {
                Section {
                    let candidates = store.secretSightings.filter { $0.status == "candidate" }
                    let fixtures = store.secretSightings.filter { $0.status == "fixture" }
                    LabeledContent("Sightings") {
                        Text("\(store.secretSightings.count)").font(.title2).fontWeight(.semibold).monospacedDigit()
                    }
                    LabeledContent("Candidates", value: "\(candidates.count)")
                        .foregroundStyle(candidates.count > 0 ? .red : .secondary)
                    LabeledContent("Test fixtures (never page)", value: "\(fixtures.count)")
                } footer: {
                    Text("Fingerprints only — the value never enters the store. Click a row to re-read the evidence in place, just in time.")
                }

                Section("By Detector") {
                    let grouped = Dictionary(grouping: store.secretSightings, by: \.detector)
                        .sorted { $0.value.count > $1.value.count }
                    ForEach(grouped, id: \.key) { det, items in
                        HStack {
                            Image(systemName: "key.horizontal")
                                .foregroundStyle(det.contains("aws") || det.contains("private") || det.contains("anthropic") || det.contains("openai") || det.contains("github") ? .red : .orange)
                            Text(det.replacingOccurrences(of: "-", with: " ").capitalized)
                            Spacer()
                            Text("\(items.count)").monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Sightings") {
                    ForEach(store.secretSightings) { s in
                        sightingRow(s)
                    }
                }

                // The denominator (#137): no exposure figure renders without it.
                Section {
                    ForEach(store.scanStates) { st in
                        HStack {
                            Image(systemName: st.completed ? "checkmark.circle" : "arrow.clockwise.circle")
                                .foregroundStyle(st.completed ? .green : .orange)
                            VStack(alignment: .leading) {
                                Text(st.sinkKey).font(.caption)
                                Text("\(ByteCountFormatter.string(fromByteCount: Int64(st.bytesScanned), countStyle: .file)) scanned\(st.bytesUnreadable > 0 ? " · \(ByteCountFormatter.string(fromByteCount: Int64(st.bytesUnreadable), countStyle: .file)) UNREADABLE" : "")")
                                    .font(.caption2).foregroundStyle(st.bytesUnreadable > 0 ? AnyShapeStyle(Color.orange) : AnyShapeStyle(HierarchicalShapeStyle.tertiary))
                            }
                            Spacer()
                            if let at = st.lastSeenAt { Text(Fmt.rel(at)).font(.caption2).foregroundStyle(.tertiary) }
                        }
                    }
                } header: {
                    Text("Coverage")
                } footer: {
                    Text("Bytes Vole could not read are counted, never hidden — an exposure figure without its denominator is a claim, not a measurement.")
                }
            }
            .formStyle(.grouped)
            .sheet(item: $selected) { s in JustInTimeViewer(sighting: s) }
        }
    }

    @ViewBuilder
    private func sightingRow(_ s: SecretSighting) -> some View {
        HStack(spacing: 10) {
            Image(systemName: s.direction == "at_wire" ? "arrow.up.circle" : "externaldrive")
                .foregroundStyle(s.direction == "at_wire" ? .red : .orange)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.detector.replacingOccurrences(of: "-", with: " ").capitalized)
                    .fontWeight(.medium)
                Text("\(s.path as NSString).lastPathComponent) · offset \(s.byteOffset) · \(s.byteLength)B")
                    .font(.caption2).monospaced().foregroundStyle(.tertiary)
                    .lineLimit(1).truncationMode(.middle)
                Text(s.fingerprint)
                    .font(.caption2).monospaced().foregroundStyle(.quaternary)
            }
            Spacer()
            if s.status == "fixture" {
                Label("fixture", systemImage: "testtube.2").font(.caption2).foregroundStyle(.secondary)
            }
            Text(Fmt.rel(s.lastSeen)).font(.caption2).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .onTapGesture { selected = s }
    }
}

/// #142: the evidence viewer that re-reads the file AT VIEW TIME (tier-4 #25).
/// The store keeps a fingerprint and an offset; the bytes come from disk when a
/// human looks, and are never persisted, cached or exported — the buffer is
/// discarded on deselect. The matched span itself is NEVER rendered: context
/// shows, `[detector]` stands where the value sat. Opening it writes an
/// info-severity incident naming the viewer and the fingerprint — the audit
/// trail is the price of the capability. If the file has aged out (the 30-day
/// vendor cleanup) or was rewritten shorter than the sighting's span, the
/// viewer says exactly that instead of showing stale or wrong evidence.
///
/// ponytail: no pseudonymous mode exists in this app yet to disable the viewer
/// under (tier-4 asks for it); gate `selected` on it when one lands. Read
/// access stays the OS's own permission check — there is no separate grant
/// model to consult.
struct JustInTimeViewer: View {
    let sighting: SecretSighting
    @Environment(\.dismiss) private var dismiss
    @State private var evidence: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "doc.text.magnifyingglass").foregroundStyle(.blue)
                Text(sighting.detector.replacingOccurrences(of: "-", with: " ").capitalized)
                    .font(.title3).fontWeight(.semibold)
                Spacer()
                Button("Done") { dismiss() }
            }
            GroupBox("Location") {
                VStack(alignment: .leading, spacing: 4) {
                    Text(sighting.path).font(.caption).monospaced().textSelection(.enabled)
                    Text("byte offset \(sighting.byteOffset), length \(sighting.byteLength)")
                        .font(.caption2).foregroundStyle(.tertiary)
                    Text("fingerprint \(sighting.fingerprint)").font(.caption2).monospaced().foregroundStyle(.tertiary)
                }
            }
            GroupBox("Evidence (±200 bytes of context, the match redacted — never stored)") {
                if let ev = evidence {
                    ScrollView { Text(ev).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                        .frame(maxHeight: 180)
                } else {
                    Label("The source file is gone — the vendor's 30-day cleanup likely removed it. The fingerprint and location remain as the record of what was seen.",
                          systemImage: "clock.badge.exclamationmark")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(20)
        .frame(width: 520, height: 420)
        .onAppear(perform: open)
        .onDisappear { evidence = nil }   // discard the buffer on deselect
    }

    /// Opening the evidence is an audited event: the info incident first, then
    /// the read.
    private func open() {
        StoreWriter.recordViewerIncident(
            fingerprint: sighting.fingerprint, detector: sighting.detector,
            path: sighting.path, offset: sighting.byteOffset, length: sighting.byteLength)
        read()
    }

    /// Reads the bytes around the sighting — ±200 bytes of context, live from
    /// disk, with the matched span replaced by `[detector]`: this is the one
    /// place a human could see the secret, and the secret is exactly what does
    /// not render. Nil = no evidence to show (file gone or bad span bounds).
    private func read() {
        guard let data = FileManager.default.contents(atPath: sighting.path) else { return }
        evidence = redactedEvidence(data, offset: sighting.byteOffset,
                                    length: sighting.byteLength, detector: sighting.detector)
    }
}

/// The redacted evidence string for a sighting's span: ±200 bytes of context,
/// the matched span itself rendered as `[detector]` — never the bytes. A span
/// that no longer fits the file is the rewritten-file case: say so rather than
/// show the wrong bytes as evidence. Internal (not private) so the CLI
/// harness exercises the exact code the viewer renders.
///
/// ponytail: the span is redacted by offset, not re-verified against the
/// fingerprint — sightings found in normalised views (base64/JSON-unescape;
/// core's one-decode-level limit) carry offsets into that view, not the raw
/// file, so an HMAC re-check would false-negative on them. Re-verify when
/// core back-maps offsets to file bytes; until then a same-length rewrite
/// redacts the wrong span.
func redactedEvidence(_ data: Data, offset: Int, length: Int, detector: String) -> String? {
    guard offset >= 0, length >= 0 else { return nil }
    guard offset + length <= data.count else {
        return "(context no longer matches — the file has changed since the sighting)"
    }
    let start = max(0, offset - 200)
    let end = min(data.count, offset + length + 200)
    return String(decoding: data.subdata(in: start..<offset), as: UTF8.self)
        + "[\(detector)]"
        + String(decoding: data.subdata(in: (offset + length)..<end), as: UTF8.self)
}
